import { google, youtube_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { ensureValidToken } from "./auth.js";
import { getChannel } from "../config.js";
import {
  recordQuotaUsage,
  checkQuotaAvailable,
} from "./quota.js";

export async function getYouTubeClient(channelKey: string): Promise<{
  youtube: youtube_v3.Youtube;
  client: OAuth2Client;
}> {
  const ch = getChannel(channelKey);
  const client = await ensureValidToken(ch.tokenFile, ch.clientSecret);
  const youtube = google.youtube({ version: "v3", auth: client });
  return { youtube, client };
}

export async function verifyChannelId(
  channelKey: string
): Promise<{ ok: boolean; actualId: string; expectedId: string }> {
  const ch = getChannel(channelKey);
  const { youtube } = await getYouTubeClient(channelKey);

  const resp = await youtube.channels.list({
    part: ["id"],
    mine: true,
  });

  const actualId = resp.data.items?.[0]?.id ?? "";
  return {
    ok: actualId === ch.channelId,
    actualId,
    expectedId: ch.channelId,
  };
}

export async function uploadVideo(
  channelKey: string,
  params: {
    filePath: string;
    title: string;
    description: string;
    tags: string;
    privacy: string;
  }
): Promise<{
  videoId: string;
  channelId: string;
  uploadSec: number;
  quotaUsed: number;
}> {
  const ch = getChannel(channelKey);
  const check = checkQuotaAvailable(channelKey, "upload", ch.dailyQuotaLimit);
  if (!check.ok) throw new Error(check.message);

  const verification = await verifyChannelId(channelKey);
  if (!verification.ok) {
    throw new Error(
      `Channel ID mismatch: expected ${verification.expectedId}, got ${verification.actualId}`
    );
  }

  const { youtube } = await getYouTubeClient(channelKey);
  const start = Date.now();

  const fs = await import("node:fs");
  const media = {
    body: fs.createReadStream(params.filePath),
  };

  const resp = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: params.title,
        description: params.description,
        tags: params.tags.split(",").map((t) => t.trim()),
      },
      status: {
        privacyStatus: params.privacy as any,
      },
    },
    media,
  });

  const videoId = resp.data.id!;
  const uploadSec = Math.round((Date.now() - start) / 1000);
  recordQuotaUsage(channelKey, "upload", 1600, videoId);

  return { videoId, channelId: ch.channelId, uploadSec, quotaUsed: 1600 };
}

export async function setThumbnail(
  channelKey: string,
  videoId: string,
  imagePath: string
): Promise<{ status: string; quotaUsed: number }> {
  const ch = getChannel(channelKey);
  const check = checkQuotaAvailable(channelKey, "thumbnail", ch.dailyQuotaLimit);
  if (!check.ok) throw new Error(check.message);

  const { youtube } = await getYouTubeClient(channelKey);

  const fs = await import("node:fs");
  await youtube.thumbnails.set({
    videoId,
    media: { body: fs.createReadStream(imagePath) },
  });

  recordQuotaUsage(channelKey, "thumbnail", 50, videoId);
  return { status: "ok", quotaUsed: 50 };
}

export async function setPublic(
  channelKey: string,
  videoId: string
): Promise<{ status: string; privacy: string; quotaUsed: number }> {
  const ch = getChannel(channelKey);
  const check = checkQuotaAvailable(channelKey, "set_public", ch.dailyQuotaLimit);
  if (!check.ok) throw new Error(check.message);

  const { youtube } = await getYouTubeClient(channelKey);

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: { privacyStatus: "public" },
    },
  });

  recordQuotaUsage(channelKey, "set_public", 50, videoId);
  return { status: "ok", privacy: "public", quotaUsed: 50 };
}

export async function pullAnalytics(
  channelKey: string,
  date?: string
): Promise<{
  channel: any;
  daily: any;
  topVideos: any[];
}> {
  const ch = getChannel(channelKey);
  const { youtube, client } = await getYouTubeClient(channelKey);

  const analytics = google.youtubeAnalytics({ version: "v2", auth: client });

  const targetDate =
    date ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(new Date());

  const channelResp = await youtube.channels.list({
    part: ["id", "statistics", "snippet"],
    mine: true,
  });

  if (!channelResp.data.items?.length) {
    throw new Error("No channel found for this token");
  }

  const channel = channelResp.data.items[0];
  const channelId = channel.id!;

  const dailyResp = await analytics.reports.query({
    ids: `channel==${channelId}`,
    startDate: targetDate,
    endDate: targetDate,
    metrics:
      "views,estimatedRevenue,estimatedAdRevenue,likes,comments,subscribersGained,subscribersLost,averageViewDuration",
    dimensions: "day",
  });

  const videoResp = await analytics.reports.query({
    ids: `channel==${channelId}`,
    startDate: targetDate,
    endDate: targetDate,
    metrics: "views,estimatedRevenue,likes,comments,averageViewDuration",
    dimensions: "video",
    sort: "-views",
    maxResults: 50,
  });

  const topVideos = (videoResp.data.rows ?? []).map((row: any[]) => ({
    videoId: row[0],
    views: row[1],
    revenue: row[2],
    likes: row[3],
    comments: row[4],
    avgDuration: Math.round(row[5] ?? 0),
  }));

  return {
    channel: {
      id: channelId,
      title: channel.snippet?.title,
      statistics: channel.statistics,
    },
    daily: dailyResp.data.rows?.[0] ?? null,
    topVideos,
  };
}
