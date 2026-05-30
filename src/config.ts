import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";

export interface ChannelConfig {
  channelId: string;
  tokenFile: string;
  clientSecret: string;
  dailyQuotaLimit: number;
}

export interface AppConfig {
  dataDir: string;
  channels: Record<string, ChannelConfig>;
}

const DATA_DIR = join(homedir(), ".youtube-drama-mcp");
const CONFIG_PATH = join(DATA_DIR, "channels.yaml");

let cached: AppConfig | null = null;

export function getDataDir(): string {
  return DATA_DIR;
}

export function getContentDir(dramaId: string): string {
  return join(DATA_DIR, "content", dramaId);
}

export function getQuotaDir(): string {
  return join(DATA_DIR, "quota");
}

export function loadConfig(): AppConfig {
  if (cached) return cached;

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parse(raw) as { channels: Record<string, any> };

  const channels: Record<string, ChannelConfig> = {};
  for (const [key, ch] of Object.entries(parsed.channels)) {
    channels[key] = {
      channelId: ch.channel_id,
      tokenFile: ch.token_file.replace(/^~(?=\/)/, homedir()),
      clientSecret: ch.client_secret.replace(/^~(?=\/)/, homedir()),
      dailyQuotaLimit: ch.daily_quota_limit ?? 10000,
    };
  }

  cached = { dataDir: DATA_DIR, channels };
  return cached;
}

export function getChannel(key: string): ChannelConfig {
  const config = loadConfig();
  const ch = config.channels[key];
  if (!ch) {
    const available = Object.keys(config.channels).join(", ");
    throw new Error(`Unknown channel: ${key}. Available: ${available}`);
  }
  return ch;
}
