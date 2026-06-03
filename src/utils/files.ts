import { writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, extname, dirname } from "node:path";

/**
 * Write JSON to a file atomically (write to .tmp → fsync → rename).
 * On crash, at worst a stale .tmp file is left — the original file is never corrupted.
 * Call `cleanupStaleTmp(filePath)` periodically if needed.
 *
 * Windows note: renameSync over an existing target may throw EPERM if the file
 * is open by another process. We retry with unlink-then-rename as a fallback.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = filePath + ".tmp";

  // Write to temp file
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");

  // fsync to ensure data is on disk before rename
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    // fsync failed — rename will still likely work, just less durable
  }

  try {
    renameSync(tmp, filePath);
  } catch (err: any) {
    // Windows: renameSync over existing file may fail with EPERM/EPERM or EACCES.
    // Fallback: remove target first, then rename. Not atomic on Windows, but the
    // .tmp file still holds complete data for manual recovery.
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      if (existsSync(filePath)) unlinkSync(filePath);
      renameSync(tmp, filePath);
    } else {
      throw err;
    }
  }
}

/** Remove stale .tmp files left by crashed atomicWriteJson calls. */
export function cleanupStaleTmp(filePath: string): void {
  const tmp = filePath + ".tmp";
  if (existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* already gone or permission denied */ }
  }
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
