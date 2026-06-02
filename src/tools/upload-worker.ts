/**
 * upload-worker.ts — Isolated upload worker process
 *
 * This file is the standalone entry point for the background upload worker.
 * It is spawned via `fork()` by upload.ts and must NOT be imported by other modules.
 *
 * Usage: node upload-worker.js <payload-path>
 * The payload file contains JSON with OAuth tokens and is deleted after reading.
 */

import { readFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { google } from "googleapis";
import { recordQuotaUsage } from "../youtube/quota.js";
import { ensureValidToken } from "../youtube/auth.js";
import { checkQuotaAvailable } from "../youtube/quota.js";
import { verifyChannelId } from "../youtube/client.js";

interface WorkerPayload {
  videoPath: string;
  resultFile: string;
  channelKey: string;
  title: string;
  description: string;
  tagsArray: string[];
  privacy: string;
  ch: {
    channelId: string;
    tokenFile: string;
    clientSecret: string;
    dailyQuotaLimit: number;
  };
  startedAt?: string;
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
    } = payload;
    const { createReadStream, writeFileSync: ws } = await import("node:fs");

    // ── Step 1: Verify channel identity ────────────────────────────────
    const verification = await verifyChannelId(channelKey);
    if (!verification.ok) {
      throw new Error(
        `Channel '${channelKey}' ID mismatch: expected ${verification.expectedId}, got ${verification.actualId}`,
      );
    }

    // ── Step 2: Check quota ─────────────────────────────────────────────
    const quotaCheck = checkQuotaAvailable(channelKey, "upload", ch.dailyQuotaLimit);
    if (!quotaCheck.ok) {
      throw new Error(`Channel '${channelKey}': ${quotaCheck.message}`);
    }

    // ── Step 3: Get valid OAuth client ─────────────────────────────────
    const client = await ensureValidToken(ch.tokenFile, ch.clientSecret);

    // Update progress: preparing upload
    ws(
      resultFile,
      JSON.stringify({
        ok: false,
        status: "running",
        progress: "0%",
        message: "Auth verified, starting upload...",
        channelKey,
        startedAt: payload.startedAt,
      }, null, 2),
      "utf-8",
    );

    // Get file size upfront — gaxios onUploadProgress often omits totalBytes
    // for resumable uploads with createReadStream, causing "Unknown" in progress.
    const fileSize = statSync(videoPath).size;

    const youtube = google.youtube({ version: "v3", auth: client });

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
            // Prefer evt.totalBytes if available; fall back to fileSize from statSync
            const totalBytes = evt.totalBytes && evt.totalBytes > 0
              ? evt.totalBytes
              : fileSize;
            const progress = Math.round((evt.bytesRead / totalBytes) * 100);
            const progressStr = `${progress}%`;
            const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
            const readMB = (evt.bytesRead / 1024 / 1024).toFixed(1);

            ws(
              resultFile,
              JSON.stringify(
                {
                  ok: false,
                  status: "running",
                  progress: progressStr,
                  message: `Uploading: ${readMB} / ${totalMB} MB (${progress}%)`,
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

    const completedAt = new Date().toISOString();
    const durationSec = payload.startedAt
      ? +((new Date(completedAt).getTime() - new Date(payload.startedAt).getTime()) / 1000).toFixed(1)
      : undefined;

    ws(
      resultFile,
      JSON.stringify(
        {
          ok: true,
          status: "completed",
          videoId: videoId ?? "unknown",
          channelId: ch.channelId,
          timing: {
            startedAt: payload.startedAt,
            completedAt,
            durationSec,
          },
        },
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
