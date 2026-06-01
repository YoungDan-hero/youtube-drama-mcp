import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { getContentDir, validateDramaId } from "../config.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

// ── Shell escaping to prevent injection ──────────────────────────────────────

/** Escape a string for safe use inside a POSIX single-quoted shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Process health: check if a PID is still alive ────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

// ── separate_vocals: Fire-and-forget (truly immediate) ──────────────────────

const DEMUCS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per episode

export function registerSeparateVocals(server: McpServer): void {
  server.tool(
    "separate_vocals",
    "Start Demucs vocal separation in the BACKGROUND, reading from {dramaId}/raw/. Returns immediately — use check_vocals_status to poll until allDone=true. After completion, call build_video with the same dramaId.",
    {
      dramaId: z.string().describe("Drama ID (same as used in download_episodes)"),
      startEp: z.number().default(1).describe("Start episode number"),
      endEp: z.number().default(999).describe("End episode number"),
    },
    async ({ dramaId, startEp, endEp }) => {
      validateDramaId(dramaId);

      const inputDir = join(getContentDir(dramaId), "raw");
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
        // All paths are shell-escaped to prevent injection
        const shell = [
          `set -e`,
          `echo "[bg] Starting pipeline for ${shellEscape(name)}..." > ${shellEscape(logFile)} 2>&1`,
          // Step 1: Extract audio
          `echo "[bg] Extracting audio..." >> ${shellEscape(logFile)} 2>&1`,
          `ffmpeg -y -i ${shellEscape(filePath)} -vn -acodec pcm_s16le -ar 44100 -ac 2 ${shellEscape(audioWav)} >> ${shellEscape(logFile)} 2>&1`,
          `echo "[bg] Audio extracted." >> ${shellEscape(logFile)} 2>&1`,
          // Step 2: Demucs vocal separation
          `echo "[bg] Running Demucs..." >> ${shellEscape(logFile)} 2>&1`,
          `demucs --two-stems=vocals -o ${shellEscape(tmpDir)} ${shellEscape(audioWav)} >> ${shellEscape(logFile)} 2>&1`,
          `echo "[bg] Demucs done, muxing..." >> ${shellEscape(logFile)} 2>&1`,
          // Step 3: Mux vocals back into video
          `ffmpeg -y -i ${shellEscape(filePath)} -i ${shellEscape(vocalsDir + "/vocals.wav")} -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 ${shellEscape(processedPath)} >> ${shellEscape(logFile)} 2>&1`,
          `touch ${shellEscape(demucsDoneFile)}`,
          `echo "[bg] Complete: ${shellEscape(name)}" >> ${shellEscape(logFile)} 2>&1`,
        ].join("\n");

        const child = spawn("bash", ["-c", shell], { detached: true, stdio: "ignore" });

        // Save PID and deadline for health monitoring
        const pidFile = join(tmpDir, ".pid");
        const deadlineFile = join(tmpDir, ".deadline");
        if (child.pid) {
          writeFileSync(pidFile, String(child.pid));
        }
        writeFileSync(deadlineFile, String(Date.now() + DEMUCS_TIMEOUT_MS));

        child.unref();

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
    "Poll vocal separation progress. Call repeatedly (every 30-60s) until allDone=true. Returns 'completed', 'running', 'pending', or 'timed_out' per episode. Only proceed to build_video when allDone=true.",
    {
      dramaId: z.string().describe("Drama ID"),
    },
    async ({ dramaId }) => {
      validateDramaId(dramaId);

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
        status: "completed" | "running" | "pending" | "failed" | "timed_out";
        processedPath?: string;
      }[] = [];

      for (const filePath of rawFiles) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);
        const tmpDir = join(outputDir, "_tmp", name);
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const startedFile = join(tmpDir, ".started");

        if (existsSync(processedPath)) {
          results.push({ name, status: "completed", processedPath });
          continue;
        }

        if (existsSync(demucsDoneFile)) {
          // .demucs_done exists but processed file doesn't → mux may have failed
          results.push({ name, status: "failed", processedPath });
          continue;
        }

        if (!existsSync(startedFile)) {
          results.push({ name, status: "pending" });
          continue;
        }

        // .started exists — check process health and timeout
        const pidFile = join(tmpDir, ".pid");
        const deadlineFile = join(tmpDir, ".deadline");

        // Check deadline
        if (existsSync(deadlineFile)) {
          try {
            const deadline = parseInt(readFileSync(deadlineFile, "utf-8").trim(), 10);
            if (Date.now() > deadline) {
              results.push({ name, status: "timed_out", processedPath });
              continue;
            }
          } catch {
            // Corrupted deadline file — treat as still running
          }
        }

        // Check if process is still alive
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
            if (!isPidAlive(pid)) {
              // Process died without completing → failed
              results.push({ name, status: "failed", processedPath });
              continue;
            }
          } catch {
            // Corrupted PID file — can't determine, treat as running
          }
        }

        results.push({ name, status: "running" });
      }

      const allDone = results.every((r) => r.status === "completed");
      const anyRunning = results.some((r) => r.status === "running" || r.status === "timed_out");
      const anyTimedOut = results.some((r) => r.status === "timed_out");
      const anyFailed = results.some((r) => r.status === "failed");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                allDone,
                anyRunning,
                anyTimedOut,
                anyFailed,
                summary: allDone
                  ? "All episodes completed!"
                  : anyTimedOut
                    ? "Some episodes timed out. Check background.log and retry."
                    : anyFailed
                      ? "Some episodes failed. Check background.log for errors."
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
