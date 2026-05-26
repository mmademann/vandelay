import type { DrumTrackSettings } from "./mixSettings";

const KEY = "vandelay:drum-presets:v1";

export interface DrumPreset {
  name: string;
  settings: DrumTrackSettings;
}

export function loadPresets(): DrumPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, settings: DrumTrackSettings): DrumPreset[] {
  const presets = loadPresets().filter((p) => p.name !== name);
  const updated = [{ name, settings }, ...presets];
  try {
    localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    /* ignore */
  }
  return updated;
}

export function deletePreset(name: string): DrumPreset[] {
  const updated = loadPresets().filter((p) => p.name !== name);
  try {
    localStorage.setItem(KEY, JSON.stringify(updated));
  } catch {
    /* ignore */
  }
  return updated;
}
