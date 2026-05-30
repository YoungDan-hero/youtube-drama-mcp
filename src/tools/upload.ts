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

// ── 🌟 子进程执行分支（真正的后台上传逻辑，完全脱离 MCP 宿主） ────────────────
if (process.argv[2] === "--worker-mode" && process.argv[3]) {
  let payload: any;
  try {
    // 💡 完美修复：先用 Base64 解码，再解析 JSON，彻底免疫操作系统的双引号干扰 Bug
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

    // 💡 完美修复：引入官方 onUploadProgress 监听器，让上传过程变成“可见的百分比”
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
          const progress = Math.round(
            (evt.bytesRead / (evt.totalBytes || 1)) * 100,
          );
          try {
            // 实时冲刷改写本地 JSON 文件，让 check_upload_status 工具能读到动态进度
            writeFileSync(
              resultFile,
              JSON.stringify(
                {
                  ok: false,
                  status: "running",
                  progress: `${progress}%`,
                  message: `Uploading bytes: ${evt.bytesRead}/${evt.totalBytes}`,
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

    // ✅ 真正上传成功：落盘终点站状态
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
    // ❌ 上传中途失败：极力确保将真实的报错写回结果文件，防止 AI 无限死等
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

      // 用精确的时间戳作为结果文件名，防止多任务并发冲突
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

      // 💡 抄人声分离满分作业：在 fork 子进程之前，先创建一个占位的初始状态文件落盘
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

      // 💡 完美修复：把复杂的 Payload 对象整体转为安全的 Base64 字符串，避开命令行双引号地狱
      const base64Payload = Buffer.from(JSON.stringify(workerPayload)).toString(
        "base64",
      );

      const child = fork(currentFilePath, ["--worker-mode", base64Payload], {
        detached: true, // 彻底脱离 MCP 父进程的主控生命周期
        stdio: "ignore", // 忽略标准输入输出，由进程内部自行通过落盘进行文件通信
      });

      child.unref(); // 掐断事件循环中的强引用计数

      // ✅ 100 毫秒内迅速返回，确保 MCP 客户端永远不会发生 Timeout 超时
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
      // 如果文件离奇不存在，说明子进程可能连刚开始的写盘都遭遇了权限错误
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

      // 1. 如果子进程已经安全着陆（成功或失败），直接告诉 AI 最终答案
      if (result.status === "completed" || result.status === "failed") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      }

      // 2. 如果状态是 "running"，引入时间触觉，防止子进程意外死掉导致 AI 傻等
      if (result.status === "running") {
        const fs = await import("node:fs");
        const stats = fs.statSync(resultFile);
        const minutesSinceLastUpdate = (Date.now() - stats.mtimeMs) / 1000 / 60;

        // 如果这个状态文件超过 15 分钟没有任何数据写入（修改时间未变），说明子进程网络彻底锁死或被系统强杀了
        if (minutesSinceLastUpdate > 15) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "failed",
                    error:
                      "The upload background worker has frozen or crashed (no disk activity for 15 minutes).",
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

      // 3. 正常运行中，会原封不动返回带有 {"progress": "45%"} 的动态数据反馈给 AI
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

// ── set_public: 修改视频隐私状态 ──────────────────────────────────────────

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
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
