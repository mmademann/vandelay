import { create } from "zustand";
import { DEFAULT_EFFECTS, sanitizeEffects, sanitizeLoopRegion, type EffectsState } from "./store";
import {
  loadMix,
  saveMix,
  type MixTrackSettings,
  type AudioTrackSettings,
  type DrumTrackSettings,
  DEFAULT_DRUM_TRACK,
  DRUM_TRACK_ID,
} from "./lib/mixSettings";

export interface MixTrack {
  id: string;
  title: string;
  duration: number;
  buffer: AudioBuffer;
}

interface MixStore {
  tracks: MixTrack[];
  settings: Record<string, MixTrackSettings>;
  pausedIds: Set<string>;
  masterGain: number;
  loopCount: number;
  isPlaying: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  addTrack: (track: MixTrack) => void;
  removeTrack: (id: string) => void;
  clearTracks: () => void;
  setLoopRegion: (id: string, start: number, end: number) => void;
  setEffect: <K extends keyof EffectsState>(id: string, key: K, value: EffectsState[K]) => void;
  setEffectsEnabled: (id: string, enabled: boolean) => void;
  resetTrackEffects: (id: string) => void;
  setVolume: (id: string, db: number) => void;
  setMuted: (id: string, muted: boolean) => void;
  togglePaused: (id: string) => void;
  setMasterGain: (v: number) => void;
  setLoopCount: (n: number) => void;
  setIsPlaying: (b: boolean) => void;
  setStatus: (s: MixStore["status"], error?: string | null) => void;
  setDrums: (updates: Partial<DrumTrackSettings>) => void;
  setHatEffect: <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => void;
}

const persisted = loadMix();

function defaultAudioSettings(duration: number): AudioTrackSettings {
  const loop = sanitizeLoopRegion(0, Math.min(duration, 8), duration);
  return {
    type: "audio",
    loopStart: loop.loopStart,
    loopEnd: loop.loopEnd,
    effects: DEFAULT_EFFECTS,
    effectsEnabled: true,
    volumeDb: 0,
    muted: false,
  };
}


function sanitizeSettings(settings: Record<string, MixTrackSettings>): Record<string, MixTrackSettings> {
  const result: Record<string, MixTrackSettings> = {};
  for (const [id, s] of Object.entries(settings)) {
    result[id] = { ...s, effects: sanitizeEffects(s.effects) };
  }
  return result;
}

function ensureDrums(settings: Record<string, MixTrackSettings>): Record<string, MixTrackSettings> {
  if (settings[DRUM_TRACK_ID]) return settings;
  return { ...settings, [DRUM_TRACK_ID]: DEFAULT_DRUM_TRACK };
}

function persist(state: MixStore) {
  saveMix({
    settings: state.settings,
    masterGain: state.masterGain,
    loopCount: state.loopCount,
  });
}

const initialSettings = ensureDrums(sanitizeSettings(persisted?.settings ?? {}));

export const useMixStore = create<MixStore>((set, get) => ({
  tracks: [],
  settings: initialSettings,
  pausedIds: new Set(),
  masterGain: persisted?.masterGain ?? 1,
  loopCount: persisted?.loopCount ?? 4,
  isPlaying: false,
  status: "idle",
  error: null,
  addTrack: (track) => {
    set((s) => {
      if (s.tracks.some((t) => t.id === track.id)) return s;
      const existing = s.settings[track.id];
      const base = defaultAudioSettings(track.duration);
      const merged: AudioTrackSettings =
        existing && existing.type === "audio"
          ? (() => {
              const loop = sanitizeLoopRegion(
                existing.loopStart,
                existing.loopEnd,
                track.duration,
              );
              return {
                ...base,
                ...existing,
                loopStart: loop.loopStart,
                loopEnd: loop.loopEnd,
                effects: { ...DEFAULT_EFFECTS, ...existing.effects },
                effectsEnabled: existing.effectsEnabled ?? true,
              };
            })()
          : base;
      return { tracks: [...s.tracks, track], settings: { ...s.settings, [track.id]: merged } };
    });
    persist(get());
  },
  clearTracks: () => {
    set({ tracks: [], pausedIds: new Set(), isPlaying: false, status: "idle", error: null });
  },
  removeTrack: (id) => {
    set((s) => {
      const settings = { ...s.settings };
      delete settings[id];
      const pausedIds = new Set(s.pausedIds);
      pausedIds.delete(id);
      return { tracks: s.tracks.filter((t) => t.id !== id), settings, pausedIds };
    });
    persist(get());
  },
  setLoopRegion: (id, loopStart, loopEnd) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur || cur.type !== "audio") return s;
      const track = s.tracks.find((t) => t.id === id);
      const loop = sanitizeLoopRegion(loopStart, loopEnd, track?.duration ?? 0);
      return {
        settings: { ...s.settings, [id]: { ...cur, loopStart: loop.loopStart, loopEnd: loop.loopEnd } },
      };
    });
    persist(get());
  },
  setEffect: (id, key, value) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return s;
      return { settings: { ...s.settings, [id]: { ...cur, effects: { ...cur.effects, [key]: value } } } };
    });
    persist(get());
  },
  setEffectsEnabled: (id, effectsEnabled) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur || cur.type !== "audio") return s;
      return { settings: { ...s.settings, [id]: { ...cur, effectsEnabled } } };
    });
    persist(get());
  },
  resetTrackEffects: (id) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return s;
      return { settings: { ...s.settings, [id]: { ...cur, effects: DEFAULT_EFFECTS } } };
    });
    persist(get());
  },
  setVolume: (id, db) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return s;
      return { settings: { ...s.settings, [id]: { ...cur, volumeDb: db } } };
    });
    persist(get());
  },
  setMuted: (id, muted) => {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return s;
      return { settings: { ...s.settings, [id]: { ...cur, muted } } };
    });
    persist(get());
  },
  togglePaused: (id) => {
    set((s) => {
      const next = new Set(s.pausedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { pausedIds: next };
    });
  },
  setMasterGain: (masterGain) => { set({ masterGain }); persist(get()); },
  setLoopCount: (loopCount) => { set({ loopCount }); persist(get()); },
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setStatus: (status, error = null) => set({ status, error }),
  setDrums: (updates) => {
    set((s) => {
      const cur = s.settings[DRUM_TRACK_ID];
      if (!cur || cur.type !== "drums") return s;
      return { settings: { ...s.settings, [DRUM_TRACK_ID]: { ...cur, ...updates } } };
    });
    persist(get());
  },
  setHatEffect: (key, value) => {
    set((s) => {
      const cur = s.settings[DRUM_TRACK_ID];
      if (!cur || cur.type !== "drums") return s;
      return { settings: { ...s.settings, [DRUM_TRACK_ID]: { ...cur, hatEffects: { ...cur.hatEffects, [key]: value } } } };
    });
    persist(get());
  },
}));
