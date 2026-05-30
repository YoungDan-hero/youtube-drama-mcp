import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { getChannel } from "../config.js";
import { ensureValidToken } from "../youtube/auth.js";
import { recordQuotaUsage, checkQuotaAvailable } from "../youtube/quota.js";
import { setPublic as ytSetPublic } from "../youtube/client.js";

export function registerUploadVideo(server: McpServer): void {
  server.tool(
    "upload_video",
    "Upload a video to YouTube channel (background, returns immediately)",
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

      const done = (data: Record<string, unknown>) => {
        writeFileSync(resultFile, JSON.stringify(data, null, 2), "utf-8");
      };

      try {
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

        // Kick off upload immediately in this event loop tick, don't await
        const tagsArray = tags.split(",").map((t) => t.trim());
        const { createReadStream } = await import("node:fs");

        const uploadPromise = youtube.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: { title, description, tags: tagsArray },
            status: { privacyStatus: privacy as any },
          },
          media: { body: createReadStream(videoPath) },
        });

        uploadPromise
          .then((resp) => {
            const videoId = resp.data.id!;
            recordQuotaUsage(channelKey, "upload", 1600, videoId);
            done({ ok: true, videoId, channelId: ch.channelId });
          })
          .catch((err: any) => {
            done({ ok: false, error: err.message ?? String(err) });
          });

        // Keep a reference to prevent GC while uploading
        (globalThis as any).__bgUpload = uploadPromise;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "uploading", message: "Upload started in background.", resultFile },
                null, 2
              ),
            },
          ],
        };
      } catch (err: any) {
        done({ ok: false, error: err.message ?? String(err) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status: "error", resultFile }, null, 2) }],
          isError: true,
        };
      }
    }
  );
}

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
