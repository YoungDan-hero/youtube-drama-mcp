/**
 * @deprecated DEAD CODE — DO NOT USE
 *
 * This module is NOT imported by any file in the project.
 * The actual Demucs integration lives in tools/vocals.ts which uses
 * a bash script approach for fire-and-forget background processing.
 *
 * This file should be deleted when convenient.
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileAsync } from "./process.js";

export class DemucsError extends Error {
  constructor(
    message: string,
    public stderr: string
  ) {
    super(message);
    this.name = "DemucsError";
  }
}

/** @deprecated Not used — see tools/vocals.ts for the active implementation. */
export async function separateVocals(
  inputPath: string,
  outputDir: string
): Promise<{ vocalsPath: string; success: boolean; error?: string }> {
  if (!existsSync(inputPath)) {
    return { vocalsPath: "", success: false, error: `File not found: ${inputPath}` };
  }

  const name = basename(inputPath, ".wav");

  try {
    await execFileAsync(
      "demucs",
      [
        "--two-stems", "vocals",
        "-o", outputDir,
        inputPath,
      ],
    );

    const vocalsPath = join(outputDir, "htdemucs", name, "vocals.wav");
    if (!existsSync(vocalsPath)) {
      return { vocalsPath: "", success: false, error: "vocals.wav not found after demucs" };
    }

    return { vocalsPath, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      vocalsPath: "",
      success: false,
      error: `Demucs failed: ${msg}`,
    };
  }
}
