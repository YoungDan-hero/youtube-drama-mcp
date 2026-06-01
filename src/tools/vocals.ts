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
        const audioDoneFile = join(tmpDir, ".audio_extracted");
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const logFile = join(tmpDir, "background.log");

        // Write a "started" marker so check_vocals_status knows it's running
        const startedFile = join(tmpDir, ".started");
        writeFileSync(startedFile, new Date().toISOString());

        // ── Background shell script ─────────────────────────────────────────
        // Step markers (.audio_extracted, .demucs_done) allow diagnosing
        // which step failed. Demucs output dir is discovered dynamically
        // instead of hardcoding "htdemucs/audio".
        const shell = [
          `set -e`,
          `echo "[bg] Starting pipeline for ${shellEscape(name)}..." > ${shellEscape(logFile)} 2>&1`,

          // Step 1: Extract audio
          `echo "[bg] Step 1/3: Extracting audio..." >> ${shellEscape(logFile)} 2>&1`,
          `ffmpeg -y -i ${shellEscape(filePath)} -vn -acodec pcm_s16le -ar 44100 -ac 2 ${shellEscape(audioWav)} >> ${shellEscape(logFile)} 2>&1`,
          `touch ${shellEscape(audioDoneFile)}`,
          `echo "[bg] Step 1/3: Audio extracted." >> ${shellEscape(logFile)} 2>&1`,

          // Step 2: Demucs vocal separation
          `echo "[bg] Step 2/3: Running Demucs..." >> ${shellEscape(logFile)} 2>&1`,
          `demucs --two-stems=vocals -o ${shellEscape(tmpDir)} ${shellEscape(audioWav)} >> ${shellEscape(logFile)} 2>&1`,
          `touch ${shellEscape(demucsDoneFile)}`,
          `echo "[bg] Step 2/3: Demucs done." >> ${shellEscape(logFile)} 2>&1`,

          // Step 3: Mux vocals back into video
          // Dynamically find the vocals.wav: demucs creates <outputDir>/<model>/<stemname>/vocals.wav
          // where <stemname> is the audio filename without extension
          `echo "[bg] Step 3/3: Muxing..." >> ${shellEscape(logFile)} 2>&1`,
          `VOCALS_FILE=$(find ${shellEscape(tmpDir)} -name vocals.wav -print -quit 2>/dev/null)`,
          `if [ -z "$VOCALS_FILE" ]; then`,
          `  echo "[bg] ERROR: vocals.wav not found in demucs output" >> ${shellEscape(logFile)} 2>&1`,
          `  exit 1`,
          `fi`,
          `ffmpeg -y -i ${shellEscape(filePath)} -i "$VOCALS_FILE" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 ${shellEscape(processedPath)} >> ${shellEscape(logFile)} 2>&1`,
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
    "Poll vocal separation progress. Call repeatedly (every 30-60s) until allDone=true. Returns 'completed', 'running', 'pending', 'timed_out', or 'failed' per episode. Only proceed to build_video when allDone=true.",
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
        step?: string;
        processedPath?: string;
      }[] = [];

      for (const filePath of rawFiles) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);
        const tmpDir = join(outputDir, "_tmp", name);
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const audioDoneFile = join(tmpDir, ".audio_extracted");
        const startedFile = join(tmpDir, ".started");

        if (existsSync(processedPath)) {
          results.push({ name, status: "completed", processedPath });
          continue;
        }

        if (existsSync(demucsDoneFile)) {
          // .demucs_done exists but processed file doesn't → mux (step 3) failed
          results.push({ name, status: "failed", step: "mux", processedPath });
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
        let processAlive = false;
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
            processAlive = isPidAlive(pid);
          } catch {
            // Corrupted PID file — can't determine, treat as running
            processAlive = true;
          }
        }

        if (!processAlive) {
          // Process died without completing — determine which step failed
          const step = existsSync(audioDoneFile)
            ? "demucs"
            : "audio_extract";
          results.push({ name, status: "failed", step, processedPath });
          continue;
        }

        // Process still running — report current step
        const step = existsSync(demucsDoneFile)
          ? "mux"
          : existsSync(audioDoneFile)
            ? "demucs"
            : "audio_extract";
        results.push({ name, status: "running", step });
      }

      const allDone = results.every((r) => r.status === "completed");
      const anyRunning = results.some((r) => r.status === "running");
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
                      ? "Some episodes failed. Check the 'step' field and background.log for errors."
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
