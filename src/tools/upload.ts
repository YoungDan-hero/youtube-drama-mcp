import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { getChannel } from "../config.js";
import { ensureValidToken } from "../youtube/auth.js";
import { recordQuotaUsage, checkQuotaAvailable } from "../youtube/quota.js";
import { setPublic as ytSetPublic } from "../youtube/client.js";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── 🌟 子进程执行分支（后台真正上传逻辑，免疫双引号与百分比暴走） ───────────
if (process.argv[2] === "--worker-mode" && process.argv[3]) {
  let payload: any;
  try {
    // 1. Base64 安全解码参数
    const decodedJson = Buffer.from(process.argv[3], "base64").toString(
      "utf-8",
    );
    payload = JSON.parse(decodedJson);

    const {
      videoPath,
      resultFile,
      channelKey,
      title,
      description,
      tagsArray,
      privacy,
      ch,
      tokens,
    } = payload;
    const { createReadStream } = await import("node:fs");

    const auth = new google.auth.OAuth2(ch.clientId, ch.clientSecret);
    auth.setCredentials(tokens);

    const youtube = google.youtube({ version: "v3", auth });

    // 2. 带有防爆计算的进度流上传
    const resp = await youtube.videos.insert(
      {
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title, description, tags: tagsArray },
          status: { privacyStatus: privacy },
        },
        media: { body: createReadStream(videoPath) },
      },
      {
        onUploadProgress: (evt) => {
          try {
            let progressStr = "0%";

            // 💡 健壮性修复：只有当总大小明确存在且大于 0 时才计算百分比
            if (evt.totalBytes && evt.totalBytes > 0) {
              const progress = Math.round(
                (evt.bytesRead / evt.totalBytes) * 100,
              );
              progressStr = `${progress}%`;
            } else {
              // 💡 优雅降级：若 totalBytes 为 undefined，则精细化显示已上传的兆字节 (MB)
              progressStr = `${(evt.bytesRead / 1024 / 1024).toFixed(1)} MB transmitted`;
            }

            writeFileSync(
              resultFile,
              JSON.stringify(
                {
                  ok: false,
                  status: "running",
                  progress: progressStr,
                  message: `Uploading bytes: ${evt.bytesRead} / ${evt.totalBytes ?? "Unknown"}`,
                },
                null,
                2,
              ),
              "utf-8",
            );
          } catch (_) {}
        },
      },
    );

    const videoId = resp.data.id!;
    recordQuotaUsage(channelKey, "upload", 1600, videoId);

    // ✅ 上传完美成功
    writeFileSync(
      resultFile,
      JSON.stringify(
        { ok: true, status: "completed", videoId, channelId: ch.channelId },
        null,
        2,
      ),
      "utf-8",
    );
    process.exit(0);
  } catch (err: any) {
    // ❌ 极力捕获异常写回本地
    try {
      const targetFile =
        payload?.resultFile ||
        join(homedir(), ".youtube-drama-mcp", `upload-error-fallback.json`);
      writeFileSync(
        targetFile,
        JSON.stringify(
          { ok: false, status: "failed", error: err.message ?? String(err) },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (_) {}
    process.exit(1);
  }
}

// ── upload_video: 唤醒并脱离 (Fork & Detach) ───────────────────────────

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

      const ch = getChannel(channelKey);
      const client = await ensureValidToken(ch.tokenFile, ch.clientSecret);
      const youtube = google.youtube({ version: "v3", auth: client });

      const verifyResp = await youtube.channels.list({
        part: ["id"],
        mine: true,
      });
      const actualId = verifyResp.data.items?.[0]?.id ?? "";
      if (actualId !== ch.channelId) {
        throw new Error(`Channel ID mismatch: ${ch.channelId} vs ${actualId}`);
      }

      const quotaCheck = checkQuotaAvailable(
        channelKey,
        "upload",
        ch.dailyQuotaLimit,
      );
      if (!quotaCheck.ok) throw new Error(quotaCheck.message);

      // 先落地一个初始状态文件
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
      const currentFilePath = fileURLToPath(import.meta.url);

      const workerPayload = {
        videoPath,
        resultFile,
        channelKey,
        title,
        description,
        tagsArray,
        privacy,
        ch: { channelId: ch.channelId, clientSecret: ch.clientSecret },
        tokens: client.credentials,
      };

      // 对象转为坚固的 Base64 字符串
      const base64Payload = Buffer.from(JSON.stringify(workerPayload)).toString(
        "base64",
      );

      const child = fork(currentFilePath, ["--worker-mode", base64Payload], {
        detached: true,
        stdio: "ignore",
      });

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

// ── check_upload_status: 智能状态与进度追踪工具 ────────────────────────────

export function registerCheckUploadStatus(server: McpServer): void {
  server.tool(
    "check_upload_status",
    "Poll YouTube upload progress. Call repeatedly (every 30-60s) until status becomes 'completed'.",
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

      // 💡 精简逻辑：如果子进程已经明确写回了结果（completed 或 failed），直接给 AI 最终答复
      if (result.status === "completed" || result.status === "failed") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
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
