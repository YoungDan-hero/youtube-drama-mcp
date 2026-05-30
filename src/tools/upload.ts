import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { getChannel } from "../config.js";
import { ensureValidToken } from "../youtube/auth.js";
import { recordQuotaUsage, checkQuotaAvailable } from "../youtube/quota.js";
import { uploadVideo, setPublic as ytSetPublic } from "../youtube/client.js";

// ── upload_video: Fire-and-forget ────────────────────────────────────────────

export function registerUploadVideo(server: McpServer): void {
  server.tool(
    "upload_video",
    "Start YouTube upload in the BACKGROUND, then return immediately. Use check_upload_status to poll.",
    {
      videoPath: z.string().describe("Path to the video file"),
      channelKey: z.string().describe("Channel key from channels.yaml"),
      title: z.string().describe("Video title"),
      description: z.string().describe("Video description"),
      tags: z.string().describe("Comma-separated tags"),
      privacy: z
        .enum(["private", "public", "unlisted"])
        .default("private")
        .describe("Privacy status"),
    },
    async ({ videoPath, channelKey, title, description, tags, privacy }) => {
      const resultFile = join(
        homedir(),
        ".youtube-drama-mcp",
        `upload-result-${Date.now()}.json`
      );

      // Pre-flight: auth, verify, quota (synchronous, fast)
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

      const quotaCheck = checkQuotaAvailable(channelKey, "upload", ch.dailyQuotaLimit);
      if (!quotaCheck.ok) throw new Error(quotaCheck.message);

      const tagsArray = tags.split(",").map((t) => t.trim());
      const { createReadStream } = await import("node:fs");

      // Fire the upload (runs asynchronously via Google API client)
      const uploadPromise = youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title, description, tags: tagsArray },
          status: { privacyStatus: privacy as any },
        },
        media: { body: createReadStream(videoPath) },
      });

      // Write result file when upload completes (success or failure)
      uploadPromise
        .then((resp) => {
          const videoId = resp.data.id!;
          recordQuotaUsage(channelKey, "upload", 1600, videoId);
          writeFileSync(
            resultFile,
            JSON.stringify({ ok: true, videoId, channelId: ch.channelId }, null, 2),
            "utf-8"
          );
        })
        .catch((err: any) => {
          writeFileSync(
            resultFile,
            JSON.stringify({ ok: false, error: err.message ?? String(err) }, null, 2),
            "utf-8"
          );
        });

      // Prevent GC while uploading
      (globalThis as any).__bgUpload = uploadPromise;

      // ✅ Return immediately — result will be written to resultFile when done
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                message: "Upload started in background. Use check_upload_status to monitor.",
                resultFile,
                channelKey,
                title,
                privacy,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ── check_upload_status: Poll for upload completion ──────────────────────────

export function registerCheckUploadStatus(server: McpServer): void {
  server.tool(
    "check_upload_status",
    "Check the status of a background YouTube upload by its result file path. Returns the upload result if completed.",
    {
      resultFile: z.string().describe("Result file path returned by upload_video"),
    },
    async ({ resultFile }) => {
      if (!existsSync(resultFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "uploading", message: "Still uploading..." },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = JSON.parse(readFileSync(resultFile, "utf-8"));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        ...(result.ok ? {} : { isError: true }),
      };
    }
  );
}

// ── set_public: Fast API call, no change needed ──────────────────────────────

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
