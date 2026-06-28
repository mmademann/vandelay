import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// @ts-ignore — ffmpeg-static has no types
import ffmpegPath from "ffmpeg-static";
import { CACHE_DIR } from "./extract.js";
import { readHistory } from "./history.js";

export const STEMS_DIR = join(CACHE_DIR, "..", "stems");
if (!existsSync(STEMS_DIR)) mkdirSync(STEMS_DIR, { recursive: true });

function getDemucsPath(): string {
  return join(homedir(), ".local", "bin", "demucs");
}

export const STEM_NAMES = ["drums", "bass", "vocals", "other"] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** Returns the directory containing the 4 stem WAVs for a given video id. */
export function stemDir(id: string): string {
  // demucs outputs to <STEMS_DIR>/htdemucs/<id>/
  return join(STEMS_DIR, "htdemucs", id);
}

export function stemPath(id: string, stem: StemName): string {
  return join(stemDir(id), `${stem}.wav`);
}

export function stemMp3Path(id: string, stem: StemName): string {
  return join(stemDir(id), `${stem}.mp3`);
}

export function stemsReady(id: string): boolean {
  return STEM_NAMES.every((s) => existsSync(stemPath(id, s)));
}

export function stemsMp3Ready(id: string): boolean {
  return STEM_NAMES.every((s) => existsSync(stemMp3Path(id, s)));
}

export function transcodeStems(id: string): Promise<void> {
  if (stemsMp3Ready(id)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    // Build ffmpeg args: convert all 4 WAVs to MP3 in one pass using multiple outputs
    const args: string[] = [];
    for (const stem of STEM_NAMES) {
      args.push("-i", stemPath(id, stem));
    }
    STEM_NAMES.forEach((stem, i) => {
      args.push(`-map`, `${i}:a`, "-codec:a", "libmp3lame", "-q:a", "2", stemMp3Path(id, stem));
    });

    const proc = spawn(ffmpegPath as string, args);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code: number) => {
      if (code !== 0) return reject(new Error(`ffmpeg transcode failed (code ${code}): ${stderr.slice(-500)}`));
      resolve();
    });
  });
}

export function cleanupStems(): void {
  const htdemucsDir = join(STEMS_DIR, "htdemucs");
  if (!existsSync(htdemucsDir)) return;

  const knownIds = new Set(readHistory().map((e) => e.id));
  let removed = 0;

  for (const entry of readdirSync(htdemucsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const dir = join(htdemucsDir, id);
    const isPartial = !stemsReady(id);
    const isOrphaned = !knownIds.has(id);

    if (isPartial || isOrphaned) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
        console.log(`[stems] cleaned up ${isPartial ? "partial" : "orphaned"} stem dir: ${id}`);
      } catch (e) {
        console.warn(`[stems] failed to remove ${dir}:`, e);
      }
    }
  }

  if (removed === 0) console.log("[stems] cleanup: nothing to remove");
}

const inFlight = new Map<string, Promise<void>>();

export function separateStems(id: string): Promise<void> {
  if (stemsReady(id)) return Promise.resolve();

  // Return existing promise if already running — prevents double-spawning on refresh
  const existing = inFlight.get(id);
  if (existing) return existing;

  const wavPath = join(CACHE_DIR, `${id}.wav`);
  if (!existsSync(wavPath)) throw new Error(`Source WAV not found for ${id}`);

  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  const promise = new Promise<void>((resolve, reject) => {
    const proc = spawn(getDemucsPath(), [
      "-n", "htdemucs",
      "-o", STEMS_DIR,
      wavPath,
    ], { env: { ...process.env, TORCHAUDIO_BACKEND: "soundfile" } });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`demucs timed out after ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.on("data", () => {});
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`demucs failed (code ${code}): ${stderr}`));
      if (!stemsReady(id)) return reject(new Error("demucs finished but stems not found"));
      resolve();
    });
  }).finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, promise);
  return promise;
}
