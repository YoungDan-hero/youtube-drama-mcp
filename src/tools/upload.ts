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

// ── 🌟 子进程执行分支（真正的后台上传逻辑） ──────────────────────────────────
if (process.argv[2] === "--worker-mode" && process.argv[3]) {
  let payload: any;
  try {
    payload = JSON.parse(process.argv[3]);
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

    const resp = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, tags: tagsArray },
        status: { privacyStatus: privacy },
      },
      media: { body: createReadStream(videoPath) },
    });

    const videoId = resp.data.id!;
    recordQuotaUsage(channelKey, "upload", 1600, videoId);

    // 💡 成功：写入带 status 的明确 JSON
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
    // 💡 失败：极力确保把错误写回结果文件，打破死循环
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
                { ok: false, error: `Video not found: ${videoPath}.` },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // 💡 保持结果文件名的一致性
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

      // 💡 抄 Demucs 脚本的满分作业：在 fork 之前，先写一个带有 "running" 状态的初始文件落盘！
      writeFileSync(
        resultFile,
        JSON.stringify(
          {
            ok: false,
            status: "running",
            message: "Network transferring to YouTube...",
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

      const child = fork(
        currentFilePath,
        ["--worker-mode", JSON.stringify(workerPayload)],
        {
          detached: true,
          stdio: "ignore",
        },
      );

      child.unref();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                message: "Upload task safe spawned into system background.",
                resultFile,
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

// ── check_upload_status: 智能状态提取 ──────────────────────────────────────────

export function registerCheckUploadStatus(server: McpServer): void {
  server.tool(
    "check_upload_status",
    "Poll YouTube upload progress. Call repeatedly (every 30-60s) until result file appears with status='completed'.",
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
                { status: "pending", message: "Process init..." },
                null,
                2,
              ),
            },
          ],
        };
      }

      // 💡 读取文件中的实时状态
      const result = JSON.parse(readFileSync(resultFile, "utf-8"));

      // 如果子进程还在传输，result.status 会是 "running"
      // 如果传输结束，会变成 "completed" 或者 "failed"
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        ...(result.status === "failed" ? { isError: true } : {}),
      };
    },
  );
}

// ── set_public: 保持原样 ──────────────────────────────────────────────

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
