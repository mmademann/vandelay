import type { StemName } from "../audio/dubEngine";
import { sanitizeEffects } from "../store";
import type { EffectsState } from "../store";

export type StemRole = StemName | "full";
export type GenreName = "Dub" | "Lo-fi" | "Ambient" | "Dry";

export const STEM_AUTO_PRESETS: Record<StemRole, Partial<EffectsState>> = {
  drums:  { reverbWet: 0.08, reverbDecay: 1.5, delayWet: 0.04, delayTime: 0.12, delayFeedback: 0.3, bassBoost: 2, eqLow: 0, eqHigh: 1, grit: 0.05 },
  bass:   { reverbWet: 0.04, reverbDecay: 2, delayWet: 0, delayTime: 0, delayFeedback: 0, bassBoost: 5, eqLow: 2, eqHigh: -3, grit: 0.08 },
  vocals: { reverbWet: 0.3, reverbDecay: 3, delayWet: 0.15, delayTime: 0.25, delayFeedback: 0.4, bassBoost: 0, eqLow: -1, eqHigh: 2, grit: 0 },
  other:  { reverbWet: 0.18, reverbDecay: 2.5, delayWet: 0.08, delayTime: 0.25, delayFeedback: 0.3, bassBoost: 0, eqLow: 0, eqHigh: 1, grit: 0 },
  full:   { reverbWet: 0.12, reverbDecay: 2.5, delayWet: 0.06, delayTime: 0.25, delayFeedback: 0.3, bassBoost: 0, eqLow: 0, eqHigh: 0, grit: 0 },
};

const DRY_VIBE: Partial<EffectsState> = {
  reverbWet: 0, delayWet: 0, spaceEchoWow: 0, bigKnobWet: 0, grit: 0,
  phaserWet: 0, chorusWet: 0, bassBoost: 0, eqLow: 0, eqMid: 0, eqHigh: 0,
};

export const GENRE_PRESETS: Record<GenreName, Record<StemRole, Partial<EffectsState>>> = {
  "Dub": {
    drums:  { reverbWet: 0.1, reverbDecay: 2, delayWet: 0.05, delayTime: 0.12, delayFeedback: 0.4, spaceEchoWow: 0.3, bigKnobWet: 0, bassBoost: 3 },
    bass:   { reverbWet: 0.05, reverbDecay: 2, delayWet: 0, delayTime: 0, delayFeedback: 0, spaceEchoWow: 0, bigKnobWet: 0, bassBoost: 6 },
    vocals: { reverbWet: 0.5, reverbDecay: 4, delayWet: 0.6, delayTime: 0.35, delayFeedback: 0.65, spaceEchoWow: 0.5, bigKnobWet: 0.4, bassBoost: 0 },
    other:  { reverbWet: 0.3, reverbDecay: 3, delayWet: 0.35, delayTime: 0.25, delayFeedback: 0.5, spaceEchoWow: 0.3, bigKnobWet: 0.2, bassBoost: 0 },
    full:   { reverbWet: 0.25, reverbDecay: 3, delayWet: 0.25, delayTime: 0.25, delayFeedback: 0.45, spaceEchoWow: 0.3, bigKnobWet: 0.2, bassBoost: 2 },
  },
  "Lo-fi": {
    drums:  { reverbWet: 0.12, reverbDecay: 1.5, delayWet: 0, grit: 0.15, bassBoost: 3, eqHigh: -3, eqLow: 1 },
    bass:   { reverbWet: 0.05, reverbDecay: 1.5, delayWet: 0, grit: 0.12, bassBoost: 6, eqHigh: -4, eqLow: 3 },
    vocals: { reverbWet: 0.2, reverbDecay: 2, delayWet: 0, grit: 0.1, bassBoost: 0, eqHigh: -2, eqLow: 0 },
    other:  { reverbWet: 0.15, reverbDecay: 2, delayWet: 0, grit: 0.08, bassBoost: 0, eqHigh: -2, eqLow: 0 },
    full:   { reverbWet: 0.1, reverbDecay: 2, delayWet: 0, grit: 0.1, bassBoost: 2, eqHigh: -2, eqLow: 1 },
  },
  "Ambient": {
    drums:  { reverbWet: 0.15, reverbDecay: 5, bigKnobWet: 0.3, delayWet: 0, eqHigh: -2 },
    bass:   { reverbWet: 0.08, reverbDecay: 4, bigKnobWet: 0.2, delayWet: 0, eqHigh: -3 },
    vocals: { reverbWet: 0.7, reverbDecay: 7, bigKnobWet: 0.6, delayWet: 0.1, eqHigh: 0 },
    other:  { reverbWet: 0.5, reverbDecay: 6, bigKnobWet: 0.5, delayWet: 0.1, eqHigh: 0 },
    full:   { reverbWet: 0.4, reverbDecay: 6, bigKnobWet: 0.45, delayWet: 0.08, eqHigh: -1 },
  },
  "Dry": {
    drums: DRY_VIBE, bass: DRY_VIBE, vocals: DRY_VIBE, other: DRY_VIBE, full: DRY_VIBE,
  },
};

type RangeMap = Partial<Record<keyof EffectsState, [number, number]>>;

const RANDOMIZE_RANGES: Record<StemRole, RangeMap> = {
  drums:  { reverbWet: [0.05, 0.2], reverbDecay: [1, 3], delayWet: [0, 0.15], delayTime: [0.1, 0.4], delayFeedback: [0.2, 0.5], grit: [0, 0.12], bassBoost: [0, 4], eqHigh: [-2, 3], bigKnobWet: [0, 0.2] },
  bass:   { reverbWet: [0, 0.1], reverbDecay: [1.5, 3], delayWet: [0, 0.05], delayTime: [0.1, 0.25], delayFeedback: [0.2, 0.4], grit: [0, 0.15], bassBoost: [2, 8], eqHigh: [-4, 0], bigKnobWet: [0, 0.1] },
  vocals: { reverbWet: [0.1, 0.5], reverbDecay: [2, 5], delayWet: [0, 0.35], delayTime: [0.15, 0.4], delayFeedback: [0.2, 0.6], grit: [0, 0.08], bassBoost: [-2, 2], eqHigh: [0, 3], bigKnobWet: [0, 0.4] },
  other:  { reverbWet: [0.1, 0.4], reverbDecay: [2, 5], delayWet: [0, 0.25], delayTime: [0.15, 0.4], delayFeedback: [0.2, 0.6], grit: [0, 0.1], bassBoost: [-2, 2], eqHigh: [-1, 3], bigKnobWet: [0, 0.3] },
  full:   { reverbWet: [0.05, 0.3], reverbDecay: [2, 4], delayWet: [0, 0.2], delayTime: [0.15, 0.35], delayFeedback: [0.2, 0.5], grit: [0, 0.1], bassBoost: [0, 3], eqHigh: [-1, 2], bigKnobWet: [0, 0.25] },
};

function lerp(min: number, max: number, t: number) {
  return min + (max - min) * t;
}

export function randomizeEffects(base: EffectsState, role: StemRole): EffectsState {
  const ranges = RANDOMIZE_RANGES[role];
  const patch: Partial<EffectsState> = {};
  for (const key of Object.keys(ranges) as Array<keyof EffectsState>) {
    const range = ranges[key];
    if (range) {
      (patch as Record<string, number>)[key as string] = lerp(range[0], range[1], Math.random());
    }
  }
  return sanitizeEffects({ ...base, ...patch });
}
