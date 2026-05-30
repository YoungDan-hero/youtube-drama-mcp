import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getQuotaDir } from "../config.js";

interface QuotaRecord {
  date: string;
  used: number;
  operations: Array<{
    op: string;
    units: number;
    videoId?: string;
    at: string;
  }>;
}

const QUOTA_COSTS: Record<string, number> = {
  upload: 1600,
  thumbnail: 50,
  set_public: 50,
  search: 100,
  videos_list: 1,
  channels_list: 1,
  analytics_query: 1,
};

export function getQuotaCost(op: string): number {
  return QUOTA_COSTS[op] ?? 1;
}

function todayPacific(): string {
  const now = new Date();
  const pacific = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  return pacific.format(now);
}

function getQuotaPath(channelKey: string): string {
  return join(getQuotaDir(), `${channelKey}.json`);
}

export function loadQuota(channelKey: string): QuotaRecord {
  const path = getQuotaPath(channelKey);
  const today = todayPacific();

  if (existsSync(path)) {
    const record: QuotaRecord = JSON.parse(readFileSync(path, "utf-8"));
    if (record.date === today) return record;
  }

  return { date: today, used: 0, operations: [] };
}

export function saveQuota(channelKey: string, record: QuotaRecord): void {
  const dir = getQuotaDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getQuotaPath(channelKey), JSON.stringify(record, null, 2), "utf-8");
}

export function recordQuotaUsage(
  channelKey: string,
  op: string,
  units: number,
  videoId?: string
): QuotaRecord {
  const record = loadQuota(channelKey);
  record.used += units;
  record.operations.push({
    op,
    units,
    videoId,
    at: new Date().toISOString(),
  });
  saveQuota(channelKey, record);
  return record;
}

export function getRemainingQuota(
  channelKey: string,
  dailyLimit: number
): { used: number; limit: number; remaining: number } {
  const record = loadQuota(channelKey);
  return {
    used: record.used,
    limit: dailyLimit,
    remaining: dailyLimit - record.used,
  };
}

export function checkQuotaAvailable(
  channelKey: string,
  op: string,
  dailyLimit: number
): { ok: boolean; message: string } {
  const cost = getQuotaCost(op);
  const { remaining } = getRemainingQuota(channelKey, dailyLimit);

  if (remaining < cost) {
    return {
      ok: false,
      message: `Quota insufficient: need ${cost}, remaining ${remaining}. Resets at midnight Pacific.`,
    };
  }
  return { ok: true, message: `Quota OK: ${cost} units, ${remaining} remaining.` };
}
