import { create } from "zustand";
import { roundLoopTime } from "./lib/format";
import { loadSettings, saveSettings } from "./lib/settings";
import {
  presetLoopToAbsolute,
  type SinglePresetSettings,
} from "./lib/singlePresets";

export type Status = "idle" | "loading" | "ready" | "error";

export const EFFECTS_LIMITS = {
  delayTime: { min: 0, max: 4 },
  delayFeedback: { min: 0, max: 0.95 },
  delayWet: { min: 0, max: 1 },
  reverbWet: { min: 0, max: 1 },
  reverbDecay: { min: 0, max: 10, engineMin: 0.1 }, // Tone.js Reverb requires >= 0.1
  speed: { min: 0.5, max: 1 },
  gain: { min: 0, max: 6 },
  bassBoost: { min: -20, max: 20 },
  grit: { min: 0, max: 1 },
} as const;

export interface Track {
  id: string;
  title: string;
  duration: number;
  buffer: AudioBuffer;
}

export type ReverbType = "algorithmic" | "convolution";

export interface EffectsState {
  speed: number;
  pitch: number;
  linkPitch: boolean;
  reverbType?: ReverbType;
  reverbDecay: number;
  reverbWet: number;
  gain: number;
  bassBoost: number;
  delayTime: number;
  delayFeedback: number;
  delayWet: number;
  grit: number;
}

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }

export function resolveReverbType(e: EffectsState): ReverbType {
  return e.reverbType === "convolution" ? "convolution" : "algorithmic";
}

export function sanitizeEffects(e: EffectsState): EffectsState {
  return {
    ...e,
    reverbType: resolveReverbType(e),
    speed: clamp(e.speed, EFFECTS_LIMITS.speed.min, EFFECTS_LIMITS.speed.max),
    reverbDecay: clamp(e.reverbDecay, EFFECTS_LIMITS.reverbDecay.min, EFFECTS_LIMITS.reverbDecay.max),
    reverbWet: clamp(e.reverbWet, EFFECTS_LIMITS.reverbWet.min, EFFECTS_LIMITS.reverbWet.max),
    delayTime: clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max),
    delayFeedback: clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max),
    delayWet: clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max),
    gain: clamp(e.gain, EFFECTS_LIMITS.gain.min, EFFECTS_LIMITS.gain.max),
    bassBoost: clamp(e.bassBoost, EFFECTS_LIMITS.bassBoost.min, EFFECTS_LIMITS.bassBoost.max),
    grit: clamp(e.grit ?? 0, EFFECTS_LIMITS.grit.min, EFFECTS_LIMITS.grit.max),
  };
}

export const DEFAULT_EFFECTS: EffectsState = {
  speed: 0.8,
  pitch: 0,
  linkPitch: true,
  reverbType: "algorithmic",
  reverbDecay: 3,
  reverbWet: 0.3,
  gain: 1,
  bassBoost: 0,
  delayTime: 0,
  delayFeedback: 0,
  delayWet: 0,
  grit: 0,
};

/** Applied when effects are toggled off; slider values are kept in state. */
export const BYPASS_EFFECTS: EffectsState = {
  speed: 1,
  pitch: 0,
  linkPitch: true,
  reverbType: "algorithmic",
  reverbDecay: EFFECTS_LIMITS.reverbDecay.engineMin,
  reverbWet: 0,
  gain: 1,
  bassBoost: 0,
  delayTime: 0,
  delayFeedback: 0,
  delayWet: 0,
  grit: 0,
};

export function effectiveEffects(
  effects: EffectsState,
  enabled: boolean,
): EffectsState {
  return enabled ? effects : BYPASS_EFFECTS;
}

interface AppState {
  status: Status;
  error: string | null;
  track: Track | null;
  isPlaying: boolean;
  loopStart: number;
  loopEnd: number;
  loopCount: number;
  effects: EffectsState;
  effectsEnabled: boolean;
  setStatus: (s: Status, error?: string | null) => void;
  setTrack: (t: Track) => void;
  clearTrack: () => void;
  setIsPlaying: (b: boolean) => void;
  setLoopRegion: (start: number, end: number) => void;
  setLoopCount: (n: number) => void;
  setEffect: <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => void;
  setEffectsEnabled: (enabled: boolean) => void;
  resetEffects: () => void;
  applyPreset: (settings: SinglePresetSettings) => void;
}

/** Ensure loop region is valid for playback/export (uses decoded buffer length). */
export function sanitizeLoopRegion(
  loopStart: number,
  loopEnd: number,
  duration: number,
): { loopStart: number; loopEnd: number } {
  const d = Math.max(0.05, duration);
  let start = Math.max(0, Math.min(d, loopStart));
  let end = Math.max(0, Math.min(d, loopEnd));
  if (end <= start) {
    start = 0;
    end = d;
  }
  if (end - start < 0.05) {
    end = Math.min(d, start + 0.05);
  }
  start = roundLoopTime(start);
  end = roundLoopTime(end);
  start = Math.max(0, Math.min(d, start));
  end = Math.max(0, Math.min(d, end));
  if (end <= start) {
    start = 0;
    end = Math.min(d, start + 0.05);
  }
  return { loopStart: start, loopEnd: end };
}

function persistCurrent(state: AppState): void {
  if (!state.track) return;
  saveSettings(state.track.id, {
    loopStart: state.loopStart,
    loopEnd: state.loopEnd,
    loopCount: state.loopCount,
    effects: state.effects,
    effectsEnabled: state.effectsEnabled,
  });
}

export const useStore = create<AppState>((set, get) => ({
  status: "idle",
  error: null,
  track: null,
  isPlaying: false,
  loopStart: 0,
  loopEnd: 0,
  loopCount: 1,
  effects: DEFAULT_EFFECTS,
  effectsEnabled: true,
  setStatus: (status, error = null) => set({ status, error }),
  setTrack: (track) => {
    const saved = loadSettings(track.id);
    const duration = track.buffer.duration;
    const loop = sanitizeLoopRegion(
      saved?.loopStart ?? 0,
      saved?.loopEnd ?? duration,
      duration,
    );
    set({
      track: { ...track, duration },
      status: "ready",
      isPlaying: false,
      loopStart: loop.loopStart,
      loopEnd: loop.loopEnd,
      loopCount: saved?.loopCount ?? 1,
      effects: saved?.effects ? sanitizeEffects({ ...DEFAULT_EFFECTS, ...saved.effects }) : DEFAULT_EFFECTS,
      effectsEnabled: saved?.effectsEnabled ?? true,
    });
  },
  clearTrack: () =>
    set({
      track: null,
      status: "idle",
      error: null,
      isPlaying: false,
      loopStart: 0,
      loopEnd: 0,
    }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setLoopRegion: (loopStart, loopEnd) => {
    const duration = get().track?.duration ?? 0;
    const loop = sanitizeLoopRegion(loopStart, loopEnd, duration);
    set({ loopStart: loop.loopStart, loopEnd: loop.loopEnd });
    persistCurrent(get());
  },
  setLoopCount: (loopCount) => {
    set({ loopCount });
    persistCurrent(get());
  },
  setEffect: (key, value) => {
    set((s) => ({ effects: { ...s.effects, [key]: value } }));
    persistCurrent(get());
  },
  setEffectsEnabled: (effectsEnabled) => {
    set({ effectsEnabled });
    persistCurrent(get());
  },
  resetEffects: () => {
    set({ effects: DEFAULT_EFFECTS });
    persistCurrent(get());
  },
  applyPreset: (preset) => {
    const track = get().track;
    if (!track) return;
    const duration = track.buffer.duration;
    const abs = presetLoopToAbsolute(preset, duration);
    const loop = sanitizeLoopRegion(abs.loopStart, abs.loopEnd, duration);
    const effects = sanitizeEffects({ ...DEFAULT_EFFECTS, ...preset.effects });
    set({
      loopStart: loop.loopStart,
      loopEnd: loop.loopEnd,
      loopCount: Math.max(1, Math.min(500, preset.loopCount || 1)),
      effects,
    });
    persistCurrent(get());
  },
}));
