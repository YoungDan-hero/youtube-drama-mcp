import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getChannel, validateDramaId, getContentDir } from "../config.js";
import { setPublic as ytSetPublic } from "../youtube/client.js";
import { checkLongUploadsStatus, getVerificationGuide } from "./channel.js";
import { ffprobe } from "../utils/ffmpeg.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// 15 minutes in seconds — YouTube's default max duration for unverified channels
const UNVERIFIED_MAX_DURATION_SEC = 15 * 60;

// ── Process health: check if a PID is still alive ────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// No artificial timeout — upload time is unpredictable (depends on file size & network).
// Health is determined solely by PID alive check + result file status.

// ── upload_video: Fire-and-forget with temp file payload ──────────────────

export function registerUploadVideo(server: McpServer): void {
  server.tool(
    "upload_video",
    "Upload {dramaId}/output/{dramaId}-final.mp4 to YouTube. Supports multi-channel upload — use comma-separated channelKey (e.g. 'video,shorts'). Starts upload(s) in BACKGROUND — use check_upload_status to poll until complete. Only call AFTER build_video succeeds.",
    {
      dramaId: z
        .string()
        .describe("Drama ID (same as used in download/separate/build)"),
      channelKey: z.string().describe("Channel key(s) from channels.yaml. Single key or comma-separated for multi-channel upload (e.g. 'video,shorts')"),
      title: z.string().describe("Video title"),
      description: z.string().describe("Video description"),
      tags: z.string().describe("Comma-separated tags"),
      privacy: z
        .enum(["private", "public", "unlisted"])
        .default("private")
        .describe("Privacy status"),
    },
    async ({ dramaId, channelKey, title, description, tags, privacy }) => {
      validateDramaId(dramaId);

      const videoPath = join(
        homedir(),
        ".youtube-drama-mcp",
        "content",
        dramaId,
        "output",
        `${dramaId}-final.mp4`,
      );

      if (!existsSync(videoPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `Video not found: ${videoPath}. Run build_video first.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // ── 长视频验证检查：视频超过15分钟时，自动检查频道是否已验证 ──────
      try {
        const info = await ffprobe(videoPath);
        const durationSec = Math.round(info.duration);
        const durationMin = Math.round((durationSec / 60) * 10) / 10;

        if (durationSec > UNVERIFIED_MAX_DURATION_SEC) {
          // 视频超过15分钟，需要检查频道验证状态
          const firstChannelKey = channelKey.split(",")[0].trim();
          const verification = await checkLongUploadsStatus(firstChannelKey);

          if (!verification.isVerified) {
            const guide = getVerificationGuide(durationMin);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ok: false,
                      error: "Channel not verified for long uploads.",
                      videoDuration: `${durationMin} minutes`,
                      longUploadsStatus: verification.longUploadsStatus,
                      verificationError: verification.error,
                      guide,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
        }
      } catch (err: unknown) {
        // ffprobe 失败时不阻塞上传，让 YouTube API 自行返回错误
        const msg = err instanceof Error ? err.message : String(err);
        // 仅记录日志，不中断流程
        console.error(`[upload_video] ffprobe check failed (non-fatal): ${msg}`);
      }

      const channelKeys = channelKey.split(",").map((k) => k.trim()).filter(Boolean);

      const uploads: { channelKey: string; resultFile: string; title: string; privacy: string }[] = [];

      for (const ck of channelKeys) {
        const timestamp = Date.now();
        const resultFile = join(
          homedir(),
          ".youtube-drama-mcp",
          `upload-result-${timestamp}.json`,
        );
        const metaFile = join(
          homedir(),
          ".youtube-drama-mcp",
          `upload-meta-${timestamp}.json`,
        );

        const ch = getChannel(ck);

        // Write initial status file immediately — the worker will verify & upload
        const startedAt = new Date().toISOString();
        writeFileSync(
          resultFile,
          JSON.stringify(
            {
              ok: false,
              status: "running",
              progress: "0%",
              message: "Spawning background upload worker...",
              channelKey: ck,
              startedAt,
            },
            null,
            2,
          ),
          "utf-8",
        );

        const tagsArray = tags.split(",").map((t) => t.trim());

        // Fork the isolated worker — not this file itself
        const workerPath = join(fileURLToPath(import.meta.url), "..", "upload-worker.js");

        // Pass all needed config to the worker — it will handle verify + token + upload internally
        const workerPayload = {
          videoPath,
          resultFile,
          channelKey: ck,
          title,
          description,
          tagsArray,
          privacy,
          ch: {
            channelId: ch.channelId,
            tokenFile: ch.tokenFile,
            clientSecret: ch.clientSecret,
            dailyQuotaLimit: ch.dailyQuotaLimit,
          },
          startedAt,
        };

        // Write payload to temp file with restricted permissions (0600)
        const payloadPath = join(
          homedir(),
          ".youtube-drama-mcp",
          `upload-payload-${timestamp}.json`,
        );
        writeFileSync(payloadPath, JSON.stringify(workerPayload), { mode: 0o600 });

        const child = fork(workerPath, [payloadPath], {
          detached: true,
          stdio: "ignore",
        });

        // Save PID for health monitoring (no deadline — let it run as long as needed)
        writeFileSync(
          metaFile,
          JSON.stringify({
            pid: child.pid,
            resultFile,
          }),
          "utf-8",
        );

        child.unref();

        uploads.push({ channelKey: ck, resultFile, title, privacy });
      }

      const isBatch = uploads.length > 1;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                message: isBatch
                  ? `${uploads.length} uploads spawned into background. Use check_upload_status for each resultFile.`
                  : "Upload task safely spawned into system background. Monitor progress via check_upload_status.",
                uploads,
                ...(isBatch ? {} : { resultFile: uploads[0].resultFile, channelKey: uploads[0].channelKey }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

// ── check_upload_status: 状态与进度追踪 + 进程健康检查 ───────────────────────

export function registerCheckUploadStatus(server: McpServer): void {
  server.tool(
    "check_upload_status",
    "Poll YouTube upload progress. Call repeatedly (every 30-60s) until status becomes 'completed'. Also detects dead worker processes.",
    {
      resultFile: z
        .string()
        .describe("Result file path returned by upload_video"),
    },
    async ({ resultFile }) => {
      if (!existsSync(resultFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "failed",
                  error: "Local state tracking file went missing.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const result = JSON.parse(readFileSync(resultFile, "utf-8"));

      // If already completed or failed, return immediately
      if (result.status === "completed" || result.status === "failed") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      }

      // Still running — check process health via meta file
      const metaFile = resultFile.replace("upload-result-", "upload-meta-");
      if (existsSync(metaFile)) {
        try {
          const meta = JSON.parse(readFileSync(metaFile, "utf-8"));

          // Check if worker process is still alive
          if (meta.pid && !isPidAlive(meta.pid)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ...result,
                      status: "failed",
                      error: "Upload worker process died unexpectedly. Check disk space and network connectivity.",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
        } catch {
          // Corrupted meta file — can't determine health, just return current result
        }
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

// ── set_public: 修改视频隐私状态

export function registerSetPublic(server: McpServer): void {
  server.tool(
    "set_public",
    "Change a YouTube video from private to public",
    {
      videoId: z.string().describe("YouTube video ID"),
      channelKey: z.string().describe("Channel key"),
    },
    async ({ videoId, channelKey }) => {
      const result = await ytSetPublic(channelKey, videoId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
