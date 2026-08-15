import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(__dirname, "..", "..", "cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const MAX_DURATION_SECONDS = 30 * 60;

export interface TrackInfo {
  id: string;
  title: string;
  duration: number;
  path: string;
}

export async function extractAudio(videoId: string): Promise<TrackInfo> {
  const wavPath = join(CACHE_DIR, `${videoId}.wav`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const meta = await fetchMetadata(url);
  if (meta.duration > MAX_DURATION_SECONDS) {
    throw new Error(`Video too long (${meta.duration}s). Max ${MAX_DURATION_SECONDS}s.`);
  }

  if (existsSync(wavPath) && statSync(wavPath).size > 0) {
    return { id: videoId, title: meta.title, duration: meta.duration, path: wavPath };
  }

  await downloadAndTranscode(url, wavPath);
  return { id: videoId, title: meta.title, duration: meta.duration, path: wavPath };
}

interface YtDlpMeta {
  title: string;
  duration: number;
}

function fetchMetadata(url: string): Promise<YtDlpMeta> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", ["--dump-json", "--no-playlist", url]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp metadata failed: ${err}`));
      try {
        const json = JSON.parse(out);
        resolve({ title: json.title ?? "Untitled", duration: Number(json.duration ?? 0) });
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp output: ${(e as Error).message}`));
      }
    });
  });
}

/**
 * YouTube rate-limits repeated requests with HTTP 403. yt-dlp's own --retries doesn't cover it
 * (it treats 403 as fatal, not transient), so retry the whole download with a backoff.
 * Observed ~50% failure rate on rapid repeats; a few spaced attempts get through reliably.
 */
async function downloadAndTranscode(url: string, outPath: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptDownload(url, outPath);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const is403 = /403|forbidden/i.test(lastErr.message);
      if (!is403 || attempt === MAX_ATTEMPTS) throw lastErr;
      const backoffMs = attempt * 1500;
      console.warn(`[extract] 403 on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr ?? new Error("Download failed");
}

function attemptDownload(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", [
      // Prefer m4a — the opus (251) path 403s more often when piped to stdout.
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "--no-playlist",
      // YouTube rate-limits repeated requests; back off and retry instead of failing outright.
      "--retries",
      "5",
      "--fragment-retries",
      "10",
      "-o",
      "-",
      url,
    ]);

    let ytdlpErr = "";
    ytdlp.stderr.on("data", (d) => (ytdlpErr += d.toString()));
    ytdlp.on("error", reject);

    ffmpeg(ytdlp.stdout)
      .audioFrequency(44100)
      .audioChannels(2)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("error", (e) => {
        // ffmpeg may have written a truncated file before dying — drop it so a retry starts clean.
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* best effort */ }
        reject(new Error(`ffmpeg: ${e.message} | yt-dlp: ${ytdlpErr}`));
      })
      .on("end", () => resolve())
      .save(outPath);
  });
}
