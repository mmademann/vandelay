import type { EffectsState } from "../store";

export interface PerTrackSettings {
  loopStart: number;
  loopEnd: number;
  loopCount: number;
  effects: EffectsState;
  effectsEnabled?: boolean;
}

const KEY = "vandelay:settings:v1";

type Map = Record<string, PerTrackSettings>;

function readAll(): Map {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadSettings(id: string): PerTrackSettings | null {
  return readAll()[id] ?? null;
}

export function saveSettings(id: string, settings: PerTrackSettings): void {
  try {
    const all = readAll();
    all[id] = settings;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota or disabled — ignore */
  }
}

export function removeSettings(id: string): void {
  try {
    const all = readAll();
    delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
