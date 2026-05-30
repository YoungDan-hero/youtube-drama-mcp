import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { getContentDir } from "../config.js";
import {
  ffmpegExtractAudio,
  ffmpegMuxAudioVideo,
} from "../utils/ffmpeg.js";
import { separateVocals } from "../utils/demucs.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

export function registerSeparateVocals(server: McpServer): void {
  server.tool(
    "separate_vocals",
    "Run Demucs vocal separation on drama episodes",
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

      const processed: string[] = [];
      const failed: { file: string; error: string }[] = [];
      const skipped: string[] = [];

      for (const filePath of files) {
        const name = basename(filePath, extname(filePath));
        const processedPath = join(outputDir, `${name}_processed.mp4`);

        if (existsSync(processedPath)) {
          skipped.push(name);
          continue;
        }

        const tmpDir = join(outputDir, "_tmp", name);
        ensureDir(tmpDir);

        const audioWav = join(tmpDir, "audio.wav");
        try {
          await ffmpegExtractAudio(filePath, audioWav);
        } catch (err: any) {
          failed.push({ file: name, error: `Extract audio: ${err.message}` });
          continue;
        }

        const result = await separateVocals(audioWav, tmpDir);
        if (!result.success) {
          failed.push({ file: name, error: result.error ?? "Demucs failed" });
          continue;
        }

        try {
          await ffmpegMuxAudioVideo(filePath, result.vocalsPath, processedPath);
          processed.push(name);
        } catch (err: any) {
          failed.push({ file: name, error: `Mux: ${err.message}` });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                outputDir,
                processed: processed.length,
                skipped: skipped.length,
                failed: failed.length,
                failedDetails: failed,
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
