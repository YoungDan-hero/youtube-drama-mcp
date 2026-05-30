import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { getContentDir } from "../config.js";
import {
  ffmpegExtractAudio,
} from "../utils/ffmpeg.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

export function registerSeparateVocals(server: McpServer): void {
  server.tool(
    "separate_vocals",
    "Run Demucs vocal separation on drama episodes (background)",
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
          content: [{ type: "text" as const, text: "No video files found in input directory." }],
        };
      }

      const tasks: { name: string; status: string }[] = [];

      for (const filePath of files) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);

        if (existsSync(processedPath)) {
          tasks.push({ name, status: "skipped (already processed)" });
          continue;
        }

        const tmpDir = join(outputDir, "_tmp", name);
        ensureDir(tmpDir);

        const audioWav = join(tmpDir, "audio.wav");
        try {
          await ffmpegExtractAudio(filePath, audioWav);
        } catch (err: any) {
          tasks.push({ name, status: `failed: extract audio - ${err.message}` });
          continue;
        }

        // Spawn demucs + mux as background shell process
        const demucsDoneFile = join(tmpDir, ".demucs_done");
        const shell = `
          set -e
          demucs --two-stems=vocals -o "${tmpDir}" "${audioWav}" 2>&1
          VOCALS="${tmpDir}/htdemucs/${name}/vocals.wav"
          ffmpeg -y -i "${filePath}" -i "$VOCALS" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 "${processedPath}" 2>&1
          touch "${demucsDoneFile}"
        `;

        const child = spawn("bash", ["-c", shell], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        tasks.push({ name, status: `started (background, check ${demucsDoneFile})` });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                outputDir,
                tasks,
                message: "Demucs running in background. Processed files appear when done.",
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
