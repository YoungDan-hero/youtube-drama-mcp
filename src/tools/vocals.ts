import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { getContentDir } from "../config.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

// ── separate_vocals: Fire-and-forget (truly immediate) ──────────────────────

export function registerSeparateVocals(server: McpServer): void {
  server.tool(
    "separate_vocals",
    "Start Demucs vocal separation in the BACKGROUND, then return immediately. Use check_vocals_status to poll.",
    {
      dramaId: z.string().describe("Drama ID"),
      inputDir: z.string().describe("Directory containing raw episode MP4s"),
      startEp: z.number().default(1).describe("Start episode number"),
      endEp: z.number().default(999).describe("End episode number"),
    },
    async ({ dramaId, inputDir, startEp, endEp }) => {
      const outputDir = join(getContentDir(dramaId), "processed");
      ensureDir(outputDir);

      const allFiles = listVideoFiles(inputDir);
      const files = allFiles.slice(startEp - 1, endEp);

      if (files.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No video files found." }],
        };
      }

      const results: { name: string; status: string; processedPath?: string }[] = [];

      for (const filePath of files) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);

        if (existsSync(processedPath)) {
          results.push({ name, status: "skipped", processedPath });
          continue;
        }

        const tmpDir = join(outputDir, "_tmp", name);
        ensureDir(tmpDir);
        const audioWav = join(tmpDir, "audio.wav");
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const vocalsDir = join(tmpDir, "htdemucs", "audio");
        const logFile = join(tmpDir, "background.log");

        // Write a "started" marker so check_vocals_status knows it's running
        const startedFile = join(tmpDir, ".started");
        writeFileSync(startedFile, new Date().toISOString());

        // ── ALL heavy work (ffmpeg extract + demucs + mux) goes into background ──
        const shell = [
          `set -e`,
          `echo "[bg] Starting pipeline for ${name}..." > "${logFile}" 2>&1`,
          // Step 1: Extract audio (previously awaited — now in background)
          `echo "[bg] Extracting audio..." >> "${logFile}" 2>&1`,
          `ffmpeg -y -i "${filePath}" -vn -acodec pcm_s16le -ar 44100 -ac 2 "${audioWav}" >> "${logFile}" 2>&1`,
          `echo "[bg] Audio extracted." >> "${logFile}" 2>&1`,
          // Step 2: Demucs vocal separation
          `echo "[bg] Running Demucs..." >> "${logFile}" 2>&1`,
          `demucs --two-stems=vocals -o "${tmpDir}" "${audioWav}" >> "${logFile}" 2>&1`,
          `echo "[bg] Demucs done, muxing..." >> "${logFile}" 2>&1`,
          // Step 3: Mux vocals back into video
          `ffmpeg -y -i "${filePath}" -i "${vocalsDir}/vocals.wav" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 "${processedPath}" >> "${logFile}" 2>&1`,
          `touch "${demucsDoneFile}"`,
          `echo "[bg] Complete: ${name}" >> "${logFile}" 2>&1`,
        ].join("\n");

        spawn("bash", ["-c", shell], { detached: true, stdio: "ignore" }).unref();

        results.push({ name, status: "started", processedPath });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                outputDir,
                message: "Background processing started. Use check_vocals_status to monitor.",
                results,
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

// ── check_vocals_status: Poll for completion ─────────────────────────────────

export function registerCheckVocalsStatus(server: McpServer): void {
  server.tool(
    "check_vocals_status",
    "Check the status of background vocal separation tasks. Returns 'running', 'completed', or 'pending' for each episode.",
    {
      dramaId: z.string().describe("Drama ID"),
    },
    async ({ dramaId }) => {
      const outputDir = join(getContentDir(dramaId), "processed");
      const rawDir = join(getContentDir(dramaId), "raw");

      if (!existsSync(rawDir)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ dramaId, error: "Raw directory not found" }, null, 2),
            },
          ],
        };
      }

      const rawFiles = listVideoFiles(rawDir);
      const results: {
        name: string;
        status: "completed" | "running" | "pending" | "failed";
        processedPath?: string;
      }[] = [];

      for (const filePath of rawFiles) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);
        const tmpDir = join(outputDir, "_tmp", name);
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const startedFile = join(tmpDir, ".started");
        const audioWav = join(tmpDir, "audio.wav");

        if (existsSync(processedPath)) {
          results.push({ name, status: "completed", processedPath });
        } else if (existsSync(demucsDoneFile)) {
          // .demucs_done exists but processed file doesn't → mux may have failed
          results.push({ name, status: "failed", processedPath });
        } else if (existsSync(startedFile)) {
          // Background process was started (includes audio extraction phase)
          results.push({ name, status: "running" });
        } else {
          results.push({ name, status: "pending" });
        }
      }

      const allDone = results.every((r) => r.status === "completed");
      const anyRunning = results.some((r) => r.status === "running");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                allDone,
                anyRunning,
                summary: allDone
                  ? "All episodes completed!"
                  : anyRunning
                    ? "Some episodes still processing..."
                    : "No episodes currently running.",
                results,
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
