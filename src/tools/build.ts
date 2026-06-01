import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { getContentDir, validateDramaId } from "../config.js";
import {
  ffmpegConcat,
  ffmpegRemux,
  ffprobe,
} from "../utils/ffmpeg.js";
import { listVideoFiles, ensureDir } from "../utils/files.js";

export function registerBuildVideo(server: McpServer): void {
  server.tool(
    "build_video",
    "Concatenate processed episodes from {dramaId}/processed/ into a single final video at {dramaId}/output/{dramaId}-final.mp4. Only call AFTER check_vocals_status returns allDone=true. After build, call upload_video with the same dramaId.",
    {
      dramaId: z.string().describe("Drama ID (same as used in download/separate_vocals)"),
      title: z.string().describe("Video title"),
      description: z.string().describe("Video description"),
      tags: z.string().describe("Comma-separated tags"),
      audioMode: z
        .enum(["demucs", "raw"])
        .default("demucs")
        .describe("Use demucs-separated or raw audio"),
      intro: z.string().optional().describe("Intro video path"),
      outro: z.string().optional().describe("Outro video path"),
    },
    async ({ dramaId, audioMode, intro, outro }) => {
      validateDramaId(dramaId);
      const startedAt = new Date();

      const inputDir = join(getContentDir(dramaId), "processed");
      const outputDir = join(getContentDir(dramaId), "output");
      ensureDir(outputDir);

      const allFiles = listVideoFiles(inputDir);
      if (allFiles.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No video files found." }],
        };
      }

      const normalizedDir = join(outputDir, "_normalized");
      ensureDir(normalizedDir);

      const normalizedFiles: string[] = [];

      for (const file of allFiles) {
        const name = basename(file);
        const normPath = join(normalizedDir, name);
        if (!existsSync(normPath)) {
          await ffmpegRemux(file, normPath);
        }
        normalizedFiles.push(normPath);
      }

      const concatList: string[] = [];
      if (intro && existsSync(intro)) concatList.push(intro);
      concatList.push(...normalizedFiles);
      if (outro && existsSync(outro)) concatList.push(outro);

      const listFile = join(outputDir, "concat_list.txt");
      writeFileSync(
        listFile,
        concatList.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
        "utf-8"
      );

      const finalPath = join(outputDir, `${dramaId}-final.mp4`);
      await ffmpegConcat(listFile, finalPath);

      const info = await ffprobe(finalPath);

      let sizeMb = 0;
      try {
        sizeMb = +(statSync(finalPath).size / 1024 / 1024).toFixed(1);
      } catch {}

      const completedAt = new Date();
      const durationSec = +((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                videoPath: finalPath,
                durationSec: Math.round(info.duration),
                sizeMb,
                clipCount: allFiles.length,
                resolution: `${info.width}x${info.height}`,
                timing: {
                  startedAt: startedAt.toISOString(),
                  completedAt: completedAt.toISOString(),
                  elapsedSec: durationSec,
                },
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
