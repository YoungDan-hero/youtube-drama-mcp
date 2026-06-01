import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { getContentDir, validateDramaId } from "../config.js";
import { ensureDir } from "../utils/files.js";

const execFileAsync = promisify(execFile);

function parseUrls(input: string): string[] {
  if (existsSync(input)) {
    input = readFileSync(input, "utf-8");
  }
  return input
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http"));
}

function safeEncodeUrl(rawUrl: string): string {
  // Try as-is first (already encoded URLs should work)
  try {
    new URL(rawUrl);
    return rawUrl;
  } catch {
    // URL contains unencoded characters (Chinese, spaces, etc.) — encode it
    return encodeURI(rawUrl);
  }
}

export function registerDownloadEpisodes(server: McpServer): void {
  server.tool(
    "download_episodes",
    "Download drama episodes to {dramaId}/raw/. Always use default path — do NOT specify outputDir. Next step after download: call separate_vocals with the same dramaId.",
    {
      urls: z
        .string()
        .describe("URL list (newline-separated) or path to a txt file"),
      dramaId: z.string().describe("Drama ID, e.g. N193"),
    },
    async ({ urls, dramaId }) => {
      validateDramaId(dramaId);

      const targetDir = join(getContentDir(dramaId), "raw");
      ensureDir(targetDir);

      const urlList = parseUrls(urls);
      if (urlList.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No valid URLs found." }],
        };
      }

      const files: string[] = [];
      const skipped: string[] = [];
      const failed: string[] = [];

      for (let i = 0; i < urlList.length; i++) {
        const rawUrl = urlList[i];
        const encodedUrl = safeEncodeUrl(rawUrl);
        let attname: string;

        try {
          const urlObj = new URL(encodedUrl);
          attname = urlObj.searchParams.get("attname") || `episode_${i + 1}.mp4`;
        } catch {
          // Fallback: extract filename from the path portion
          try {
            const pathPart = encodedUrl.split("?")[0];
            attname = decodeURIComponent(basename(pathPart));
          } catch {
            attname = `episode_${i + 1}.mp4`;
          }
        }

        const outPath = join(targetDir, attname);

        if (existsSync(outPath) && statSync(outPath).size > 1_000_000) {
          skipped.push(attname);
          continue;
        }

        try {
          await execFileAsync("curl", [
            "-L",
            "-o", outPath,
            "-f",
            "--max-time", "300",
            encodedUrl,
          ]);
          files.push(attname);
        } catch {
          failed.push(attname);
        }
      }

      const totalSize = files
        .concat(skipped)
        .reduce((sum, f) => {
          try {
            return sum + statSync(join(targetDir, f)).size;
          } catch {
            return sum;
          }
        }, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dramaId,
                outputDir: targetDir,
                downloaded: files.length,
                skipped: skipped.length,
                failed: failed.length,
                totalSizeMb: +(totalSize / 1024 / 1024).toFixed(1),
                files,
                failedFiles: failed,
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
