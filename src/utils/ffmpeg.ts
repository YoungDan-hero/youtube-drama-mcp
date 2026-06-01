import { existsSync } from "node:fs";
import { execFileAsync } from "./process.js";

export class FFmpegError extends Error {
  constructor(
    message: string,
    public stderr: string
  ) {
    super(message);
    this.name = "FFmpegError";
  }
}

export async function ffprobe(filePath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  format: string;
}> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find(
      (s: { codec_type?: string }) => s.codec_type === "video"
    );

    return {
      duration: parseFloat(data.format?.duration ?? "0"),
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      format: data.format?.format_name ?? "",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new FFmpegError(`ffprobe failed: ${msg}`, stderr);
  }
}

export async function ffmpegConcat(
  listFile: string,
  outputPath: string
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new FFmpegError(`ffmpeg concat failed: ${msg}`, stderr);
  }
}

/** Remux (recontainer) a video file without re-encoding. Adds faststart for web playback. */
export async function ffmpegRemux(
  inputPath: string,
  outputPath: string
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new FFmpegError(`ffmpeg remux failed: ${msg}`, stderr);
  }
}

export async function ffmpegMuxAudioVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new FFmpegError(`ffmpeg mux failed: ${msg}`, stderr);
  }
}

export async function ffmpegExtractAudio(
  inputPath: string,
  outputPath: string
): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vn",
      "-acodec", "pcm_s16le",
      "-ar", "44100",
      "-ac", "2",
      outputPath,
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new FFmpegError(`ffmpeg extract audio failed: ${msg}`, stderr);
  }
}
