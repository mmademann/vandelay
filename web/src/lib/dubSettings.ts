import { STEM_NAMES, DRY_EFFECTS, type StemName } from "../audio/dubEngine";
import type { EffectsState } from "../store";

export type PerStemSettings = {
  effects: EffectsState;
  muted: boolean;
  soloed: boolean;
  gainDb: number;
  dubActive: boolean;
  selectedPreset: string | null;
};

export type DubTrackSettings = {
  speed: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  stems: Record<StemName, PerStemSettings>;
};

const DEFAULT_STEM: PerStemSettings = {
  effects: { ...DRY_EFFECTS },
  muted: false,
  soloed: false,
  gainDb: 0,
  dubActive: false,
  selectedPreset: null,
};

function key(id: string) { return `dub_settings_${id}`; }

export function defaultDubSettings(): DubTrackSettings {
  return {
    speed: 1,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
    stems: Object.fromEntries(STEM_NAMES.map((s) => [s, { ...DEFAULT_STEM, effects: { ...DRY_EFFECTS } }])) as Record<StemName, PerStemSettings>,
  };
}

export function loadDubSettings(id: string): DubTrackSettings | null {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DubTrackSettings;
    return {
      speed: parsed.speed ?? 1,
      loopEnabled: parsed.loopEnabled ?? false,
      loopStart: parsed.loopStart ?? 0,
      loopEnd: parsed.loopEnd ?? 0,
      stems: Object.fromEntries(
        STEM_NAMES.map((s) => [s, { ...DEFAULT_STEM, ...parsed.stems?.[s], effects: { ...DRY_EFFECTS, ...parsed.stems?.[s]?.effects } }])
      ) as Record<StemName, PerStemSettings>,
    };
  } catch {
    return null;
  }
}

export function saveDubSettings(id: string, settings: DubTrackSettings) {
  try {
    localStorage.setItem(key(id), JSON.stringify(settings));
  } catch {}
}

export function removeDubSettings(id: string) {
  localStorage.removeItem(key(id));
}
