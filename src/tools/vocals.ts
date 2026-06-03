import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync, readFileSync, createWriteStream } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { getContentDir, validateDramaId } from "../config.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";
import { ensureDeps, getDemucsBin, getFfmpegBin, checkDeps } from "../utils/deps.js";

// ── Process health: check if a PID is still alive ────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

// ── Concurrency Manager ──────────────────────────────────────────────────────
// Prevents launching too many Demucs processes simultaneously.
// Default maxConcurrency = 2 (2 simultaneous demucs processes).

interface PipelineOpts {
  filePath: string;
  name: string;
  audioWav: string;
  tmpDir: string;
  processedPath: string;
  audioDoneFile: string;
  demucsDoneFile: string;
  completedFile: string;
  startedFile: string;
  pidFile: string;
  logFile: string;
}

interface QueuedJob {
  opts: PipelineOpts;
}

const pendingQueue: QueuedJob[] = [];
const runningJobs = new Map<string, { pidFile: string; processedPath: string }>();
let maxConcurrency = 2;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function isJobDone(name: string): boolean {
  const info = runningJobs.get(name);
  if (!info) return true;
  // Completed if the processed file exists
  if (existsSync(info.processedPath)) return true;
  // Completed if the process is dead (success or failure)
  if (!existsSync(info.pidFile)) return true;
  try {
    const pid = parseInt(readFileSync(info.pidFile, "utf-8").trim(), 10);
    return !isPidAlive(pid);
  } catch {
    return true; // Can't read PID file → treat as done
  }
}

function tickScheduler(): void {
  // Remove completed jobs from running set
  for (const name of runningJobs.keys()) {
    if (isJobDone(name)) {
      runningJobs.delete(name);
    }
  }

  // Start queued jobs up to maxConcurrency
  while (runningJobs.size < maxConcurrency && pendingQueue.length > 0) {
    const job = pendingQueue.shift()!;
    runBackgroundPipeline(job.opts);
    runningJobs.set(job.opts.name, {
      pidFile: job.opts.pidFile,
      processedPath: job.opts.processedPath,
    });
  }

  // If nothing left, stop the scheduler
  if (runningJobs.size === 0 && pendingQueue.length === 0 && schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function startScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(tickScheduler, 10_000); // check every 10s
  // Allow the Node.js process to exit naturally even if the timer is active
  if (schedulerTimer && typeof schedulerTimer === "object" && "unref" in schedulerTimer) {
    (schedulerTimer as ReturnType<typeof setInterval> & { unref(): void }).unref();
  }
}

function enqueueJob(opts: PipelineOpts, startImmediately: boolean): "started" | "queued" {
  if (startImmediately && runningJobs.size < maxConcurrency) {
    runBackgroundPipeline(opts);
    runningJobs.set(opts.name, {
      pidFile: opts.pidFile,
      processedPath: opts.processedPath,
    });
    startScheduler();
    return "started";
  }
  pendingQueue.push({ opts });
  startScheduler();
  return "queued";
}

// ── Cross-platform background processor ───────────────────────────────────────
// Replaces the previous bash shell script with pure Node.js spawn calls.
// Works on macOS, Linux, and Windows without needing bash.

function runBackgroundPipeline(opts: {
  filePath: string;
  name: string;
  audioWav: string;
  tmpDir: string;
  processedPath: string;
  audioDoneFile: string;
  demucsDoneFile: string;
  completedFile: string;
  startedFile: string;
  pidFile: string;
  logFile: string;
}): void {
  const {
    filePath,
    name,
    audioWav,
    tmpDir,
    processedPath,
    audioDoneFile,
    demucsDoneFile,
    completedFile,
    startedFile,
    pidFile,
    logFile,
  } = opts;

  // Resolve absolute paths for ffmpeg and demucs BEFORE spawning the child process
  const ffmpegBin = getFfmpegBin();
  const demucsBin = getDemucsBin();

  // Write a "started" marker so check_vocals_status knows it's running
  writeFileSync(startedFile, new Date().toISOString());

  // Use a detached Node.js child process to run the pipeline
  // This avoids bash dependency and works on Windows
  const pipelineScript = `
const { spawn, execFileSync } = require('child_process');
const { existsSync, writeFileSync, readFileSync, readdirSync, statSync } = require('fs');
const { join, basename } = require('path');
const { createWriteStream } = require('fs');

const logStream = createWriteStream(${JSON.stringify(logFile)}, { flags: 'a' });
function log(msg) {
  logStream.write(msg + '\\n');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (d) => log(d.toString()));
    child.stderr.on('data', (d) => { stderr += d.toString(); log(d.toString()); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Exit code ' + code + ': ' + stderr.slice(-500)));
    });
    child.on('error', reject);
  });
}

async function main() {
  try {
    log('[bg] Starting pipeline for ${name}...');

    // Step 1: Extract audio
    log('[bg] Step 1/3: Extracting audio...');
    await run(${JSON.stringify(ffmpegBin)}, ['-y', '-i', ${JSON.stringify(filePath)}, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', ${JSON.stringify(audioWav)}]);
    writeFileSync(${JSON.stringify(audioDoneFile)}, new Date().toISOString());
    log('[bg] Step 1/3: Audio extracted.');

    // Step 2: Demucs vocal separation
    log('[bg] Step 2/3: Running Demucs...');
    await run(${JSON.stringify(demucsBin)}, ['--two-stems=vocals', '-o', ${JSON.stringify(tmpDir)}, ${JSON.stringify(audioWav)}]);
    writeFileSync(${JSON.stringify(demucsDoneFile)}, new Date().toISOString());
    log('[bg] Step 2/3: Demucs done.');

    // Step 3: Find vocals.wav and mux back into video
    // Demucs creates: <tmpDir>/<model>/<audioName>/vocals.wav
    log('[bg] Step 3/3: Muxing...');
    let vocalsFile = '';
    const audioName = basename(${JSON.stringify(audioWav)}, '.wav');
    function findVocals(dir) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findVocals(fullPath);
          if (found) return found;
        } else if (entry.name === 'vocals.wav') {
          return fullPath;
        }
      }
      return null;
    }
    const found = findVocals(${JSON.stringify(tmpDir)});
    if (!found) {
      log('[bg] ERROR: vocals.wav not found in demucs output');
      process.exit(1);
    }
    vocalsFile = found;

    await run(${JSON.stringify(ffmpegBin)}, ['-y', '-i', ${JSON.stringify(filePath)}, '-i', vocalsFile, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-map', '0:v:0', '-map', '1:a:0', ${JSON.stringify(processedPath)}]);

    writeFileSync(${JSON.stringify(completedFile)}, new Date().toISOString());
    log('[bg] Complete: ${name}');
  } catch (err) {
    log('[bg] FATAL: ' + err.message);
    process.exit(1);
  }
}

main();
`;

  // Spawn a detached Node.js process running the pipeline script
  // Inherit PATH so the child can find ffmpeg, demucs, etc.
  const child = spawn(process.execPath, ["-e", pipelineScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });

  // Save PID for health monitoring (no deadline — let it run as long as needed)
  if (child.pid) {
    writeFileSync(pidFile, String(child.pid));
  }

  child.unref();
}

// ── separate_vocals: Fire-and-forget (truly immediate) ──────────────────────

// No artificial timeout — processing time is unpredictable.
// Health is determined solely by PID alive check + completion markers.

export function registerSeparateVocals(server: McpServer): void {
  server.tool(
    "separate_vocals",
    "Start Demucs vocal separation in the BACKGROUND, reading from {dramaId}/raw/. Returns immediately — you MUST immediately call check_vocals_status and keep polling every 30s until allDone=true. Do NOT ask the user whether to poll — always auto-poll. When allDone=true, immediately call build_video with the same dramaId. The full pipeline is: separate_vocals → (auto-poll check_vocals_status until allDone) → build_video → upload_video. Uses concurrency control (default: 2 simultaneous processes, configurable via maxConcurrency).",
    {
      dramaId: z.string().describe("Drama ID (same as used in download_episodes)"),
      startEp: z.number().default(1).describe("Start episode number"),
      endEp: z.number().default(999).describe("End episode number"),
      maxConcurrency: z.number().default(2).describe("Maximum number of simultaneous Demucs processes (default: 2). Increase on powerful machines, decrease if CPU is overloaded."),
    },
    async ({ dramaId, startEp, endEp, maxConcurrency: mc }) => {
      validateDramaId(dramaId);

      // Ensure ffmpeg and demucs are available before starting any jobs
      await ensureDeps();

      // Update global maxConcurrency if specified
      if (mc && mc >= 1) {
        maxConcurrency = mc;
      }

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
        const startedFile = join(tmpDir, ".started");
        const completedFile = join(tmpDir, ".completed");
        const pidFile = join(tmpDir, ".pid");
        const logFile = join(tmpDir, "background.log");

        const jobStatus = enqueueJob(
          {
            filePath,
            name,
            audioWav,
            tmpDir,
            processedPath,
            audioDoneFile,
            demucsDoneFile,
            completedFile,
            startedFile,
            pidFile,
            logFile,
          },
          true // start immediately if slot available
        );

        results.push({ name, status: jobStatus, processedPath });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                outputDir,
                maxConcurrency,
                runningCount: runningJobs.size,
                queuedCount: pendingQueue.length,
                message: `Background processing started. ${runningJobs.size} running, ${pendingQueue.length} queued. Use check_vocals_status to monitor.`,
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
    "Poll vocal separation progress. You MUST call this repeatedly every 30s after separate_vocals until allDone=true — NEVER stop polling to ask the user. Returns 'completed', 'running', 'pending', or 'failed' per episode. Only proceed to build_video when allDone=true. Also triggers the concurrency scheduler to start queued jobs when slots become available.",
    {
      dramaId: z.string().describe("Drama ID"),
    },
    async ({ dramaId }) => {
      validateDramaId(dramaId);

      // Trigger scheduler to start queued jobs when slots are free
      tickScheduler();

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
        step?: string;
        processedPath?: string;
        timing?: { startedAt?: string; completedAt?: string; durationSec?: number };
      }[] = [];

      for (const filePath of rawFiles) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);
        const tmpDir = join(outputDir, "_tmp", name);
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const audioDoneFile = join(tmpDir, ".audio_extracted");
        const startedFile = join(tmpDir, ".started");
        const completedFile = join(tmpDir, ".completed");

        // Helper: read startedAt from .started file and compute duration
        const getTiming = () => {
          let startedAt: string | undefined;
          let durationSec: number | undefined;
          let completedAt: string | undefined;
          try {
            if (existsSync(startedFile)) {
              startedAt = readFileSync(startedFile, "utf-8").trim();
            }
            if (existsSync(completedFile)) {
              completedAt = readFileSync(completedFile, "utf-8").trim();
            }
            if (startedAt && completedAt) {
              durationSec = +((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000).toFixed(1);
            }
          } catch { /* ignore read errors */ }
          return startedAt || completedAt ? { startedAt, completedAt, durationSec } : undefined;
        };

        if (existsSync(processedPath)) {
          results.push({ name, status: "completed", processedPath, timing: getTiming() });
          continue;
        }

        if (existsSync(demucsDoneFile)) {
          // .demucs_done exists but processed file doesn't → mux (step 3) failed
          results.push({ name, status: "failed", step: "mux", processedPath, timing: getTiming() });
          continue;
        }

        if (!existsSync(startedFile)) {
          results.push({ name, status: "pending" });
          continue;
        }

        // .started exists — check if process is still alive
        const pidFile = join(tmpDir, ".pid");

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
          results.push({ name, status: "failed", step, processedPath, timing: getTiming() });
          continue;
        }

        // Process still running — report current step and elapsed time
        const step = existsSync(demucsDoneFile)
          ? "mux"
          : existsSync(audioDoneFile)
            ? "demucs"
            : "audio_extract";
        const runningTiming = (() => {
          try {
            if (existsSync(startedFile)) {
              const startedAt = readFileSync(startedFile, "utf-8").trim();
              const elapsedSec = +((Date.now() - new Date(startedAt).getTime()) / 1000).toFixed(1);
              return { startedAt, elapsedSec };
            }
          } catch { /* ignore */ }
          return undefined;
        })();
        results.push({ name, status: "running", step, timing: runningTiming });
      }

      const allDone = results.every((r) => r.status === "completed");
      const anyRunning = results.some((r) => r.status === "running");
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
                anyFailed,
                summary: allDone
                  ? "All episodes completed!"
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

// ── check_deps: Verify ffmpeg and demucs availability ─────────────────────────

export function registerCheckDeps(server: McpServer): void {
  server.tool(
    "check_deps",
    "Check if ffmpeg and demucs are installed. Returns availability status, paths, and versions. If demucs is missing, run separate_vocals to auto-install it, or install manually.",
    {},
    async () => {
      const status = await checkDeps();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );
}
