import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { getChannel, validateDramaId } from "../config.js";
import { ensureValidToken } from "../youtube/auth.js";
import { checkQuotaAvailable } from "../youtube/quota.js";
import { setPublic as ytSetPublic, verifyChannelId } from "../youtube/client.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Process health: check if a PID is still alive ────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour for upload

// ── upload_video: Fire-and-forget with temp file payload ──────────────────

export function registerUploadVideo(server: McpServer): void {
  server.tool(
    "upload_video",
    "Upload {dramaId}/output/{dramaId}-final.mp4 to YouTube. Starts upload in BACKGROUND — use check_upload_status to poll until complete. Only call AFTER build_video succeeds.",
    {
      dramaId: z
        .string()
        .describe("Drama ID (same as used in download/separate/build)"),
      channelKey: z.string().describe("Channel key from channels.yaml"),
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

      const ch = getChannel(channelKey);

      // Use verifyChannelId from client.ts (single source of truth for channel verification)
      const verification = await verifyChannelId(channelKey);
      if (!verification.ok) {
        throw new Error(
          `Channel ID mismatch: expected ${verification.expectedId}, got ${verification.actualId}`,
        );
      }

      const quotaCheck = checkQuotaAvailable(
        channelKey,
        "upload",
        ch.dailyQuotaLimit,
      );
      if (!quotaCheck.ok) throw new Error(quotaCheck.message);

      // Get OAuth client for worker payload — need client credentials for worker
      const client = await ensureValidToken(ch.tokenFile, ch.clientSecret);
      const clientSecret = await import("node:fs").then(fs =>
        JSON.parse(fs.readFileSync(ch.clientSecret, "utf-8")).web
      );

      // Write initial status file
      writeFileSync(
        resultFile,
        JSON.stringify(
          {
            ok: false,
            status: "running",
            progress: "0%",
            message: "Spawning background upload worker...",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const tagsArray = tags.split(",").map((t) => t.trim());

      // Fork the isolated worker — not this file itself
      const workerPath = join(fileURLToPath(import.meta.url), "..", "upload-worker.js");

      const workerPayload = {
        videoPath,
        resultFile,
        channelKey,
        title,
        description,
        tagsArray,
        privacy,
        ch: { channelId: ch.channelId, clientId: clientSecret.client_id, clientSecret: clientSecret.client_secret },
        tokens: client.credentials,
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

      // Save PID and deadline for health monitoring
      writeFileSync(
        metaFile,
        JSON.stringify({
          pid: child.pid,
          deadline: Date.now() + UPLOAD_TIMEOUT_MS,
          resultFile,
        }),
        "utf-8",
      );

      child.unref();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                message:
                  "Upload task safely spawned into system background. Monitor progress via check_upload_status.",
                resultFile,
                channelKey,
                title,
                privacy,
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
    "Poll YouTube upload progress. Call repeatedly (every 30-60s) until status becomes 'completed'. Also detects timed-out or dead worker processes.",
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

          // Check deadline
          if (meta.deadline && Date.now() > meta.deadline) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ...result,
                      status: "timed_out",
                      message: "Upload worker exceeded 1-hour deadline. The process may still be running but is considered stalled.",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

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
