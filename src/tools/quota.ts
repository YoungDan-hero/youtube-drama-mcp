import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getChannel, loadConfig } from "../config.js";
import { getRemainingQuota, loadQuota } from "../youtube/quota.js";

export function registerGetQuotaStatus(server: McpServer): void {
  server.tool(
    "get_quota_status",
    "Check YouTube API quota status for a channel",
    {
      channelKey: z.string().describe("Channel key"),
    },
    async ({ channelKey }) => {
      const ch = getChannel(channelKey);
      const quota = getRemainingQuota(channelKey, ch.dailyQuotaLimit);
      const record = loadQuota(channelKey);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...quota,
                operations: record.operations,
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
