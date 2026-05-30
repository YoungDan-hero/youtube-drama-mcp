import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

const execFileAsync = promisify(execFile);

export class DemucsError extends Error {
  constructor(
    message: string,
    public stderr: string
  ) {
    super(message);
    this.name = "DemucsError";
  }
}

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
      { timeout: 300_000 }
    );

    const vocalsPath = join(outputDir, "htdemucs", name, "vocals.wav");
    if (!existsSync(vocalsPath)) {
      return { vocalsPath: "", success: false, error: "vocals.wav not found after demucs" };
    }

    return { vocalsPath, success: true };
  } catch (err: any) {
    return {
      vocalsPath: "",
      success: false,
      error: `Demucs failed: ${err.message}`,
    };
  }
}
