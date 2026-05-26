import { DEFAULT_EFFECTS, effectiveEffects, sanitizeEffects, type EffectsState } from "../store";

export const DRUM_TRACK_ID = "__drums__";

export type DrumPattern = "off" | "four-on-the-floor" | "half-time" | "custom";

export interface AudioTrackSettings {
  type: "audio";
  loopStart: number;
  loopEnd: number;
  effects: EffectsState;
  /** When false, bypass chain for playback/export; slider values are kept. */
  effectsEnabled?: boolean;
  volumeDb: number;
  muted: boolean;
}

export function appliedAudioEffects(cfg: AudioTrackSettings): EffectsState {
  return effectiveEffects(cfg.effects, cfg.effectsEnabled !== false);
}

export interface DrumTrackSettings {
  type: "drums";
  pattern: DrumPattern;
  bpm: number;
  kickSteps: boolean[];
  hatSteps: boolean[];
  effects: EffectsState;
  hatEffects: EffectsState;
  volumeDb: number;
  muted: boolean;
  kickVolume: number;
  hatVolume: number;
  kickDecay: number;
  kickTone: number;
  kickPunch: number;
}

export type MixTrackSettings = AudioTrackSettings | DrumTrackSettings;

export interface MixState {
  settings: Record<string, MixTrackSettings>;
  masterGain: number;
  loopCount: number;
}

export const DRUM_PATTERNS: Record<Exclude<DrumPattern, "off" | "custom">, Pick<DrumTrackSettings, "kickSteps" | "hatSteps">> = {
  "four-on-the-floor": {
    kickSteps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
    hatSteps:  [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
  },
  "half-time": {
    kickSteps: [true, false, false, false, false, false, false, false, false, false, true, false, false, false, false, false],
    hatSteps:  [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
  },
};

export const DEFAULT_DRUM_TRACK: DrumTrackSettings = {
  type: "drums",
  pattern: "off",
  bpm: 75,
  kickSteps: Array(16).fill(false),
  hatSteps: Array(16).fill(false),
  effects: {
    speed: 1,
    pitch: 0,
    linkPitch: true,
    reverbDecay: 0,
    reverbWet: 0,
    gain: 1,
    bassBoost: 0,
    delayTime: 0,
    delayFeedback: 0,
    delayWet: 0,
  },
  hatEffects: {
    speed: 1,
    pitch: 0,
    linkPitch: true,
    reverbDecay: 0,
    reverbWet: 0,
    gain: 1,
    bassBoost: 0,
    delayTime: 0,
    delayFeedback: 0,
    delayWet: 0,
  },
  volumeDb: 0,
  muted: false,
  kickVolume: 1.0,
  hatVolume: 0.15,
  kickDecay: 1.25,
  kickTone: 14,
  kickPunch: 7.4,
};

const KEY = "vandelay:mix:v1";

export function loadMix(): MixState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as MixState;
    if (state.settings) {
      for (const id of Object.keys(state.settings)) {
        const s = state.settings[id] as unknown as Record<string, unknown>;
        if (s.effects && typeof s.effects === "object") {
          const base =
            (s as { type?: string }).type === "drums"
              ? DEFAULT_DRUM_TRACK.effects
              : DEFAULT_EFFECTS;
          s.effects = sanitizeEffects({ ...base, ...(s.effects as Partial<EffectsState>) });
        }
        if (s.hatEffects && typeof s.hatEffects === "object") {
          s.hatEffects = sanitizeEffects({
            ...DEFAULT_DRUM_TRACK.hatEffects,
            ...(s.hatEffects as Partial<EffectsState>),
          });
        } else if ((s as { type?: string }).type === "drums") {
          s.hatEffects = { ...DEFAULT_DRUM_TRACK.hatEffects };
        }
        if ((s as { type?: string }).type === "audio" && typeof s.effectsEnabled !== "boolean") {
          s.effectsEnabled = true;
        }
      }
    }
    return state;
  } catch {
    return null;
  }
}

export function saveMix(state: MixState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
