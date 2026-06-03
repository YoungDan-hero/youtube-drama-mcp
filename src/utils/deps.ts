/**
 * Dependency checker & auto-installer for ffmpeg and demucs.
 *
 * Cross-platform: macOS + Windows + Linux
 *
 * - ffmpeg: expects it in PATH (brew / choco / apt)
 * - demucs: persistent venv at ~/.youtube-drama-mcp/deps/venv/
 *   (NOT in /tmp — survives reboots and temp-dir cleanup)
 *
 * Usage:
 *   checkDeps()   → read-only status report
 *   ensureDeps()  → auto-install if missing, throw on failure
 *   getDemucsBin() → absolute path to demucs binary for pipeline scripts
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// ── Platform detection ──────────────────────────────────────────────────────────

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

// On Windows venv uses Scripts/ instead of bin/
const VENV_BIN_DIR = IS_WIN ? "Scripts" : "bin";
// Windows executables need .exe suffix
const EXE_SUFFIX = IS_WIN ? ".exe" : "";

// ── Paths ───────────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".youtube-drama-mcp");
export const DEPS_DIR = join(DATA_DIR, "deps");
export const VENV_DIR = join(DEPS_DIR, "venv");
const VENV_BIN = join(VENV_DIR, VENV_BIN_DIR);
export const DEMUCS_BIN = join(VENV_BIN, `demucs${EXE_SUFFIX}`);
const DEMUCS_PIP = join(VENV_BIN, `pip${EXE_SUFFIX}`);
const DEMUCS_PYTHON = join(VENV_BIN, `python${EXE_SUFFIX}`);

// Marker file: when this exists, venv setup is complete and verified
const SETUP_DONE_MARKER = join(DEPS_DIR, ".setup_done");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DepCheckResult {
  ffmpeg: { available: boolean; path?: string; version?: string };
  demucs: { available: boolean; path?: string; version?: string; venvExists: boolean };
  needsInstall: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  // On Windows, wrap in cmd /c for built-in commands like `where`
  const finalCmd = IS_WIN && cmd === "where" ? "cmd" : cmd;
  const finalArgs = IS_WIN && cmd === "where" ? ["/c", "where", ...args] : args;

  return new Promise((resolve) => {
    execFile(finalCmd, finalArgs, { timeout: timeoutMs, shell: IS_WIN }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? 1 : 0 });
    });
  });
}

/** Cross-platform `which` / `where` — returns the first match or null. */
async function findInPath(binary: string): Promise<string | null> {
  const cmd = IS_WIN ? "where" : "which";
  const { code, stdout } = await run(cmd, [binary]);
  if (code !== 0) return null;
  return stdout.trim().split(/\r?\n/)[0] || null;
}

/** Check if a file path is a broken symlink. Only meaningful on macOS/Linux. */
function isSymlinkIntact(filePath: string): boolean {
  // existsSync follows symlinks — if the target is gone, it returns false
  // so if lstatSync says it exists but existsSync says no → broken symlink
  try {
    const { lstatSync } = require("node:fs");
    if (lstatSync(filePath).isSymbolicLink()) {
      return existsSync(filePath); // broken symlink → existsSync returns false
    }
  } catch {
    // lstat failed — file doesn't exist at all
  }
  return existsSync(filePath);
}

/** Find a usable Python 3 on the system (NOT the managed one under .workbuddy). */
async function findPython3(): Promise<string | null> {
  // Platform-specific candidate paths
  const candidates: string[] = [];

  if (IS_MAC) {
    // macOS: prefer homebrew (properly signed, no dylib issues)
    candidates.push(
      "/opt/homebrew/bin/python3",
      "/opt/homebrew/bin/python3.12",
      "/opt/homebrew/bin/python3.11",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    );
  } else if (IS_WIN) {
    // Windows: check common install locations
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    candidates.push(
      join(localAppData, "Programs", "Python", "Python312", "python.exe"),
      join(localAppData, "Programs", "Python", "Python311", "python.exe"),
      join(localAppData, "Programs", "Python", "Python310", "python.exe"),
      join(localAppData, "Programs", "Python", "Python39", "python.exe"),
    );
    // Also try PATH resolution
    const pathResult = await findInPath("python");
    if (pathResult) candidates.push(pathResult);
  } else {
    // Linux
    candidates.push(
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    );
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      const { code, stdout } = await run(p, ["--version"]);
      if (code === 0 && /3\.(9|1[0-9])/.test(stdout)) return p;
    }
  }

  // Last resort: just try `python3` / `python` in PATH
  for (const name of IS_WIN ? ["python"] : ["python3", "python"]) {
    const { code, stdout } = await run(name, ["--version"]);
    if (code === 0 && /3\.(9|1[0-9])/.test(stdout)) return name;
  }

  return null;
}

/** Return platform-specific install hints. */
function getInstallHints(dep: "ffmpeg" | "python" | "demucs"): string {
  if (dep === "ffmpeg") {
    if (IS_WIN) return "Install with:  choco install ffmpeg\nOr download from:  https://ffmpeg.org/download.html";
    if (IS_MAC) return "Install with:  brew install ffmpeg\nOr download from:  https://ffmpeg.org/download.html";
    return "Install with:  sudo apt install ffmpeg  (or your distro's package manager)\nOr download from:  https://ffmpeg.org/download.html";
  }
  if (dep === "python") {
    if (IS_WIN) return "Download from:  https://www.python.org/downloads/\nOr install with:  winget install Python.Python.3.12";
    if (IS_MAC) return "Install with:  brew install python@3.12\nOr download from:  https://www.python.org/downloads/";
    return "Install with:  sudo apt install python3 python3-venv  (or your distro's package manager)";
  }
  // demucs hint is handled by the auto-installer
  return "";
}

// ── Public API ──────────────────────────────────────────────────────────────────

/** Read-only check — does NOT install anything. */
export async function checkDeps(): Promise<DepCheckResult> {
  const result: DepCheckResult = {
    ffmpeg: { available: false },
    demucs: { available: false, venvExists: existsSync(VENV_DIR) },
    needsInstall: [],
  };

  // ── ffmpeg ──
  try {
    const { stdout, code } = await run("ffmpeg", ["-version"]);
    if (code === 0) {
      result.ffmpeg.available = true;
      const m = stdout.match(/ffmpeg version (\S+)/);
      result.ffmpeg.version = m?.[1];
      result.ffmpeg.path = (await findInPath("ffmpeg")) || undefined;
    }
  } catch { /* not found */ }

  if (!result.ffmpeg.available) result.needsInstall.push("ffmpeg");

  // ── demucs ──
  // Check 1: venv binary (most reliable — we control it)
  if (existsSync(DEMUCS_BIN)) {
    const { code } = await run(DEMUCS_BIN, ["--help"]);
    if (code === 0) {
      result.demucs.available = true;
      result.demucs.path = DEMUCS_BIN;
    }
  }

  // Check 2: global PATH (e.g. /usr/local/bin/demucs)
  if (!result.demucs.available) {
    try {
      const { code } = await run("demucs", ["--help"]);
      if (code === 0) {
        const globalPath = await findInPath("demucs");
        if (globalPath) {
          // Verify it's not a broken symlink (the very bug we're fixing on macOS)
          if (!isSymlinkIntact(globalPath)) {
            // Broken symlink — just skip, we'll install our own
          } else {
            result.demucs.available = true;
            result.demucs.path = globalPath;
          }
        }
      }
    } catch { /* not found */ }
  }

  if (!result.demucs.available) result.needsInstall.push("demucs");

  return result;
}

/** Auto-install missing deps. Throws on failure. */
export async function ensureDeps(): Promise<void> {
  const status = await checkDeps();

  if (status.ffmpeg.available && status.demucs.available) return;

  if (!status.ffmpeg.available) {
    throw new Error("ffmpeg not found in PATH.\n" + getInstallHints("ffmpeg"));
  }

  if (!status.demucs.available) {
    await installDemucs();
  }
}

/** Install demucs into the persistent venv. */
async function installDemucs(): Promise<void> {
  const python3 = await findPython3();
  if (!python3) {
    throw new Error(
      "Python 3.9+ not found. Demucs requires Python 3.9–3.12 (3.13 has known torchaudio issues).\n" +
      getInstallHints("python")
    );
  }

  console.error(`[deps] Creating persistent venv at ${VENV_DIR} ...`);

  // Create venv
  mkdirSync(DEPS_DIR, { recursive: true });
  const venvResult = await run(python3, ["-m", "venv", VENV_DIR], 60_000);
  if (venvResult.code !== 0) {
    throw new Error(`Failed to create venv: ${venvResult.stderr}`);
  }

  // Upgrade pip first
  console.error("[deps] Upgrading pip ...");
  await run(DEMUCS_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"], 120_000);

  // Install demucs + soundfile (soundfile fixes Python 3.13 torchaudio backend crash)
  console.error("[deps] Installing demucs + soundfile (this may take a few minutes) ...");
  const installResult = await run(
    DEMUCS_PIP,
    ["install", "demucs", "soundfile"],
    600_000 // 10 min timeout — torch is ~2GB
  );
  if (installResult.code !== 0) {
    throw new Error(`Failed to install demucs: ${installResult.stderr.slice(-1000)}`);
  }

  if (!existsSync(DEMUCS_BIN)) {
    throw new Error(
      `demucs binary not found after install at ${DEMUCS_BIN}.\n` +
      "The pip install may have failed silently. Check the venv manually."
    );
  }

  // On macOS/Linux, try to symlink to /usr/local/bin for shell use
  if (!IS_WIN) {
    const globalDemucs = "/usr/local/bin/demucs";
    try {
      const { unlinkSync, symlinkSync, readlinkSync } = await import("node:fs");
      if (existsSync(globalDemucs)) {
        try {
          const target = readlinkSync(globalDemucs);
          if (target && !existsSync(target)) {
            unlinkSync(globalDemucs); // remove broken link
          } else {
            unlinkSync(globalDemucs); // replace with our new one
          }
        } catch {
          unlinkSync(globalDemucs); // regular file, remove to replace
        }
      }
      symlinkSync(DEMUCS_BIN, globalDemucs);
      console.error(`[deps] Symlinked ${DEMUCS_BIN} → ${globalDemucs}`);
    } catch {
      // /usr/local/bin may need sudo — that's OK, pipeline uses absolute path
      console.error(
        `[deps] Could not symlink to ${globalDemucs} (may need sudo). ` +
        `Pipeline will use venv path directly: ${DEMUCS_BIN}`
      );
    }
  }

  // Write setup-done marker
  writeFileSync(SETUP_DONE_MARKER, new Date().toISOString());
  console.error("[deps] Demucs installed successfully.");
}

/** Return the absolute path to the demucs binary for use in pipeline scripts. */
export function getDemucsBin(): string {
  if (existsSync(DEMUCS_BIN)) return DEMUCS_BIN;
  // Fallback: let PATH resolve it
  return "demucs";
}

/** Return the absolute path to ffmpeg. Currently always "ffmpeg" (installed to PATH). */
export function getFfmpegBin(): string {
  return "ffmpeg";
}
