import { roundLoopTime } from "./format";
import type { EffectsState } from "../store";

const KEY = "vandelay:single-presets:v2";
const LEGACY_KEY = "vandelay:single-presets:v1";

/** Track-agnostic: loop region is stored as fractions of track duration. */
export interface SinglePresetSettings {
  loopStartFrac: number;
  loopEndFrac: number;
  loopCount: number;
  effects: EffectsState;
}

export interface SinglePreset {
  name: string;
  settings: SinglePresetSettings;
}

export const BUILT_IN_PRESETS: SinglePreset[] = [
  {
    name: "Dub Techno",
    settings: {
      loopStartFrac: 0,
      loopEndFrac: 1,
      loopCount: 1,
      effects: {
        speed: 0.85,
        pitch: 0,
        linkPitch: true,
        reverbType: "algorithmic",
        reverbDecay: 7,
        reverbWet: 0.65,
        delayTime: 0.375,
        delayFeedback: 0.55,
        delayWet: 0.45,
        bassBoost: 4,
        gain: 1,
      },
    },
  },
];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function trackToPresetSettings(
  duration: number,
  loopStart: number,
  loopEnd: number,
  loopCount: number,
  effects: EffectsState,
): SinglePresetSettings {
  const d = Math.max(0.05, duration);
  let startFrac = clamp01(loopStart / d);
  let endFrac = clamp01(loopEnd / d);
  if (endFrac <= startFrac) {
    startFrac = 0;
    endFrac = clamp01(Math.min(d, 8) / d);
  }
  return {
    loopStartFrac: startFrac,
    loopEndFrac: endFrac,
    loopCount,
    effects: { ...effects },
  };
}

export function presetLoopToAbsolute(
  preset: SinglePresetSettings,
  duration: number,
): { loopStart: number; loopEnd: number } {
  const d = Math.max(0.05, duration);
  let start = clamp01(preset.loopStartFrac) * d;
  let end = clamp01(preset.loopEndFrac) * d;
  if (end <= start) {
    start = 0;
    end = Math.min(d, clamp01(preset.loopEndFrac) * d || Math.min(d, 8));
  }
  if (end - start < 0.05) {
    end = Math.min(d, start + 0.05);
  }
  return { loopStart: roundLoopTime(start), loopEnd: roundLoopTime(end) };
}

function parseSettings(raw: unknown): SinglePresetSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.loopStartFrac === "number" && typeof o.loopEndFrac === "number") {
    return {
      loopStartFrac: clamp01(o.loopStartFrac),
      loopEndFrac: clamp01(o.loopEndFrac),
      loopCount: typeof o.loopCount === "number" ? o.loopCount : 1,
      effects: (o.effects && typeof o.effects === "object"
        ? o.effects
        : {}) as EffectsState,
    };
  }

  // v1: absolute seconds — migrate using referenceDuration when present
  if (typeof o.loopStart === "number" && typeof o.loopEnd === "number") {
    const ref =
      typeof o.referenceDuration === "number" && o.referenceDuration > 0
        ? o.referenceDuration
        : Math.max(o.loopEnd, o.loopStart + 0.05, 1);
    return {
      loopStartFrac: clamp01(o.loopStart / ref),
      loopEndFrac: clamp01(o.loopEnd / ref),
      loopCount: typeof o.loopCount === "number" ? o.loopCount : 1,
      effects: (o.effects && typeof o.effects === "object"
        ? o.effects
        : {}) as EffectsState,
    };
  }

  return null;
}

function readPresets(key: string): SinglePreset[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SinglePreset[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.name !== "string") continue;
      const settings = parseSettings(item.settings);
      if (settings) out.push({ name: item.name, settings });
    }
    return out;
  } catch {
    return [];
  }
}

function writePresets(presets: SinglePreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}

export function loadSinglePresets(): SinglePreset[] {
  const current = readPresets(KEY);
  if (current.length > 0) return current;

  const legacy = readPresets(LEGACY_KEY);
  if (legacy.length === 0) return [];

  writePresets(legacy);
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  return legacy;
}

export function saveSinglePreset(
  name: string,
  settings: SinglePresetSettings,
): SinglePreset[] {
  const presets = loadSinglePresets().filter((p) => p.name !== name);
  const updated = [{ name, settings }, ...presets];
  writePresets(updated);
  return updated;
}

export function deleteSinglePreset(name: string): SinglePreset[] {
  const updated = loadSinglePresets().filter((p) => p.name !== name);
  writePresets(updated);
  return updated;
}
