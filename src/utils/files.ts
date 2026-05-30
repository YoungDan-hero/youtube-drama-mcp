import { writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = join(filePath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

export function listVideoFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      return [".mp4", ".mkv", ".avi", ".mov", ".webm"].includes(ext);
    })
    .map((f) => join(dir, f))
    .sort();
}

export function validateImageFile(filePath: string): {
  ok: boolean;
  error?: string;
} {
  if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };

  const ext = extname(filePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png"].includes(ext)) {
    return { ok: false, error: `Invalid format: ${ext}. Use JPG or PNG.` };
  }

  const size = statSync(filePath).size;
  if (size > 2 * 1024 * 1024) {
    return { ok: false, error: `File too large: ${(size / 1024 / 1024).toFixed(1)}MB. Max 2MB.` };
  }

  return { ok: true };
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
