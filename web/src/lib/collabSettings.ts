import type { StemName } from "../audio/dubEngine";
import type { EffectsState } from "../store";

export interface CollabSlot {
  id: string;
  trackId: string;
  stemName: StemName;
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
  muted: boolean;
  soloed: boolean;
  effects: EffectsState;
  loopStart: number;
  loopEnd: number;
}

// Per-slot saved settings (keyed by trackId:stemName)
export interface CollabSlotSavedSettings {
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
  muted: boolean;
  effects: EffectsState;
  loopStartFrac: number;
  loopEndFrac: number;
}

const SLOT_SETTINGS_KEY = "vandelay:collab:slot-settings:v1";

function slotKey(trackId: string, stemName: StemName): string {
  return `${trackId}:${stemName}`;
}

function loadAllSlotSettings(): Record<string, CollabSlotSavedSettings> {
  try {
    const raw = localStorage.getItem(SLOT_SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CollabSlotSavedSettings>;
  } catch { return {}; }
}

export function loadSlotSettings(trackId: string, stemName: StemName): CollabSlotSavedSettings | null {
  const all = loadAllSlotSettings();
  return all[slotKey(trackId, stemName)] ?? null;
}

export function saveSlotSettings(trackId: string, stemName: StemName, settings: CollabSlotSavedSettings): void {
  const all = loadAllSlotSettings();
  all[slotKey(trackId, stemName)] = settings;
  try { localStorage.setItem(SLOT_SETTINGS_KEY, JSON.stringify(all)); } catch {}
}

// Collab effect presets (shared across all slots)
export interface CollabPreset {
  name: string;
  effects: EffectsState;
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
}

const PRESETS_KEY = "vandelay:collab:presets:v1";

export function loadCollabPresets(): CollabPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is CollabPreset => p && typeof p.name === "string" && p.effects)
      .map((p) => (p.gain == null ? { ...p, gain: 0 } : p));
  } catch { return []; }
}

export function saveCollabPreset(name: string, preset: Omit<CollabPreset, "name">): CollabPreset[] {
  const existing = loadCollabPresets().filter((p) => p.name !== name);
  const updated = [{ name, ...preset }, ...existing];
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteCollabPreset(name: string): CollabPreset[] {
  const updated = loadCollabPresets().filter((p) => p.name !== name);
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export interface CollabMasterSettings {
  gain: number;
  loopLengthOverride: number | null;
}

export interface CollabSession {
  name: string;
  savedAt: number;
  slots: CollabSlot[];
  masterSettings: CollabMasterSettings;
}

const NAMED_KEY = "vandelay:collab:sessions:v1";

export function loadNamedSessions(): CollabSession[] {
  try {
    const raw = localStorage.getItem(NAMED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is CollabSession =>
        s && typeof s.name === "string" && Array.isArray(s.slots),
    );
  } catch {
    return [];
  }
}

export function saveNamedSession(
  name: string,
  slots: CollabSlot[],
  masterSettings: CollabMasterSettings,
): CollabSession[] {
  const existing = loadNamedSessions().filter((s) => s.name !== name);
  const updated: CollabSession[] = [{ name, savedAt: Date.now(), slots, masterSettings }, ...existing];
  try { localStorage.setItem(NAMED_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteNamedSession(name: string): CollabSession[] {
  const updated = loadNamedSessions().filter((s) => s.name !== name);
  try { localStorage.setItem(NAMED_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}
