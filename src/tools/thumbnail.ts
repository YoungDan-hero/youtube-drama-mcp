import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setThumbnail as ytSetThumbnail } from "../youtube/client.js";
import { validateImageFile } from "../utils/files.js";

export function registerSetThumbnail(server: McpServer): void {
  server.tool(
    "set_thumbnail",
    "Set a custom thumbnail for a YouTube video",
    {
      videoId: z.string().describe("YouTube video ID"),
      channelKey: z.string().describe("Channel key"),
      imagePath: z.string().describe("Path to thumbnail image (JPG/PNG, <2MB)"),
    },
    async ({ videoId, channelKey, imagePath }) => {
      const validation = validateImageFile(imagePath);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: validation.error }) }],
        };
      }

      const result = await ytSetThumbnail(channelKey, videoId, imagePath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
