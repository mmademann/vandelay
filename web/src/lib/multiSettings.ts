import type { StemName } from "../audio/dubEngine";
import type { EffectsState } from "../store";

export interface MultiSlot {
  id: string;
  trackId: string;
  stemName: StemName | null;
  isReference?: boolean;
  /** Tempo anchor flag. Stored on the session like isReference, not in per-slot settings —
   *  session load mints fresh UUIDs, so anything keyed by UUID is orphaned. */
  isTempoAnchor?: boolean;
  /** Time-stretch ratio to re-apply on load. Memory-only buffers make this the only record
   *  that a slot was tempo matched. */
  stretch?: number;
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
  /** Semitone step size for the octave/interval buttons. Part of the slot's visible state,
   *  so a restored session should not silently revert it to the default. */
  pitchInterval?: 1 | 7 | 12;
  /** Analysis results, snapshotted so a restored session shows its key/BPM badges
   *  immediately instead of blanking until re-analysis finishes. */
  detectedKey?: string | null;
  detectedBpm?: number;
  /** Slot ignores the master speed dial — for drums held at original tempo under a slowed bed. */
  bypassMasterSpeed?: boolean;
  /** Loop-start rotation as a fraction of the anchor's bar — lands the slot on the offbeat
   *  or a triplet position against the anchor. 0 = on the downbeat. */
  phase?: number;
  /** The un-phased loop. Phase is always derived from this rather than nudged from the
   *  current loop: incremental shifts are not reversible when the bar and loop lengths do
   *  not divide evenly, so the loop walks across the buffer. */
  phaseBaseStart?: number;
  phaseBaseEnd?: number;
}

// Per-slot saved settings (keyed by slot UUID)
export interface MultiSlotSavedSettings {
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
  bypassMasterSpeed?: boolean;
  /** Loop-start rotation as a fraction of a bar; see MultiSlot.phase. */
  phase?: number;
  /** The un-phased loop, as fractions of the buffer so a stretch does not invalidate them.
   *  Without these a refresh keeps `phase` but loses its origin, and the next phase click
   *  rotates around the current (already shifted) loop instead. */
  phaseBaseStartFrac?: number;
  phaseBaseEndFrac?: number;
  /**
   * Time-stretch ratio applied to reach the tempo anchor. Stretched buffers are memory-only,
   * so this is what lets the stretch be re-applied on reload instead of silently reverting.
   */
  stretch?: number;
}

const SLOT_SETTINGS_KEY = "vandelay:multi:slot-settings:v1";

function loadAllSlotSettings(): Record<string, MultiSlotSavedSettings> {
  try {
    const raw = localStorage.getItem(SLOT_SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, MultiSlotSavedSettings>;
  } catch { return {}; }
}

export function loadSlotSettings(uuid: string): MultiSlotSavedSettings | null {
  const all = loadAllSlotSettings();
  return all[uuid] ?? null;
}

export function saveSlotSettings(uuid: string, settings: MultiSlotSavedSettings): void {
  const all = loadAllSlotSettings();
  all[uuid] = settings;
  try { localStorage.setItem(SLOT_SETTINGS_KEY, JSON.stringify(all)); } catch {}
}

// Multi effect presets (shared across all slots)
export interface MultiPreset {
  name: string;
  effects: EffectsState;
  speed: number;
  pitch: number;
  linkPitch: boolean;
  gain: number;
}

const PRESETS_KEY = "vandelay:multi:presets:v1";

export function loadMultiPresets(): MultiPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is MultiPreset => p && typeof p.name === "string" && p.effects)
      .map((p) => (p.gain == null ? { ...p, gain: 0 } : p));
  } catch { return []; }
}

export function saveMultiPreset(name: string, preset: Omit<MultiPreset, "name">): MultiPreset[] {
  const existing = loadMultiPresets().filter((p) => p.name !== name);
  const updated = [{ name, ...preset }, ...existing];
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteMultiPreset(name: string): MultiPreset[] {
  const updated = loadMultiPresets().filter((p) => p.name !== name);
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

// Master speed — persisted like throw settings so it survives outside a named session
const MASTER_SPEED_KEY = "vandelay:multi:master-speed:v1";

export function loadMasterSpeed(): number {
  try {
    const raw = localStorage.getItem(MASTER_SPEED_KEY);
    if (!raw) return 1;
    const n = Number(JSON.parse(raw));
    // A NaN or absurd rate would silence every slot, so fall back to unity.
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}

export function saveMasterSpeed(v: number): void {
  try { localStorage.setItem(MASTER_SPEED_KEY, JSON.stringify(v)); } catch {}
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

/**
 * Name of the session the rack currently represents. Persisted because it is displayed in
 * the header, and a reload would otherwise show "Sessions" even though the loaded slots
 * came straight from a named session.
 */
const ACTIVE_SESSION_KEY = "vandelay:multi:active-session:v1";

export function loadActiveSessionName(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? (JSON.parse(raw) as string) : null;
  } catch { return null; }
}

export function saveActiveSessionName(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(ACTIVE_SESSION_KEY);
    else localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(name));
  } catch {}
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

/**
 * Tempo anchor, persisted the same way as the key anchor. Both are stored by
 * trackId+stemName rather than slot UUID because UUIDs are regenerated per session.
 */
const TEMPO_ANCHOR_KEY = "vandelay:multi:tempo-anchor:v1";

export function loadTempoAnchorKey(): { trackId: string; stemName: StemName | null } | null {
  try {
    const raw = localStorage.getItem(TEMPO_ANCHOR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveTempoAnchorKey(trackId: string, stemName: StemName | null): void {
  try { localStorage.setItem(TEMPO_ANCHOR_KEY, JSON.stringify({ trackId, stemName })); } catch {}
}

export function clearTempoAnchorKey(): void {
  try { localStorage.removeItem(TEMPO_ANCHOR_KEY); } catch {}
}

export interface MultiMasterSettings {
  gain: number;
  loopLengthOverride: number | null;
  throwSettings: ThrowSettings;
  /**
   * Relative multiplier over every slot's own speed. Because it scales all slots by the
   * same ratio, the intervals between them are preserved — the whole set transposes
   * together and stays in key sync. Slots with bypassMasterSpeed opt out.
   */
  masterSpeed: number;
}

export interface MultiSession {
  name: string;
  savedAt: number;
  slots: MultiSlot[];
  masterSettings: MultiMasterSettings;
}

const NAMED_KEY = "vandelay:multi:sessions:v1";

export function loadNamedSessions(): MultiSession[] {
  try {
    const raw = localStorage.getItem(NAMED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is MultiSession => s && typeof s.name === "string" && Array.isArray(s.slots))
      .map((s) => ({
        ...s,
        masterSettings: {
          ...s.masterSettings,
          masterSpeed: s.masterSettings?.masterSpeed ?? 1,
          throwSettings: { ...DEFAULT_THROW_SETTINGS, ...s.masterSettings?.throwSettings },
        },
      }));
  } catch {
    return [];
  }
}

export function saveNamedSession(
  name: string,
  slots: MultiSlot[],
  masterSettings: MultiMasterSettings,
): MultiSession[] {
  const existing = loadNamedSessions().filter((s) => s.name !== name);
  const updated: MultiSession[] = [{ name, savedAt: Date.now(), slots, masterSettings }, ...existing];
  try { localStorage.setItem(NAMED_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

/**
 * Rename in place, preserving slots/settings and list position. No-op if the new name is blank,
 * unchanged, or already taken (sessions are keyed by name, so a collision would clobber).
 */
export function renameNamedSession(oldName: string, newName: string): MultiSession[] {
  const sessions = loadNamedSessions();
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return sessions;
  if (sessions.some((s) => s.name === trimmed)) return sessions;
  const updated = sessions.map((s) => (s.name === oldName ? { ...s, name: trimmed } : s));
  try { localStorage.setItem(NAMED_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function deleteNamedSession(name: string): MultiSession[] {
  const updated = loadNamedSessions().filter((s) => s.name !== name);
  try { localStorage.setItem(NAMED_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

