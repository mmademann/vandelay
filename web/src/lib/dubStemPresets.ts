import type { EffectsState } from "../store";

const KEY = "vandelay:dub-stem-presets:v1";

export interface DubStemPreset {
  name: string;
  effects: EffectsState;
}

export function loadDubStemPresets(): DubStemPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.name === "string" && p.effects);
  } catch {
    return [];
  }
}

export function saveDubStemPreset(name: string, effects: EffectsState): DubStemPreset[] {
  const existing = loadDubStemPresets().filter((p) => p.name !== name);
  const updated = [{ name, effects }, ...existing];
  try { localStorage.setItem(KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteDubStemPreset(name: string): DubStemPreset[] {
  const updated = loadDubStemPresets().filter((p) => p.name !== name);
  try { localStorage.setItem(KEY, JSON.stringify(updated)); } catch {}
  return updated;
}
