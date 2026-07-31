import type { StemName } from "../audio/dubEngine";
import type { EffectsState } from "../store";

export interface CollabSlot {
  id: string;
  trackId: string;
  stemName: StemName | null;
  isReference?: boolean;
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
  muted: boolean;
  soloed: boolean;
  effects: EffectsState;
  loopStart: number;
  loopEnd: number;
  isMatched?: boolean;
  matchedBasePitch?: number;
}

// Per-slot saved settings (keyed by slot UUID)
export interface CollabSlotSavedSettings {
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
  muted: boolean;
  effects: EffectsState;
  loopStartFrac: number;
  loopEndFrac: number;
  isMatched?: boolean;
  matchedBasePitch?: number;
  pitchInterval?: 1 | 7 | 12;
}

const SLOT_SETTINGS_KEY = "vandelay:multi:slot-settings:v1";

function loadAllSlotSettings(): Record<string, CollabSlotSavedSettings> {
  try {
    const raw = localStorage.getItem(SLOT_SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CollabSlotSavedSettings>;
  } catch { return {}; }
}

export function loadSlotSettings(uuid: string): CollabSlotSavedSettings | null {
  const all = loadAllSlotSettings();
  return all[uuid] ?? null;
}

export function saveSlotSettings(uuid: string, settings: CollabSlotSavedSettings): void {
  const all = loadAllSlotSettings();
  all[uuid] = settings;
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

const PRESETS_KEY = "vandelay:multi:presets:v1";

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

export interface ThrowSettings {
  delayTime: number;
  delayFeedback: number;
  delayWet: number;
  reverbDecay: number;
  reverbWet: number;
  // Env-swept resonant filter on the throw echoes (the "crazy freq/env" dub move)
  filterFreq: number;   // resting cutoff Hz
  filterSweep: number;  // 0 = off; scales resonance + sweep depth
}

export const DEFAULT_THROW_SETTINGS: ThrowSettings = {
  delayTime: 0.25,
  delayFeedback: 0.72,
  delayWet: 1.0,
  reverbDecay: 3.5,
  reverbWet: 0.6,
  filterFreq: 700,
  filterSweep: 0.5,
};

// Throw settings — persisted independently so they survive without a named session
const THROW_SETTINGS_KEY = "vandelay:multi:throw-settings:v1";

export function loadThrowSettings(): ThrowSettings {
  try {
    const raw = localStorage.getItem(THROW_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_THROW_SETTINGS };
    // Merge with defaults so new fields (filterFreq, filterSweep) appear in old saves
    return { ...DEFAULT_THROW_SETTINGS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_THROW_SETTINGS }; }
}

export function saveThrowSettings(s: ThrowSettings): void {
  try { localStorage.setItem(THROW_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

// Throw presets
export interface ThrowPreset {
  name: string;
  settings: ThrowSettings;
}

const THROW_PRESETS_KEY = "vandelay:multi:throw-presets:v1";

export function loadThrowPresets(): ThrowPreset[] {
  try {
    const raw = localStorage.getItem(THROW_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is ThrowPreset => p && typeof p.name === "string" && p.settings);
  } catch { return []; }
}

export function saveThrowPreset(name: string, settings: ThrowSettings): ThrowPreset[] {
  const existing = loadThrowPresets().filter((p) => p.name !== name);
  const updated = [{ name, settings }, ...existing];
  try { localStorage.setItem(THROW_PRESETS_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteThrowPreset(name: string): ThrowPreset[] {
  const updated = loadThrowPresets().filter((p) => p.name !== name);
  try { localStorage.setItem(THROW_PRESETS_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

const ANCHOR_KEY = "vandelay:multi:anchor:v1";

export function loadAnchorKey(): { trackId: string; stemName: StemName | null } | null {
  try {
    const raw = localStorage.getItem(ANCHOR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveAnchorKey(trackId: string, stemName: StemName | null): void {
  try { localStorage.setItem(ANCHOR_KEY, JSON.stringify({ trackId, stemName })); } catch {}
}

export function clearAnchorKey(): void {
  try { localStorage.removeItem(ANCHOR_KEY); } catch {}
}

export interface CollabMasterSettings {
  gain: number;
  loopLengthOverride: number | null;
  throwSettings: ThrowSettings;
}

export interface CollabSession {
  name: string;
  savedAt: number;
  slots: CollabSlot[];
  masterSettings: CollabMasterSettings;
}

const NAMED_KEY = "vandelay:multi:sessions:v1";

export function loadNamedSessions(): CollabSession[] {
  try {
    const raw = localStorage.getItem(NAMED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is CollabSession => s && typeof s.name === "string" && Array.isArray(s.slots))
      .map((s) => ({
        ...s,
        masterSettings: {
          ...s.masterSettings,
          throwSettings: { ...DEFAULT_THROW_SETTINGS, ...s.masterSettings?.throwSettings },
        },
      }));
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
