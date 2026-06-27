import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CACHE_DIR } from "./extract.js";

export const STEMS_DIR = join(CACHE_DIR, "..", "stems");
if (!existsSync(STEMS_DIR)) mkdirSync(STEMS_DIR, { recursive: true });

function resolveDemucs(): string {
  // Check common install locations before falling back to PATH
  const candidates = [
    join(homedir(), ".local", "bin", "demucs"),
    "/opt/homebrew/bin/demucs",
    "/usr/local/bin/demucs",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH
  try {
    return execSync("which demucs", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "demucs not found. Install it with: pipx install demucs && pipx inject demucs 'torchcodec==0.9.0'\n" +
      "See README.md for full setup instructions."
    );
  }
}

const DEMUCS_PATH = resolveDemucs();

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

export function stemsReady(id: string): boolean {
  return STEM_NAMES.every((s) => existsSync(stemPath(id, s)));
}

export function separateStems(id: string): Promise<void> {
  if (stemsReady(id)) return Promise.resolve();

  const wavPath = join(CACHE_DIR, `${id}.wav`);
  if (!existsSync(wavPath)) throw new Error(`Source WAV not found for ${id}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(DEMUCS_PATH, [
      "-n", "htdemucs",
      "-o", STEMS_DIR,
      wavPath,
    ], { env: { ...process.env, TORCHAUDIO_BACKEND: "soundfile" } });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.on("data", () => {});
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`demucs failed (code ${code}): ${stderr}`));
      if (!stemsReady(id)) return reject(new Error("demucs finished but stems not found"));
      resolve();
    });
  });
}
