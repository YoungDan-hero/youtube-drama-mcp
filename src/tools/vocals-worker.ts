/**
 * vocals-worker.ts — Isolated Demucs pipeline worker process
 *
 * This file is the standalone entry point for the background vocals pipeline.
 * It is spawned via `fork()` by vocals.ts and must NOT be imported by other modules.
 *
 * Usage: node vocals-worker.js <payload-path>
 * The payload file contains JSON with pipeline configuration and is deleted after reading.
 */

import { spawn } from "node:child_process";
import {
  writeFileSync,
  readdirSync,
  createWriteStream,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

interface WorkerPayload {
  ffmpegBin: string;
  demucsBin: string;
  filePath: string;
  name: string;
  audioWav: string;
  tmpDir: string;
  processedPath: string;
  audioDoneFile: string;
  demucsDoneFile: string;
  completedFile: string;
  logFile: string;
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.exit(1);
  }

  let payload: WorkerPayload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
    // Delete payload after reading — keeps tmpDir clean
    try {
      unlinkSync(payloadPath);
    } catch {
      /* already gone */
    }
  } catch (err: any) {
    console.error(
      `[vocals-worker] Failed to read payload: ${err.message}`,
    );
    process.exit(1);
  }

  const {
    ffmpegBin,
    demucsBin,
    filePath,
    name,
    audioWav,
    tmpDir,
    processedPath,
    audioDoneFile,
    demucsDoneFile,
    completedFile,
    logFile,
  } = payload;

  const logStream = createWriteStream(logFile, { flags: "a" });
  function log(msg: string) {
    logStream.write(msg + "\n");
  }

  function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.on("data", (d) => log(d.toString()));
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        log(d.toString());
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error("Exit code " + code + ": " + stderr.slice(-500)),
          );
      });
      child.on("error", reject);
    });
  }

  try {
    log(`[bg] Starting pipeline for ${name}...`);

    // Step 1: Extract audio
    log("[bg] Step 1/3: Extracting audio...");
    await run(ffmpegBin, [
      "-y",
      "-i",
      filePath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "44100",
      "-ac",
      "2",
      audioWav,
    ]);
    writeFileSync(audioDoneFile, new Date().toISOString());
    log("[bg] Step 1/3: Audio extracted.");

    // Step 2: Demucs vocal separation
    log("[bg] Step 2/3: Running Demucs...");
    await run(demucsBin, [
      "--two-stems=vocals",
      "-o",
      tmpDir,
      audioWav,
    ]);
    writeFileSync(demucsDoneFile, new Date().toISOString());
    log("[bg] Step 2/3: Demucs done.");

    // Step 3: Find vocals.wav and mux back into video
    // Demucs creates: <tmpDir>/<model>/<audioName>/vocals.wav
    log("[bg] Step 3/3: Muxing...");
    function findVocals(dir: string): string | null {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findVocals(fullPath);
          if (found) return found;
        } else if (entry.name === "vocals.wav") {
          return fullPath;
        }
      }
      return null;
    }
    const found = findVocals(tmpDir);
    if (!found) {
      log("[bg] ERROR: vocals.wav not found in demucs output");
      process.exit(1);
    }

    await run(ffmpegBin, [
      "-y",
      "-i",
      filePath,
      "-i",
      found,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      processedPath,
    ]);

    writeFileSync(completedFile, new Date().toISOString());
    log(`[bg] Complete: ${name}`);
  } catch (err: any) {
    log(`[bg] FATAL: ${err.message}`);
    process.exit(1);
  }
}

main();
