import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pullAnalytics as ytPullAnalytics } from "../youtube/client.js";

export function registerPullAnalytics(server: McpServer): void {
  server.tool(
    "pull_analytics",
    "Pull YouTube channel analytics for a given date",
    {
      channelKey: z.string().describe("Channel key"),
      date: z
        .string()
        .optional()
        .describe("Date in YYYY-MM-DD format (default: today)"),
    },
    async ({ channelKey, date }) => {
      const result = await ytPullAnalytics(channelKey, date);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
