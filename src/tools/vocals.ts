import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { getContentDir } from "../config.js";
import { ffmpegExtractAudio } from "../utils/ffmpeg.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

// ── separate_vocals: Fire-and-forget ─────────────────────────────────────────

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

        // Step 1: Extract audio synchronously (fast, ~seconds)
        try {
          await ffmpegExtractAudio(filePath, audioWav);
        } catch (err: any) {
          results.push({ name, status: `failed: extract - ${err.message}` });
          continue;
        }

        // Step 2: Spawn demucs + mux as background process (minutes to hours)
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const vocalsDir = join(tmpDir, "htdemucs", "audio");

        const shell = [
          `set -e`,
          `echo "[demucs] Starting for ${name}..."`,
          `demucs --two-stems=vocals -o "${tmpDir}" "${audioWav}"`,
          `echo "[demucs] Demucs done, muxing..."`,
          `ffmpeg -y -i "${filePath}" -i "${vocalsDir}/vocals.wav" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 "${processedPath}"`,
          `touch "${demucsDoneFile}"`,
          `echo "[demucs] Complete: ${name}"`,
        ].join("\n");

        spawn("bash", ["-c", shell], { detached: true, stdio: "ignore" }).unref();

        // ✅ Return immediately — do NOT await!
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
        const audioWav = join(tmpDir, "audio.wav");

        if (existsSync(processedPath)) {
          results.push({ name, status: "completed", processedPath });
        } else if (existsSync(demucsDoneFile)) {
          // .demucs_done exists but processed file doesn't → mux may have failed
          results.push({ name, status: "failed", processedPath });
        } else if (existsSync(audioWav)) {
          // Audio extracted but demucs not done yet → running
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
