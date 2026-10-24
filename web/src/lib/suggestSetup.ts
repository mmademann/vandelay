import { autoTempoRelation, findHits, isGridSafeRelation, lockingDelays } from "./loopSnap";
import { rootSemitone } from "./audioAnalysis";

/**
 * Rank complete rack setups by how well the loaded stems FIT each other.
 *
 * The honest scope: this measures fit, not taste. Key distance, stretch cost and grid
 * safety are all objectively computable from the audio. Whether two stems sound good
 * together — timbre, arrangement, mood — is not, and nothing here pretends otherwise. So
 * this ranks candidates and the listener picks; it does not choose.
 *
 * Three dimensions are searched, because each changes the result in a way only ears can
 * judge: which stem anchors the tempo, which anchors the key, and which FLAVOUR the rack
 * is dressed in. The flavour is the one that makes two suggestions sound like different
 * records rather than the same record with its loop moved a bar — see FLAVOURS.
 */

export interface SuggestSlot {
  id: string;
  /** Untouched decode — all analysis and all returned positions are in ITS timebase. */
  sourceBuffer: AudioBuffer | null;
  detectedKey: string | null | undefined;
  detectedBpm: number | undefined;
  /** Current loop, in source seconds, for the "keep my loops" option. */
  loopStart: number;
  loopEnd: number;
  /** Drums and bass make better tempo anchors; vocals and pads make worse ones. */
  stemName: string | null;
}

export interface SuggestedLoop { start: number; end: number; bars: number }

/** The tone a flavour writes. Only the two effects that change a rack's character. */
export interface SuggestEffects {
  reverbWet: number;
  reverbDecay: number;
  delayWet: number;
  delayFeedback: number;
}

export interface SuggestCandidate {
  tempoAnchorId: string;
  keyAnchorId: string;
  loops: Map<string, SuggestedLoop>;
  /** Delay time in seconds per slot, locked to the anchor's grid. */
  delays: Map<string, number>;
  /**
   * Tempo relation per slot, and ONLY where the flavour asks for one.
   *
   * A slot absent from this map is to be set back to automatic, not left alone. Suggest
   * used to say nothing at all about this field, so matching honoured whatever relation
   * was stored on the slot from an earlier session — which is why racks kept coming out
   * at two or four times the anchor's tempo with nothing in the suggestion asking for it.
   * Deciding the whole rack means deciding this too.
   */
  relations: Map<string, number>;
  /** Phase offset per slot as a fraction of the anchor's bar. Absent means zero, not "keep". */
  phases: Map<string, number>;
  /** Reverb and echo per slot. Absent means leave the slot's own tone alone. */
  effects: Map<string, SuggestEffects>;
  /** Lower is better. Sum of stretch cost, key distance and off-grid penalties. */
  score: number;
  /** One line naming why this candidate ranks where it does. Also the dedupe key. */
  why: string;
  /** Broken out so the list can lay them out as columns instead of a sentence. */
  label: {
    /** "8 bar", or "your loops" when the user's own regions are kept. */
    loop: string;
    /** Heading this candidate groups under — the biggest decision it makes. */
    tempoGroup: string;
    keyAnchor: string;
    /** 0-1. How much of the spectrum the stems are NOT fighting over. */
    separation: number;
    /** Plain-language name for how this one is dressed: "spacious", "half speed". */
    flavour: string;
  };
}

/**
 * Band edges for the spectral profile, in Hz. Five bands is enough to tell a kick from a
 * hat and a bass from a pad, and few enough to compute with one-pole filters.
 */
const BAND_EDGES = [120, 500, 2000, 6000];

/**
 * Where a stem puts its energy, as five fractions summing to 1.
 *
 * This is the one thing in here that gets close to predicting whether two stems will sit
 * well together, because masking is physics rather than taste: two stems both piled into
 * 200-500Hz will muddy each other however well matched their key and tempo are.
 *
 * One-pole lowpasses rather than an FFT — the question is only "roughly where is the
 * energy", five numbers answer it, and this runs over whole stems.
 */
export function spectralProfile(buffer: AudioBuffer, startSec = 0, endSec = Infinity): number[] {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const from = Math.max(0, Math.floor(startSec * sr));
  const to = Math.min(data.length, Math.ceil((endSec === Infinity ? buffer.duration : endSec) * sr));
  if (to - from < sr * 0.1) return [0.2, 0.2, 0.2, 0.2, 0.2];

  // Running lowpass state, one per edge. Each sample updates every filter, and the band
  // energies are the differences between neighbouring lowpass outputs.
  const a = BAND_EDGES.map((f) => Math.exp((-2 * Math.PI * f) / sr));
  // Two poles per edge, not one. A single pole rolls off at 6dB/octave, which bleeds so
  // much that a 60Hz tone and a 1kHz tone still measured 40% overlap. Cascading two gives
  // 12dB/octave and separates them properly, for one extra multiply per sample.
  const lp1 = new Float64Array(BAND_EDGES.length);
  const lp = new Float64Array(BAND_EDGES.length);
  const sums = new Float64Array(BAND_EDGES.length + 1);

  // Stride over long stems: the profile is a gross shape, and every fourth sample gives
  // the same answer for a quarter of the work.
  const stride = Math.max(1, Math.floor((to - from) / (sr * 30)));
  let n = 0;
  for (let i = from; i < to; i += stride) {
    const x = data[i];
    let prev = 0;
    for (let b = 0; b < lp.length; b++) {
      lp1[b] = (1 - a[b]) * x + a[b] * lp1[b];
      lp[b] = (1 - a[b]) * lp1[b] + a[b] * lp[b];
      const band = lp[b] - prev;   // energy between this edge and the one below
      sums[b] += band * band;
      prev = lp[b];
    }
    const top = x - lp[lp.length - 1];   // everything above the highest edge
    sums[sums.length - 1] += top * top;
    n++;
  }
  if (n === 0) return [0.2, 0.2, 0.2, 0.2, 0.2];

  const rms = Array.from(sums, (v) => Math.sqrt(v / n));
  const total = rms.reduce((x, y) => x + y, 0);
  return total > 0 ? rms.map((v) => v / total) : [0.2, 0.2, 0.2, 0.2, 0.2];
}

/**
 * How much two stems compete for the same frequencies, 0 (disjoint) to 1 (identical).
 *
 * Histogram intersection. Two stems at 1 are fighting for the same space and one of them
 * will be inaudible; two at 0.2 each own their own range and both stay legible.
 */
export function spectralOverlap(a: number[], b: number[]): number {
  let shared = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) shared += Math.min(a[i], b[i]);
  return shared;
}

/**
 * Distance between two keys on the circle of fifths, 0-6.
 *
 * Fifths, not semitones: C and G are one step apart and sound related, while C and C# are
 * one semitone apart and clash. Both keys are already folded to their relative major by
 * rootSemitone, so a minor and its relative major score 0.
 */
export function keyDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const sa = rootSemitone(a);
  const sb = rootSemitone(b);
  if (sa === null || sb === null) return null;
  const fifths = (s: number) => (s * 7) % 12;
  const d = Math.abs(fifths(sa) - fifths(sb)) % 12;
  return Math.min(d, 12 - d);
}

/**
 * How much it costs to stretch `fromBpm` onto `toBpm`, as octaves of distance from unity.
 *
 * SoundTouch degrades with distance from 1, so this is an artifact budget, not an
 * abstraction. The relation fold is applied first, because matching 174 to 87 is free.
 */
export function stretchCost(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return Infinity;
  const relation = autoTempoRelation(fromBpm, toBpm);
  const ratio = fromBpm / (toBpm * relation);
  return Math.abs(Math.log2(ratio)) + (isGridSafeRelation(relation) ? 0 : 0.25);
}

/* ------------------------------------------------------------------ loop length */

/**
 * How long a loop should be, in SECONDS.
 *
 * Bars were the wrong unit to search in. A fixed ladder of 2-8 bars is 4.6s to 18s at 105
 * bpm and 2.7s to 11s at 175 — so the same setting produced a usable dub loop on one stem
 * and a one-bar stutter on another, and the faster the track the worse it got. Seconds is
 * what a listener actually hears, and what the user described wanting: a loop long enough
 * to carry some movement rather than repeat before it has said anything.
 */
const MIN_LOOP_SEC = 10;
const MAX_LOOP_SEC = 30;
/** Bar counts worth offering. 3, 6, 12 and 24 are in because dub does not only count in fours. */
const BAR_LADDER = [2, 3, 4, 6, 8, 12, 16, 24, 32];

/**
 * The bar counts whose length lands in the target window for this stem's tempo.
 *
 * Still whole bars — a loop that is not a whole number of bars never repeats cleanly — but
 * chosen so the RESULT is 10-30s however fast the material is. A 175bpm stem gets 8-24
 * bars where a 70bpm stem gets 3-8, and both come out the same length to the ear.
 */
export function barChoicesFor(bpm: number, durationSec: number): number[] {
  if (!(bpm > 0) || !(durationSec > 0)) return [];
  const barSec = (60 / bpm) * 4;
  // Never more than two thirds of the stem: a loop that is nearly the whole file is not a
  // loop, it is playback.
  const cap = durationSec * 0.67;
  const fits = BAR_LADDER.filter((b) => {
    const len = b * barSec;
    return len >= MIN_LOOP_SEC && len <= MAX_LOOP_SEC && len <= cap;
  });
  if (fits.length > 0) return fits;
  // Nothing in the ladder lands in the window — a very short stem, or a tempo read so far
  // out that every bar count overshoots. Take the closest count that still fits.
  const target = Math.min((MIN_LOOP_SEC + MAX_LOOP_SEC) / 2, cap);
  let best: number | null = null;
  for (const b of BAR_LADDER) {
    if (b * barSec > cap && best !== null) break;
    if (best === null || Math.abs(b * barSec - target) < Math.abs(best * barSec - target)) best = b;
  }
  return best === null ? [] : [best];
}

/* ------------------------------------------------------------------ loudness */

/**
 * A loudness envelope for a whole stem, plus the level it sits at WHEN IT IS PLAYING.
 *
 * Two things here, both of which a first attempt got wrong.
 *
 * The playing level is the 80th percentile frame, not the mean. The mean was the original
 * bug: a stem that is half silence has a mean halfway to zero, so a gate set as a fraction
 * of it waves through windows that are themselves half dead. The percentile ignores how
 * much silence the file happens to contain and answers the only question that matters —
 * how loud is this stem when something is actually happening.
 *
 * And the frames are an ENVELOPE — each one the loudest moment within a second either side
 * — not raw RMS. Raw RMS of a drum stem is bimodal: a kick's energy is over in 25ms, so
 * about half of all quarter-second frames sit at the noise floor between hits, and the
 * MEDIAN of a perfectly good groove lands in that floor. Tested against a synthetic beat
 * the raw version rejected every window in the stem, which is the same failure as picking
 * silence wearing the opposite mask. An envelope is also simply how loudness is heard: a
 * kick reads as loud for longer than its transient lasts.
 */
const FRAME_SEC = 0.25;
/** Seconds either side a frame looks for the loudest moment. One beat at any sane tempo. */
const ENVELOPE_SEC = 1;
const frameCache = new WeakMap<AudioBuffer, { frames: Float64Array; frameSec: number; loud: number }>();

function frameProfile(buffer: AudioBuffer) {
  const hit = frameCache.get(buffer);
  if (hit) return hit;
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.round(FRAME_SEC * sr));
  const count = Math.max(1, Math.floor(data.length / step));
  const raw = new Float64Array(count);
  // A frame is thousands of samples and its level does not need all of them.
  const inner = Math.max(1, Math.floor(step / 512));
  for (let f = 0; f < count; f++) {
    const a = f * step;
    const b = Math.min(data.length, a + step);
    let sum = 0;
    let n = 0;
    for (let i = a; i < b; i += inner) { sum += data[i] * data[i]; n++; }
    raw[f] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  const reach = Math.max(1, Math.round(ENVELOPE_SEC / FRAME_SEC));
  const frames = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let peak = 0;
    for (let k = Math.max(0, f - reach); k <= Math.min(count - 1, f + reach); k++) {
      if (raw[k] > peak) peak = raw[k];
    }
    frames[f] = peak;
  }
  const sorted = Array.from(frames).sort((x, y) => x - y);
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))] || 0;
  const out = { frames, frameSec: step / sr, loud };
  frameCache.set(buffer, out);
  return out;
}

/**
 * Below this the stem is not quiet, it is empty.
 *
 * Every other test in here is RELATIVE to the stem's own playing level, deliberately — an
 * absolute floor would reject a quiet pad outright. But relative tests have no opinion
 * about a stem that is nothing but noise: its own noise IS its playing level, so every
 * window passes and the search hands back a confident loop of hiss. About -54dBFS, which
 * is tens of dB below the quietest real material and only catches genuine emptiness.
 */
const SILENCE_FLOOR = 0.002;
/** A frame this far below the playing level counts as nothing happening. */
const DEAD_FRAME = 0.12;
/** The typical moment in the window has to be at least this loud. */
const MIN_MEDIAN = 0.45;
/** And no more than this much of it may be dead. */
const MAX_DEAD = 0.2;

/* ------------------------------------------------------------------ loop search */

/**
 * The best `count` loop positions at a given bar length, best first.
 *
 * Scoring, in order of weight: is it PLAYING, is it BUSY, is it STEADY. That order is the
 * whole fix. It used to be the other way up — steadiness was the heaviest term by a factor
 * of two, and nothing on earth is steadier than near-silence: eight lonely hits are
 * perfectly evenly spaced and scored a flat 1.0, while a real groove with human timing
 * scored 0.6. Empty passages did not slip through the ranking, they won it.
 *
 * A stem with no hits at all is not a failure case — that is a pad, and the right loop for
 * a pad is simply its loudest stretch, so hits drop out of the score rather than
 * disqualifying it.
 */
export function rankLoops(
  buffer: AudioBuffer,
  bpm: number | undefined,
  bars: number,
  count: number,
): SuggestedLoop[] {
  const dur = buffer.duration;
  if (!bpm || !(bpm > 0)) return [];
  const barSec = (60 / bpm) * 4;
  const len = Math.min(barSec * bars, dur);
  if (!(len > 0)) return [];

  const { frames, frameSec, loud } = frameProfile(buffer);
  if (loud < SILENCE_FLOOR) return [];

  const hits = findHits(buffer, 0, dur);
  // Below this there is no rhythm to measure and the density/evenness terms are noise.
  const useHits = hits.length >= 8;

  /** Median level and dead fraction of one window, both relative to the playing level. */
  const levelOf = (from: number, to: number) => {
    const a = Math.max(0, Math.floor(from / frameSec));
    const b = Math.min(frames.length, Math.ceil(to / frameSec));
    if (b <= a) return { median: 0, dead: 1 };
    const slice = Array.from(frames.slice(a, b)).sort((x, y) => x - y);
    const median = slice[Math.floor(slice.length / 2)];
    let deadCount = 0;
    for (const v of slice) if (v < loud * DEAD_FRAME) deadCount++;
    return { median: median / loud, dead: deadCount / slice.length };
  };

  const scored: { start: number; score: number }[] = [];
  for (let s = 0; s + len <= dur + 1e-6; s += barSec) {
    const { median, dead } = levelOf(s, s + len);
    // The typical moment has to be playing, and the window must not be mostly a gap. The
    // median does the work a mean could not: a window that is half groove and half silence
    // has a healthy mean and a median down in the silence, which is exactly the window
    // that kept getting picked.
    if (median < MIN_MEDIAN) continue;
    if (dead > MAX_DEAD) continue;

    const inWin = useHits ? hits.filter((t) => t >= s && t < s + len) : [];
    // At least two hits PER BAR, not two in the window — a long window used to clear the
    // same bar as a short one on the same two hits.
    if (useHits && inWin.length < bars * 2) continue;

    let evenness = 0;
    let density = 0;
    if (useHits && inWin.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < inWin.length; i++) gaps.push(inWin[i] - inWin[i - 1]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const varc = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
      // Coefficient of variation: scale-free, so a half-time groove is not punished for
      // having longer gaps than a busy one.
      evenness = mean > 0 ? 1 / (1 + Math.sqrt(varc) / mean) : 0;
      density = Math.min(inWin.length / (len / barSec) / 4, 1);
    }

    // Loud first, busy second, steady third. Energy is allowed past 1 up to 1.5 so a
    // genuinely strong section outranks a merely adequate one.
    const energy = Math.min(median, 1.5) / 1.5;
    const score = energy * 3 + density * 2 + evenness;
    scored.push({ start: s, score });
  }
  // No window at this length is playing enough to be worth looping. Returning bar 0 here
  // would hand back the intro — exactly the empty section the gate above just rejected.
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  // Spread the picks out: the windows either side of the best one overlap it almost
  // entirely and would fill the list with the same loop nudged a bar.
  const picked: SuggestedLoop[] = [];
  for (const cand of scored) {
    if (picked.some((p) => Math.abs(p.start - cand.start) < len * 0.5)) continue;
    picked.push({ start: cand.start, end: cand.start + len, bars });
    if (picked.length >= count) break;
  }
  return picked;
}

/**
 * The best loop region in a stem, as a whole number of bars.
 *
 * Length is chosen for this stem's own tempo so the result lands in the target seconds
 * window rather than at a fixed bar count — see barChoicesFor.
 */
export function bestLoop(buffer: AudioBuffer, bpm: number | undefined): SuggestedLoop {
  const dur = buffer.duration;
  if (!bpm || !(bpm > 0)) return { start: 0, end: dur, bars: 0 };
  const choices = barChoicesFor(bpm, dur);
  for (const bars of [...choices].reverse()) {
    const ranked = rankLoops(buffer, bpm, bars, 1);
    if (ranked.length > 0) return ranked[0];
  }
  return { start: 0, end: dur, bars: 0 };
}

/* ------------------------------------------------------------------ flavours */

/**
 * How a rack is dressed. The reason two suggestions sound different.
 *
 * Before this, every candidate set the same longest-available delay and no tone at all, so
 * the only thing that varied between thirty rows was which stem anchored what and where a
 * loop started — real differences on paper, nearly inaudible in the room. A flavour writes
 * values you can hear: how much echo and how long, how much space, whether one stem runs
 * at half or double the others, whether one sits off the beat, and whether the loops are
 * all the same length or deliberately staggered.
 *
 * Everything here is reversible with one click and visible on the knobs afterwards, so a
 * flavour is a starting point to tweak rather than a decision taken away from the user.
 */
interface Flavour {
  /** Shown in the list. Plain words — a flavour nobody can picture is no use. */
  name: string;
  /** Where in the available locked delays to sit: 0 shortest, 1 longest. */
  delayPick: number;
  tone: SuggestEffects;
  /** Put the least percussive non-anchor stem at this relation to the anchor. */
  relation?: number;
  /** Offset the least percussive non-anchor stem by this fraction of a bar. */
  phase?: number;
  /** Give each stem a different loop length instead of one shared length. */
  stagger?: boolean;
  /** Prefer the longest lengths on offer. */
  longLoops?: boolean;
}

const FLAVOURS: Flavour[] = [
  {
    name: "tight",
    delayPick: 0,
    tone: { reverbWet: 0.28, reverbDecay: 2.2, delayWet: 0.32, delayFeedback: 0.22 },
  },
  {
    name: "spacious",
    delayPick: 1,
    longLoops: true,
    tone: { reverbWet: 0.62, reverbDecay: 7.5, delayWet: 0.6, delayFeedback: 0.55 },
  },
  {
    name: "half speed",
    delayPick: 1,
    relation: 0.5,
    tone: { reverbWet: 0.52, reverbDecay: 6, delayWet: 0.52, delayFeedback: 0.45 },
  },
  {
    name: "double speed",
    delayPick: 0,
    relation: 2,
    tone: { reverbWet: 0.34, reverbDecay: 3, delayWet: 0.42, delayFeedback: 0.3 },
  },
  {
    name: "layered",
    delayPick: 0.5,
    stagger: true,
    longLoops: true,
    tone: { reverbWet: 0.45, reverbDecay: 4.5, delayWet: 0.45, delayFeedback: 0.38 },
  },
  {
    name: "offbeat",
    delayPick: 0.5,
    phase: 0.5,
    tone: { reverbWet: 0.48, reverbDecay: 4, delayWet: 0.55, delayFeedback: 0.42 },
  },
];

/** A tempo anchor should be something with a clear pulse. */
function anchorAffinity(stemName: string | null): number {
  if (stemName === "drums") return -0.6;
  if (stemName === "bass") return -0.3;
  if (stemName === "vocals") return 0.5;
  return 0;
}

/**
 * How percussive a stem is.
 *
 * Decides which stem a flavour picks on. Half speed and offbeat go to the LEAST percussive
 * stem available: dragging a vocal or a pad behind the beat is the dub move, while doing it
 * to the bass just sounds broken against the drums.
 */
function pulseRank(stemName: string | null): number {
  if (stemName === "drums") return 3;
  if (stemName === "bass") return 2;
  if (stemName === "other") return 1;
  return 0;
}

export interface SuggestOptions {
  /** Keep whatever loops the user has already drawn, and only decide the rest. */
  keepLoops?: boolean;
  /** Ceiling for a delay time, from the knob's own range. */
  maxDelaySec: number;
}

/** Loop positions per stem per bar length. Beyond a few the list fills with near-twins. */
const POSITIONS_PER_LENGTH = 2;
/** Shown at most. Past this the ranking is noise and the list is unreadable. */
const MAX_CANDIDATES = 30;
/**
 * At most this many rows per tempo anchor and flavour pairing.
 *
 * Without it the top of the list is a dozen variants of one idea and the genuinely
 * different flavours fall off the bottom — the exact complaint that every suggestion
 * sounded the same.
 */
const MAX_PER_IDEA = 2;
/** Below a quarter beat a delay is a flam rather than an echo. */
const MIN_DELAY_BEATS = 0.25;

export function suggestSetups(slots: SuggestSlot[], opts: SuggestOptions): SuggestCandidate[] {
  const usable = slots.filter((s) => s.sourceBuffer && s.detectedBpm && s.detectedBpm > 0);
  if (usable.length < 2) return [];

  // Loop options per stem, computed ONCE and reused across every candidate — this is the
  // expensive half, and the search would otherwise redo it for each combination.
  // Ordered shortest to longest so a flavour can ask for either end.
  const loopOptions = new Map<string, SuggestedLoop[]>();
  for (const s of usable) {
    if (opts.keepLoops && s.loopEnd > s.loopStart) {
      loopOptions.set(s.id, [{ start: s.loopStart, end: s.loopEnd, bars: 0 }]);
      continue;
    }
    const all: SuggestedLoop[] = [];
    for (const bars of barChoicesFor(s.detectedBpm!, s.sourceBuffer!.duration)) {
      all.push(...rankLoops(s.sourceBuffer!, s.detectedBpm, bars, POSITIONS_PER_LENGTH));
    }
    loopOptions.set(s.id, all.length > 0 ? all : [{ start: 0, end: s.sourceBuffer!.duration, bars: 0 }]);
  }

  // Spectral profiles keyed by stem AND loop, so a profile is computed once however many
  // candidates reference that same region.
  const profileCache = new Map<string, number[]>();
  const profileFor = (slot: SuggestSlot, loop: SuggestedLoop) => {
    const k = `${slot.id}|${loop.start.toFixed(3)}|${loop.end.toFixed(3)}`;
    let p = profileCache.get(k);
    if (!p) {
      p = spectralProfile(slot.sourceBuffer!, loop.start, loop.end);
      profileCache.set(k, p);
    }
    return p;
  };

  // Key anchor is its own dimension now rather than a derived best: which stem defines the
  // key genuinely changes the result, and which one is better is a question for ears.
  const keyCandidates = usable.filter((s) => rootSemitone(s.detectedKey ?? "") !== null);
  const keyChoices = keyCandidates.length > 0 ? keyCandidates : [usable[0]];

  const candidates: SuggestCandidate[] = [];
  for (const anchor of usable) {
    const anchorBpm = anchor.detectedBpm!;
    const beatSec = 60 / anchorBpm;
    let tempoCost = 0;
    for (const s of usable) {
      if (s.id === anchor.id) continue;
      tempoCost += stretchCost(s.detectedBpm!, anchorBpm);
    }

    // The stem a flavour acts on: least percussive that is not the anchor, so half speed
    // and offbeat land on a vocal or a pad rather than on the kick.
    const others = usable.filter((s) => s.id !== anchor.id);
    const feature = others.length > 0
      ? others.reduce((a, b) => (pulseRank(b.stemName) < pulseRank(a.stemName) ? b : a))
      : null;

    for (const keyAnchor of keyChoices) {
      let keyCost = 0;
      let known = 0;
      for (const s of usable) {
        if (s.id === keyAnchor.id) continue;
        const d = keyDistance(keyAnchor.detectedKey, s.detectedKey);
        if (d === null) continue;
        keyCost += d;
        known++;
      }
      const keyNorm = known > 0 ? keyCost / known : 2;

      for (const flavour of FLAVOURS) {
        // One candidate per loop-option INDEX rather than the full cross product: with five
        // stems the product is thousands of racks that differ only in one stem's loop, and
        // the ranking cannot tell them apart in any way a listener would care about.
        const maxOptions = Math.max(...usable.map((s) => loopOptions.get(s.id)!.length));
        for (let optIdx = 0; optIdx < maxOptions; optIdx++) {
          const loops = new Map<string, SuggestedLoop>();
          usable.forEach((s, stemIdx) => {
            const list = loopOptions.get(s.id)!;
            // Stagger walks each stem a different distance down the list, so the rack ends
            // up with deliberately mismatched loop lengths and evolves instead of locking
            // into one repeat. Long loops reads from the far end, which is the longest.
            let idx = optIdx;
            if (flavour.stagger) idx = optIdx + stemIdx * 2;
            if (flavour.longLoops) idx = list.length - 1 - (optIdx % list.length);
            loops.set(s.id, list[((idx % list.length) + list.length) % list.length]);
          });

          let overlapSum = 0;
          let pairs = 0;
          for (let i = 0; i < usable.length; i++) {
            for (let j = i + 1; j < usable.length; j++) {
              overlapSum += spectralOverlap(
                profileFor(usable[i], loops.get(usable[i].id)!),
                profileFor(usable[j], loops.get(usable[j].id)!),
              );
              pairs++;
            }
          }
          const masking = pairs > 0 ? overlapSum / pairs : 0;

          // Relations first: the delay has to lock to whatever tempo the slot ends up at,
          // so a stem the flavour has put at half speed needs half speed's delay grid.
          const relations = new Map<string, number>();
          if (flavour.relation !== undefined && feature) relations.set(feature.id, flavour.relation);

          const phases = new Map<string, number>();
          if (flavour.phase !== undefined && feature) phases.set(feature.id, flavour.phase);

          const effects = new Map<string, SuggestEffects>();
          const delays = new Map<string, number>();
          for (const s of usable) {
            const relation = relations.get(s.id)
              ?? (s.id === anchor.id ? 1 : autoTempoRelation(s.detectedBpm!, anchorBpm));
            const locked = lockingDelays(relation).filter((b) => b * beatSec <= opts.maxDelaySec);
            // Prefer real echoes over flams, but fall back rather than offering nothing.
            const usableDelays = locked.filter((b) => b >= MIN_DELAY_BEATS);
            const pool = usableDelays.length > 0 ? usableDelays : locked;
            if (pool.length > 0) {
              const sorted = [...pool].sort((a, b) => a - b);
              const at = Math.round(flavour.delayPick * (sorted.length - 1));
              delays.set(s.id, sorted[at] * beatSec);
            }
            effects.set(s.id, flavour.tone);
          }

          const score = tempoCost + keyNorm * 0.4 + masking * 1.5 + anchorAffinity(anchor.stemName);
          const barsSeen = [...loops.values()].map((l) => l.bars).filter((b) => b > 0);
          const barLabel = barsSeen.length > 0
            ? `${Math.min(...barsSeen)}${Math.max(...barsSeen) !== Math.min(...barsSeen) ? `-${Math.max(...barsSeen)}` : ""} bar`
            : "your loops";
          const tempoGroup = `${anchor.stemName ?? "full track"} · ${Math.round(anchorBpm)} bpm`;
          const keyName = keyAnchor.stemName ?? "full track";
          candidates.push({
            tempoAnchorId: anchor.id,
            keyAnchorId: keyAnchor.id,
            loops,
            delays,
            relations,
            phases,
            effects,
            score,
            why: `${flavour.name} · ${barLabel} · tempo ${tempoGroup} · key ${keyName}`,
            label: {
              loop: barLabel,
              tempoGroup,
              keyAnchor: keyName,
              separation: 1 - masking,
              flavour: flavour.name,
            },
          });
        }
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  // Drop near-twins, and cap how many rows one idea may take. Score alone filled the top of
  // the list with variants of a single tempo anchor and flavour, which is what made thirty
  // suggestions read as one suggestion.
  const kept: SuggestCandidate[] = [];
  const perIdea = new Map<string, number>();
  for (const c of candidates) {
    if (kept.some((k) => k.why === c.why)) continue;
    const idea = `${c.tempoAnchorId}|${c.label.flavour}`;
    const seen = perIdea.get(idea) ?? 0;
    if (seen >= MAX_PER_IDEA) continue;
    perIdea.set(idea, seen + 1);
    kept.push(c);
    if (kept.length >= MAX_CANDIDATES) break;
  }
  return kept;
}
