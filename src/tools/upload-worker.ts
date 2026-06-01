/**
 * upload-worker.ts — Isolated upload worker process
 *
 * This file is the standalone entry point for the background upload worker.
 * It is spawned via `fork()` by upload.ts and must NOT be imported by other modules.
 *
 * Usage: node upload-worker.js <payload-path>
 * The payload file contains JSON with OAuth tokens and is deleted after reading.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { recordQuotaUsage } from "../youtube/quota.js";

interface WorkerPayload {
  videoPath: string;
  resultFile: string;
  channelKey: string;
  title: string;
  description: string;
  tagsArray: string[];
  privacy: string;
  ch: { channelId: string; clientId: string; clientSecret: string };
  tokens: { access_token?: string; refresh_token?: string; expiry_date?: number };
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.exit(1);
  }

  let payload: WorkerPayload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
    // Immediately delete the payload file — it contains OAuth tokens
    try { unlinkSync(payloadPath); } catch { /* payload already gone */ }
  } catch (err: any) {
    // Can't even read payload — write fallback error and exit
    try {
      const fallbackFile = join(homedir(), ".youtube-drama-mcp", "upload-error-fallback.json");
      const { writeFileSync: ws } = await import("node:fs");
      ws(fallbackFile, JSON.stringify(
        { ok: false, status: "failed", error: `Failed to read worker payload: ${err.message}` },
        null, 2,
      ), "utf-8");
    } catch (fallbackErr: any) {
      console.error(`[upload-worker] CRITICAL: Failed to write fallback error: ${fallbackErr.message}`);
    }
    process.exit(1);
  }

  try {
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
    const { createReadStream, writeFileSync: ws } = await import("node:fs");

    const auth = new google.auth.OAuth2(ch.clientId, ch.clientSecret);
    auth.setCredentials(tokens);

    const youtube = google.youtube({ version: "v3", auth });

    // Upload with progress tracking
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

            if (evt.totalBytes && evt.totalBytes > 0) {
              const progress = Math.round(
                (evt.bytesRead / evt.totalBytes) * 100,
              );
              progressStr = `${progress}%`;
            } else {
              progressStr = `${(evt.bytesRead / 1024 / 1024).toFixed(1)} MB transmitted`;
            }

            ws(
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
          } catch (progressErr: any) {
            // Progress write failed — log to stderr but don't crash the upload
            console.error(`[upload-worker] Failed to write progress: ${progressErr.message}`);
          }
        },
      },
    );

    const videoId = resp.data.id;
    if (videoId) {
      recordQuotaUsage(channelKey, "upload", 1600, videoId);
    }

    ws(
      resultFile,
      JSON.stringify(
        { ok: true, status: "completed", videoId: videoId ?? "unknown", channelId: ch.channelId },
        null,
        2,
      ),
      "utf-8",
    );
    process.exit(0);
  } catch (err: any) {
    try {
      const targetFile =
        payload?.resultFile ||
        join(homedir(), ".youtube-drama-mcp", "upload-error-fallback.json");
      const { writeFileSync: ws } = await import("node:fs");
      ws(
        targetFile,
        JSON.stringify(
          { ok: false, status: "failed", error: err.message ?? String(err) },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (writeErr: any) {
      console.error(`[upload-worker] CRITICAL: Failed to write error result: ${writeErr.message}`);
      console.error(`[upload-worker] Original error was: ${err.message ?? String(err)}`);
    }
    process.exit(1);
  }
}

main();
