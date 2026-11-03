/**
 * Step patterns for outboard gear, written in SCALE DEGREES rather than notes.
 *
 * This is the one decision the whole feature turns on. A step holds "the fifth, an octave
 * down", not "E1" — so the same pattern follows the key anchor wherever it goes, and
 * re-pitches itself when the anchor changes. A grid of absolute notes would be in tune
 * once, against one track, and wrong the moment anything moved.
 *
 * It also means you can write a line that works without knowing any notes: every degree is
 * in the scale by construction, so there is no wrong button.
 */

/** Semitones above the root for each degree, 1-7. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/**
 * Minor with a flat second. The sound of acid: the b2 against the root is most of why a
 * 303 line feels menacing rather than merely melodic.
 */
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

/** Minor with a raised sixth — minor's weight without its sadness. */
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
/** Minor with a major seventh. The gap between b6 and 7 is the whole character. */
const HARMONIC = [0, 2, 3, 5, 7, 8, 11];
/** Major with a flat seventh — major that never quite resolves. */
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];

export type ScaleName = "minor" | "phrygian" | "major" | "dorian" | "harmonic" | "mixolydian";

// Order is the order they appear on screen, so it runs darkest to brightest rather than
// in the order they happened to be added.
export const SCALES: Record<ScaleName, number[]> = {
  phrygian: PHRYGIAN,
  harmonic: HARMONIC,
  minor: MINOR,
  dorian: DORIAN,
  mixolydian: MIXOLYDIAN,
  major: MAJOR,
};

export interface Step {
  /** Off is a rest. The 303's silences carry as much as its notes. */
  on: boolean;
  /** 1-7 within the scale. */
  degree: number;
  /** Octave offset from the pattern's own octave. */
  oct: number;
  /** Louder, brighter, snappier — the 303's accent, sent as velocity. */
  accent: boolean;
  /**
   * Glide into this note from the one before.
   *
   * Implemented by holding the PREVIOUS note past this one's start. On a 303 the slide is
   * portamento between overlapping notes, not a parameter — so legato IS the slide.
   */
  slide: boolean;
}

export interface Pattern {
  steps: Step[];
  /** Steps per quarter note. 4 = sixteenths, the 303 default. */
  stepsPerBeat: number;
  scale: ScaleName;
  /** Where the whole pattern sits. 2 is bass register for a 303. */
  octave: number;
  /**
   * Root semitone 0-11, or null to follow the key anchor.
   *
   * Null is the point of the feature; the override exists because key detection fails on
   * plenty of material and a dead sequencer would be worse than a manual one.
   */
  root: number | null;
}

export const STEP_COUNT = 16;

export function emptyPattern(): Pattern {
  return {
    steps: Array.from({ length: STEP_COUNT }, (_, i) => ({
      // A bare root on every downbeat: audibly a pattern the moment you press play, rather
      // than silence you have to fill before anything happens.
      on: i % 4 === 0,
      degree: 1,
      oct: 0,
      accent: i === 0,
      slide: false,
    })),
    stepsPerBeat: 4,
    scale: "minor",
    octave: 2,
    root: null,
  };
}

/**
 * The actual tonic of a detected key — NOT folded to its relative major.
 *
 * `rootSemitone` in audioAnalysis folds A minor to C, which is right for comparing two
 * stems (same notes, no shift needed) and wrong here: a bassline rooted on C under a track
 * in A minor is playing the wrong note of the right scale. We need the tonic the music
 * actually sits on, and whether it is minor, so the scale matches too.
 */
export function tonicOf(key: string | null | undefined): { semitone: number; minor: boolean } | null {
  if (!key) return null;
  const parts = key.trim().split(/\s+/);
  const scale = (parts[1] ?? "").toLowerCase();
  if (scale.endsWith("?")) return null;
  const NOTES: Record<string, number> = {
    C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
    "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
  };
  const s = NOTES[parts[0]];
  if (s === undefined) return null;
  return { semitone: s, minor: scale.startsWith("min") };
}

/** MIDI note for a step, given the pattern's root. */
export function noteFor(p: Pattern, step: Step, rootSemitone: number): number {
  const scale = SCALES[p.scale] ?? MINOR;
  const idx = Math.max(0, Math.min(scale.length - 1, Math.round(step.degree) - 1));
  return 12 * (p.octave + 1) + rootSemitone + scale[idx] + 12 * step.oct;
}

export const ACCENT_VELOCITY = 112;
export const NORMAL_VELOCITY = 72;


/**
 * Lines to start from.
 *
 * A blank grid is useless to anyone who does not already know the idiom — and knowing the
 * idiom is exactly what a 303 demands and nobody should have to. Pick one of these, hear
 * something good immediately, then move boxes around until it is yours. Every one is in
 * scale degrees, so they all land in the anchor's key whatever that turns out to be.
 *
 * Notation per step: null is a rest, otherwise [degree, octave, accent, slide].
 */
type Terse = null | [number, number, boolean, boolean];

function build(name: string, scale: ScaleName, terse: Terse[]): NamedPattern {
  return {
    name,
    pattern: {
      ...emptyPattern(),
      scale,
      steps: terse.map((t) =>
        t === null
          ? { on: false, degree: 1, oct: 0, accent: false, slide: false }
          : { on: true, degree: t[0], oct: t[1], accent: t[2], slide: t[3] },
      ),
    },
  };
}

export interface NamedPattern { name: string; pattern: Pattern }

const A = true;
const S = true;
const _ = false;

export const STARTERS: NamedPattern[] = [
  // The root on every beat and nothing else. Four on the floor — the plainest thing the
  // box can play, and so the one to reach for when the question is whether it is
  // listening at all rather than what it sounds like.
  build("Four", "minor", [
    [1, 0, A, _], null, null, null,
    [1, 0, _, _], null, null, null,
    [1, 0, A, _], null, null, null,
    [1, 0, _, _], null, null, null,
  ]),
  // Root-heavy and relentless — the one everybody hears as "acid".
  build("Rolling", "minor", [
    [1, 0, A, _], null, [1, 0, _, _], [1, 1, _, _],
    null, [1, 0, _, _], null, [5, 0, _, _],
    [1, 0, A, _], null, [1, 0, _, _], [4, 0, _, _],
    null, [1, 0, _, _], [3, 0, _, S], [1, 0, _, _],
  ]),
  // Walks up and back down. The easiest one to hear the key in.
  build("Climb", "minor", [
    [1, 0, A, _], null, [3, 0, _, _], null,
    [5, 0, _, _], null, [7, 0, _, _], null,
    [1, 1, A, _], null, [7, 0, _, S], null,
    [5, 0, _, _], null, [3, 0, _, _], null,
  ]),
  // Sparse and hard. Leaves room for everything else in the rack.
  build("Stab", "minor", [
    [1, 0, A, _], null, null, null,
    [5, 0, _, _], null, null, null,
    [1, 1, A, _], null, null, null,
    [4, 0, _, _], null, [4, 0, _, _], null,
  ]),
  // Nothing on the beat. The hole where the kick goes is what makes it sit in a track
  // rather than fight it.
  build("Offbeat", "minor", [
    null, [1, 0, A, _], null, null,
    null, [5, 0, _, _], null, null,
    null, [1, 0, A, _], null, null,
    null, [7, 0, _, _], null, null,
  ]),
  // The oldest bass trick there is: the same note, an octave apart, on every eighth.
  build("Octaves", "minor", [
    [1, 0, A, _], null, [1, 1, _, _], null,
    [1, 0, _, _], null, [1, 1, _, _], null,
    [1, 0, A, _], null, [1, 1, _, _], null,
    [1, 0, _, _], null, [1, 1, _, _], null,
  ]),
  // Up the scale and back. Melodic rather than percussive — the one to pick when the
  // track has room for the bass to say something.
  build("Walk", "minor", [
    [1, 0, A, _], null, [3, 0, _, _], null,
    [5, 0, _, _], null, [7, 0, _, S], null,
    [1, 1, A, _], null, [7, 0, _, _], null,
    [5, 0, _, _], null, [3, 0, _, S], null,
  ]),
  // Three notes and a lot of air. Leaves the whole second half of the bar empty, which
  // is where everything else in the rack gets heard.
  build("Sparse", "minor", [
    [1, 0, A, _], null, null, null,
    null, null, [5, 0, _, _], null,
    [1, 0, _, S], null, null, null,
    null, null, null, null,
  ]),
  // Every sixteenth, accented on the beat. Relentless on purpose — turn Decay down and
  // it is a texture rather than a line.
  build("Drive", "minor", [
    [1, 0, A, _], [1, 0, _, _], [1, 0, _, _], [1, 0, _, _],
    [1, 0, A, _], [1, 0, _, _], [1, 0, _, _], [1, 0, _, _],
    [1, 0, A, _], [1, 0, _, _], [1, 0, _, _], [1, 0, _, _],
    [1, 0, A, _], [1, 0, _, _], [3, 0, _, _], [5, 0, _, S],
  ]),
  // A riff with slides in it — the thing people are imitating when they say "303".
  build("Hook", "phrygian", [
    [1, 0, A, _], null, [1, 1, _, S], [7, 0, _, _],
    null, [1, 0, _, _], null, [2, 0, _, S],
    [1, 0, A, _], null, [5, 0, _, _], null,
    [4, 0, _, S], [3, 0, _, _], null, [1, 0, _, _],
  ]),
  // Slides everywhere. This is the one that squelches.
  build("Squelch", "phrygian", [
    [1, 0, A, _], [1, 0, _, S], [3, 0, _, S], [1, 0, _, _],
    null, [5, 0, _, S], [4, 0, _, S], [1, 0, _, _],
    [1, 1, A, _], null, [7, 0, _, S], [5, 0, _, S],
    null, [3, 0, _, S], [2, 0, _, S], [1, 0, _, _],
  ]),
];

const KEY = "vandelay:midi:pattern:v1";

export function loadPattern(deviceId: string): Pattern {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    const got = all?.[deviceId];
    if (!got || !Array.isArray(got.steps)) return emptyPattern();
    // Merge over a fresh pattern so a field added later cannot break an old save.
    return { ...emptyPattern(), ...got };
  } catch { return emptyPattern(); }
}

/** Every device's line, for the state backup. */
export function readAllPatterns(): Record<string, Pattern> {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === "object" ? (all as Record<string, Pattern>) : {};
  } catch { return {}; }
}

export function writeAllPatterns(all: Record<string, Pattern>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota */ }
}

export function savePattern(deviceId: string, p: Pattern): void {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[deviceId] = p;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota */ }
}
