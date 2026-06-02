import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getYouTubeClient } from "../youtube/client.js";
import { getChannel } from "../config.js";

// ── check_channel_verification: 查询频道是否已验证（可上传长视频） ──────────

export function registerCheckChannelVerification(server: McpServer): void {
  server.tool(
    "check_channel_verification",
    "Check if a YouTube channel is verified for long uploads (>15 min). Returns longUploadsStatus from the YouTube API. Use before uploading videos longer than 15 minutes to avoid upload failures.",
    {
      channelKey: z.string().describe("Channel key from channels.yaml (e.g. 'video')"),
    },
    async ({ channelKey }) => {
      try {
        const ch = getChannel(channelKey);
        const { youtube } = await getYouTubeClient(channelKey);

        const resp = await youtube.channels.list({
          part: ["status"],
          mine: true,
        });

        const channel = resp.data.items?.[0];
        if (!channel) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: "No channel found for this token.",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const longUploadsStatus = channel.status?.longUploadsStatus ?? "longUploadsUnspecified";
        const isVerified = longUploadsStatus === "allowed";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  channelKey,
                  channelId: ch.channelId,
                  longUploadsStatus,
                  isVerified,
                  maxDuration: isVerified ? "12 hours" : "15 minutes",
                  message: isVerified
                    ? "Channel is verified. Can upload videos up to 12 hours / 256 GB."
                    : "Channel is NOT verified. Videos are limited to 15 minutes. Verify at https://www.youtube.com/verify",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `Failed to check channel verification: ${msg}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── Helper: 检查频道验证状态（供 upload_video 内部调用） ──────────────────────

export async function checkLongUploadsStatus(
  channelKey: string,
): Promise<{ isVerified: boolean; longUploadsStatus: string; error?: string }> {
  try {
    const { youtube } = await getYouTubeClient(channelKey);

    const resp = await youtube.channels.list({
      part: ["status"],
      mine: true,
    });

    const channel = resp.data.items?.[0];
    if (!channel) {
      return {
        isVerified: false,
        longUploadsStatus: "unknown",
        error: "No channel found for this token.",
      };
    }

    const longUploadsStatus = channel.status?.longUploadsStatus ?? "longUploadsUnspecified";
    return {
      isVerified: longUploadsStatus === "allowed",
      longUploadsStatus,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isVerified: false,
      longUploadsStatus: "unknown",
      error: msg,
    };
  }
}

// ── 验证指南文案 ────────────────────────────────────────────────────────────

export function getVerificationGuide(durationMin: number): string {
  return [
    `Upload rejected: Video is ${durationMin} minutes long, exceeding the 15-minute limit for unverified channels.`,
    "",
    "To verify your Google account and unlock long uploads:",
    "1. Open https://www.youtube.com/verify in your browser",
    "2. Choose SMS or voice call to receive a verification code",
    "3. Enter the verification code to complete verification",
    "4. After verification, retry the upload",
    "",
    "Verified channels can upload videos up to 12 hours / 256 GB.",
  ].join("\n");
}
