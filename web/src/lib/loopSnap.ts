/**
 * Seamless-loop snapping.
 *
 * A loop clicks or drifts for two independent reasons, and both need fixing:
 *
 *  1. Length. If the region isn't a whole number of beats, every pass lands a little
 *     earlier or later against the pulse and the loop audibly walks. Fixed by rounding
 *     the duration to a whole bar (or beat) derived from the detected BPM.
 *  2. Splice. Even a perfectly timed cut pops if the waveform is mid-swing at either
 *     end, because the jump from end-sample to start-sample is a step discontinuity.
 *     Fixed by nudging each endpoint a few ms to the nearest zero crossing.
 *
 * These are separable: without a BPM we can still do (2), which kills the click even
 * though the loop may drift.
 */

/** How far a zero-crossing search may wander from the requested point. */
const ZERO_SEARCH_MS = 12;

export type SnapMode = "grid" | "zero-only";

/**
 * Why grid snapping was skipped. All of these still return a zero-crossing-aligned loop
 * — the click is fixed either way — but they need different wording, because the user's
 * next move differs: an undetectable tempo is not the same problem as a region that
 * runs past the end of the audio.
 */
export type SnapReason =
  /** No tempo was supplied and none could be measured from the audio. */
  | "no-tempo"
  /** A tempo exists, but the region can't fit a whole bar before the buffer ends. */
  | "no-room"
  /** The region is too short to hold even a single beat at this tempo. */
  | "too-short";

export interface SnapResult {
  loopStart: number;
  loopEnd: number;
  mode: SnapMode;
  /** Bars the snapped region spans — only set for mode "grid" when it rounded to bars. */
  bars?: number;
  /** Beats spanned — set instead of `bars` for sub-bar regions rounded to whole beats. */
  beats?: number;
  /** Present only when mode is "zero-only": which fallback path was taken. */
  reason?: SnapReason;
}

/**
 * Nearest zero crossing to `time`, searched outward in both directions.
 * Falls back to the input when the window holds no crossing (e.g. silence or DC).
 */
export function nearestZeroCrossing(buffer: AudioBuffer, time: number): number {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const center = Math.round(time * sr);
  const window = Math.round((ZERO_SEARCH_MS / 1000) * sr);

  if (center <= 0 || center >= data.length - 1) return time;

  for (let off = 0; off <= window; off++) {
    for (const i of off === 0 ? [center] : [center - off, center + off]) {
      if (i <= 0 || i >= data.length - 1) continue;
      // A sign change between neighbours brackets a crossing; treat an exact 0 as one too.
      const a = data[i - 1];
      const b = data[i];
      if (a === 0 || (a < 0) !== (b < 0)) return i / sr;
    }
  }
  return time;
}

/**
 * Snap a loop region so it loops cleanly.
 *
 * The start is treated as the anchor and only moves by the sub-millisecond amount that
 * zero-crossing alignment needs — a deliberately chosen point in the track shouldn't
 * jump somewhere else. The end absorbs the musical rounding.
 */
export function snapLoop(
  buffer: AudioBuffer,
  loopStart: number,
  loopEnd: number,
  bpm: number | undefined,
  opts: { beatsPerBar?: number } = {},
): SnapResult {
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const dur = buffer.duration;
  const start = nearestZeroCrossing(buffer, Math.max(0, loopStart));

  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) {
    const end = nearestZeroCrossing(buffer, Math.min(dur, loopEnd));
    return { loopStart: start, loopEnd: end, mode: "zero-only", reason: "no-tempo" };
  }

  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  const span = loopEnd - start;
  const zeroOnly = (reason: SnapReason): SnapResult => ({
    loopStart: start,
    loopEnd: nearestZeroCrossing(buffer, Math.min(dur, loopEnd)),
    mode: "zero-only",
    reason,
  });

  // Below half a beat there is nothing musical to round to; forcing it up to a full
  // beat would silently double a deliberately tiny region.
  if (span < beatSec * 0.5) return zeroOnly("too-short");

  // Round to whole bars, or to whole beats for sub-bar regions — a one-bar minimum
  // would balloon a loop that was deliberately short.
  const useBars = span >= barSec * 0.75;
  const unit = useBars ? barSec : beatSec;
  let count = Math.max(1, Math.round(span / unit));

  // Drop whole units until the region fits inside the buffer.
  while (count > 1 && start + count * unit > dur) count -= 1;
  // Even one unit overruns: this is a room problem, not a length problem.
  if (start + count * unit > dur) return zeroOnly("no-room");

  const target = count * unit;

  // Zero-align the end, but keep it near the grid: a crossing search that wandered a
  // full window would reintroduce the drift the rounding just removed.
  const gridEnd = start + target;
  const zeroEnd = nearestZeroCrossing(buffer, gridEnd);
  const end = Math.abs(zeroEnd - gridEnd) <= ZERO_SEARCH_MS / 1000 ? zeroEnd : gridEnd;

  return useBars
    ? { loopStart: start, loopEnd: end, mode: "grid", bars: count }
    : { loopStart: start, loopEnd: end, mode: "grid", beats: count };
}

/**
 * Estimate tempo directly from the buffer via onset autocorrelation.
 *
 * This exists as a fallback for when Essentia has no cached BPM for a stem: the snap is
 * useless without a tempo, and re-running the whole WASM analysis just to get one number
 * is heavy. Only needs an energy envelope and a lag search, so it runs in a few ms.
 */
export function estimateBpm(
  buffer: AudioBuffer,
  range: { min: number; max: number } = { min: 70, max: 180 },
): number | undefined {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);

  // Envelope at ~172 Hz: fine enough to place onsets, coarse enough to stay cheap.
  const hop = Math.max(1, Math.round(sr / 172));
  const frames = Math.floor(data.length / hop);
  if (frames < 64) return undefined;

  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    const start = f * hop;
    for (let i = start; i < start + hop && i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    env[f] = peak;
  }

  // Half-wave-rectified difference: keeps energy increases (attacks), discards decays.
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = env[f] - env[f - 1];
    flux[f] = d > 0 ? d : 0;
  }

  let mean = 0;
  for (let f = 0; f < frames; f++) mean += flux[f];
  mean /= frames;
  if (mean <= 0) return undefined;
  for (let f = 0; f < frames; f++) flux[f] -= mean;

  const envRate = sr / hop;
  const minLag = Math.floor((60 / range.max) * envRate);
  const maxLag = Math.ceil((60 / range.min) * envRate);
  if (maxLag >= frames) return undefined;

  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = 0; f + lag < frames; f++) sum += flux[f] * flux[f + lag];
    // Normalise by overlap so long lags aren't penalised for having fewer terms.
    const score = sum / (frames - lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestScore <= 0) return undefined;

  let bpm = (60 * envRate) / bestLag;
  // Autocorrelation locks onto multiples as readily as the true pulse; fold into a
  // musically typical band so half/double-time picks don't skew the bar length.
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  return Math.round(bpm);
}

/**
 * Round a loop to a whole number of bars at an externally supplied tempo.
 *
 * Distinct from snapLoop, which derives the grid from the slot's own audio. Here the grid
 * comes from the tempo anchor, so every slot lands on the *same* grid — that is what makes
 * a shared downbeat meaningful. Without this, two slots can both be "snapped" and still
 * drift apart, because each rounded to its own detected tempo.
 *
 * Returns null when the region cannot be placed on the grid at all, so the caller can
 * report which slots were left alone rather than silently mangling them.
 */
export function quantizeToGrid(
  buffer: AudioBuffer,
  loopStart: number,
  loopEnd: number,
  bpm: number,
  opts: { beatsPerBar?: number } = {},
): { loopStart: number; loopEnd: number; bars: number } | null {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;

  const beatsPerBar = opts.beatsPerBar ?? 4;
  const barSec = (60 / bpm) * beatsPerBar;
  const dur = buffer.duration;
  const start = nearestZeroCrossing(buffer, Math.max(0, loopStart));
  const span = loopEnd - start;
  if (span <= 0) return null;

  // Round to the nearest whole bar, with a one-bar floor: a sub-bar region has no shorter
  // grid unit to land on here, since the whole point is agreeing with the other slots.
  let bars = Math.max(1, Math.round(span / barSec));
  while (bars > 1 && start + bars * barSec > dur) bars -= 1;
  if (start + bars * barSec > dur) return null;

  const gridEnd = start + bars * barSec;
  const zeroEnd = nearestZeroCrossing(buffer, gridEnd);
  // Keep the end on the grid unless a crossing sits very close by; wandering further would
  // reintroduce exactly the drift this is removing.
  const end = Math.abs(zeroEnd - gridEnd) <= ZERO_SEARCH_MS / 1000 ? zeroEnd : gridEnd;

  return { loopStart: start, loopEnd: end, bars };
}

/**
 * Musical delay divisions, as a multiple of a beat.
 *
 * A delay set in raw seconds smears against the pulse: the repeats land between beats and
 * the echo fights the groove instead of reinforcing it. Snapping to these makes the echo
 * land on the grid every time.
 */
/**
 * Tempo relationships a matched slot may sit at, as a multiple of the anchor's heard tempo.
 *
 * 1:1 is "play at the anchor's tempo" and is what Match Tempos picks unless told otherwise.
 * The rest exist because beat detection routinely lands on the wrong multiple — half-time and
 * double-time are the classic failures, which is why every DJ tool ships a divide/multiply
 * button rather than trusting its own analysis. Stepping through this list is that button.
 *
 * Ordered ascending so stepping is monotonic. 1/2 and 2 keep the slot's bar a whole multiple
 * of the anchor's, so they stay on the shared grid; 3/4 and 4/3 are genuinely polymetric and
 * put the slot on a related-but-different one (4 of its bars per 3 of the anchor's).
 */
export const TEMPO_RELATIONS: {
  /** Compact form for the badge, where there is only room for a word. */
  label: string;
  /** What you will actually hear. Ratio notation means nothing unless you already think in it. */
  name: string;
  value: number;
  gridSafe: boolean;
  /**
   * `value` as a fraction in lowest terms. Kept alongside the decimal because the two
   * numbers that decide how a relation *feels* both come straight out of it: the slot's
   * beat grid meets the anchor's every `q` anchor beats, and the finest pulse both grids
   * divide evenly is one `p`th of an anchor beat. See sharedTickBeats.
   */
  p: number;
  q: number;
}[] = [
  // Named by direction and amount, not by "half time" / "double time". Those are the
  // musician's words for it, but they make you stop and work out half of what.
  // Direction first, so the list reads as one slow-to-fast run and you can find the half
  // you want before reading any numbers. The list is ordered to match.
  { label: "4× slow", name: "4× slower",     value: 1 / 4, gridSafe: true,  p: 1, q: 4 },
  { label: "2× slow", name: "2× slower",     value: 1 / 2, gridSafe: true,  p: 1, q: 2 },
  { label: "¾",       name: "¾ speed",       value: 3 / 4, gridSafe: false, p: 3, q: 4 },
  { label: "anchor",  name: "Anchor tempo",  value: 1,     gridSafe: true,  p: 1, q: 1 },
  { label: "1⅓",      name: "1⅓ speed",      value: 4 / 3, gridSafe: false, p: 4, q: 3 },
  { label: "2× fast", name: "2× faster",     value: 2,     gridSafe: true,  p: 2, q: 1 },
  { label: "4× fast", name: "4× faster",     value: 4,     gridSafe: true,  p: 4, q: 1 },
];

/**
 * The finest pulse the anchor and a slot at this relation both divide evenly, in anchor
 * beats. One `p`th of a beat, where the relation is `p/q` in lowest terms.
 *
 * This is the number that decides whether a delay sounds welded to the rack or merely near
 * it. At 4/3 the anchor's beat splits into 4 and the slot's into 3, and both land on the
 * same 179ms tick at 84bpm — a delay set there reinforces a grid both tracks already share.
 * A delay one rung away (0.375) still divides the slot's beat but not the anchor's, and the
 * echoes fight the kick.
 */
export function sharedTickBeats(relation: number): number {
  let best = TEMPO_RELATIONS[0];
  for (const r of TEMPO_RELATIONS) {
    if (Math.abs(r.value - relation) < Math.abs(best.value - relation)) best = r;
  }
  return 1 / best.p;
}

/**
 * Delay times, in anchor beats, that land on BOTH beat grids at this relation.
 *
 * A delay locks when it divides one anchor beat a whole number of times AND divides the
 * slot's beat (`q/p` anchor beats) a whole number of times. The coarsest is the shared tick;
 * the rest are its subdivisions that survive the same test.
 */
export function lockingDelays(relation: number): number[] {
  let best = TEMPO_RELATIONS[0];
  for (const r of TEMPO_RELATIONS) {
    if (Math.abs(r.value - relation) < Math.abs(best.value - relation)) best = r;
  }
  const slotBeat = best.q / best.p;
  const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-9;
  return DELAY_DIVISIONS.map((d) => d.beats).filter((b) => whole(1 / b) && whole(slotBeat / b));
}

/** Anchor beats between the two grids meeting — the denominator, by construction. */
export function coincidenceBeats(relation: number): number {
  let best = TEMPO_RELATIONS[0];
  for (const r of TEMPO_RELATIONS) {
    if (Math.abs(r.value - relation) < Math.abs(best.value - relation)) best = r;
  }
  return best.q;
}

/**
 * Buffer-length ratio that makes `targetBpm` play at `anchorBpm * relation`.
 *
 * Stretching to ratio r makes the audio r times longer, so its tempo drops by r. To land on
 * a wanted tempo w from a source tempo t, r = t / w. At relation 1 that is exactly "play at
 * the anchor's tempo"; at 1/2 it is half-time, and so on.
 */
export function stretchForRelation(targetBpm: number, anchorBpm: number, relation: number): number {
  const want = anchorBpm * relation;
  if (!Number.isFinite(want) || want <= 0) return 1;
  const r = targetBpm / want;
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/**
 * The relation Match Tempos picks on its own: the one needing the least time stretch.
 *
 * This generalises the octave fold it replaces. `raw / 2^round(log2(raw))` was exactly
 * "choose the power-of-two relation closest to unity stretch" — same rule, a wider set. So a
 * rack that only ever wanted 1:1 or a half/double-time correction behaves as it did before.
 *
 * Least-stretch is the right default because every stretch is an artifact budget: SoundTouch
 * degrades with distance from 1, so the nearest relation is both the cleanest-sounding and
 * the least likely to be a detection error amplified into audible damage.
 */
export function autoTempoRelation(targetBpm: number, anchorBpm: number): number {
  const raw = targetBpm / anchorBpm;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  // The nearest power of two, unbounded — the octave fold this replaced, expressed as a
  // relation. Rounding the log2 guarantees exactly one answer per input and a stretch always
  // inside [1/√2, √2], however far apart the two tempos are. Searching TEMPO_RELATIONS
  // instead was tried and is wrong twice over: the ladder is finite, so an extreme ratio
  // cannot fold far enough, and 3:4 / 4:3 almost always need a SMALLER stretch than 1:1, so
  // including them would quietly make polymeter the default. They are reachable by stepping,
  // which is a deliberate act.
  return Math.pow(2, Math.round(Math.log2(raw)));
}

/**
 * Whether this relation keeps the slot's bar a whole multiple of the anchor's.
 *
 * Quantize rounds loops to whole bars of a grid derived from the anchor. That grid is only
 * meaningful for a slot sharing the anchor's bar, so a polymetric slot must be left out of
 * it rather than rounded to a length that does not repeat cleanly.
 */
export function isGridSafeRelation(relation: number): boolean {
  let best = TEMPO_RELATIONS[0];
  for (const r of TEMPO_RELATIONS) {
    if (Math.abs(r.value - relation) < Math.abs(best.value - relation)) best = r;
  }
  return best.gridSafe;
}

/** Nearest entry in TEMPO_RELATIONS to an arbitrary value, for labelling a restored slot. */
export function tempoRelationLabel(relation: number): string {
  let best = TEMPO_RELATIONS[0];
  for (const r of TEMPO_RELATIONS) {
    if (Math.abs(r.value - relation) < Math.abs(best.value - relation)) best = r;
  }
  return best.label;
}

export const DELAY_DIVISIONS: { label: string; beats: number }[] = [
  // Both namings, beats first: the number is the length ("0.5" of a beat) and the note value
  // after it is the name the rest of the world uses for that length ("1/8"). Beats alone
  // needed no decoding but could not be matched against a pedal or a DAW; note values alone
  // are only a length if you read music, since an eighth NOTE is half a beat. Ordered by
  // length, ascending — the arrow keys step by index, so an out-of-order entry would make a
  // keypress jump backwards.
  //
  // Three families, interleaved by length: plain notes, their dotted forms at 1.5x and their
  // triplets at 2/3. 4 beats is a bar.
  { label: "0.06 · 1/64", beats: 0.0625 },
  { label: "0.08 · 1/32 trip", beats: 1 / 12 },
  { label: "0.125 · 1/32", beats: 0.125 },
  { label: "0.17 · 1/16 trip", beats: 1 / 6 },
  { label: "0.19 · 1/32 dot", beats: 0.1875 },
  { label: "0.25 · 1/16", beats: 0.25 },
  { label: "0.33 · 1/8 trip", beats: 1 / 3 },
  { label: "0.375 · 1/16 dot", beats: 0.375 },
  { label: "0.5 · 1/8", beats: 0.5 },
  { label: "0.67 · 1/4 trip", beats: 2 / 3 },
  { label: "0.75 · 1/8 dot", beats: 0.75 },
  { label: "1 · 1/4", beats: 1 },
  { label: "1.33 · 1/2 trip", beats: 4 / 3 },
  { label: "1.5 · 1/4 dot", beats: 1.5 },
  { label: "2 · 1/2", beats: 2 },
  { label: "2.67 · 1 bar trip", beats: 8 / 3 },
  { label: "3 · 1/2 dot", beats: 3 },
  { label: "4 · 1 bar", beats: 4 },
  { label: "5.33 · 2 bar trip", beats: 16 / 3 },
  { label: "6 · 1 bar dot", beats: 6 },
  { label: "8 · 2 bars", beats: 8 },
  { label: "12 · 3 bars", beats: 12 },
  { label: "16 · 4 bars", beats: 16 },
];

/**
 * Nearest musical division to a delay time in seconds.
 *
 * Returns the snapped seconds alongside its label so the UI can show what it landed on —
 * "1/8 · 250ms" tells you far more than "0.25s". Null when there is no tempo to snap to,
 * or when the nearest division falls outside the delay's own range.
 */
export function snapDelayToTempo(
  seconds: number,
  bpm: number | undefined,
  maxSeconds: number,
): { seconds: number; label: string; beats: number } | null {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  const beatSec = 60 / bpm;

  let best: { seconds: number; label: string; beats: number } | null = null;
  let bestErr = Infinity;
  for (const d of DELAY_DIVISIONS) {
    const secs = d.beats * beatSec;
    if (secs > maxSeconds) continue;
    const err = Math.abs(secs - seconds);
    if (err < bestErr) {
      bestErr = err;
      best = { seconds: secs, label: d.label, beats: d.beats };
    }
  }
  return best;
}

/**
 * Phase offsets, as a fraction of a bar.
 *
 * Shifting a slot by one of these makes it land between the anchor's beats rather than on
 * top of them — the offbeat and shuffle feels. Thirds are included because triplet phases
 * are what give a dubby, swung placement that eighths alone cannot reach.
 */
export const PHASE_DIVISIONS: { label: string; fraction: number }[] = [
  // Written as "1/8" rather than "⅛": most fonts draw the single-glyph fractions at about
  // half height, so they stay illegible at any size that fits a knob row.
  { label: "0", fraction: 0 },
  { label: "1/8", fraction: 1 / 8 },
  { label: "1/4", fraction: 1 / 4 },
  { label: "1/3", fraction: 1 / 3 },
  { label: "3/8", fraction: 3 / 8 },
  { label: "1/2", fraction: 1 / 2 },
  { label: "2/3", fraction: 2 / 3 },
  { label: "3/4", fraction: 3 / 4 },
];

/**
 * Rotate a loop's start point forward by `fraction` of a bar, wrapping inside the loop.
 *
 * Rotation rather than delay: the loop keeps its length and its place on the grid, so it
 * stays locked to everything else — only which part of the audio lands on the downbeat
 * changes. Delaying the start instead would push the loop end off the grid and drift.
 *
 * Returns the same loop unchanged when there is no tempo, no offset, or no room, so the
 * caller never has to special-case those.
 */
export function phaseShiftLoop(
  loopStart: number,
  loopEnd: number,
  bufferDuration: number,
  bpm: number | undefined,
  fraction: number,
  opts: { beatsPerBar?: number } = {},
): { loopStart: number; loopEnd: number } {
  const loopDur = loopEnd - loopStart;
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return { loopStart, loopEnd };
  if (!Number.isFinite(fraction) || Math.abs(fraction) < 1e-9) return { loopStart, loopEnd };
  if (loopDur <= 0) return { loopStart, loopEnd };

  const barSec = (60 / bpm) * (opts.beatsPerBar ?? 4);
  // Offsets beyond one loop are equivalent to their remainder, and a positive modulo keeps
  // a negative fraction from producing a start before the buffer.
  const offset = (((fraction * barSec) % loopDur) + loopDur) % loopDur;

  const newStart = loopStart + offset;
  const newEnd = newStart + loopDur;
  // Past the end of the audio there is nothing to rotate into, so leave it alone rather
  // than silently truncating the loop.
  if (newEnd > bufferDuration) return { loopStart, loopEnd };
  return { loopStart: newStart, loopEnd: newEnd };
}

/**
 * Move to the neighbouring delay division.
 *
 * A fixed seconds-per-press step cannot work here: the gaps between divisions are uneven
 * (1/8→1/4 is far wider than 1/16→1/8), so any single step is either too small to escape
 * the current division — the snap pulls it straight back and the key looks dead — or large
 * enough to skip past several. Stepping by index sidesteps that entirely.
 *
 * Returns 0 when stepping below the smallest division, so the delay can be switched off.
 */
export function stepDelayDivision(
  seconds: number,
  bpm: number | undefined,
  dir: 1 | -1,
  maxSeconds: number,
): number | null {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  const beatSec = 60 / bpm;
  const usable = DELAY_DIVISIONS.filter((d) => d.beats * beatSec <= maxSeconds);
  if (usable.length === 0) return null;

  // Index of the division the current value sits on, by nearest match.
  let idx = -1;
  let bestErr = Infinity;
  usable.forEach((d, i) => {
    const err = Math.abs(d.beats * beatSec - seconds);
    if (err < bestErr) { bestErr = err; idx = i; }
  });

  // At or below zero, stepping up enters at the smallest division.
  if (seconds < 0.001) return dir > 0 ? usable[0].beats * beatSec : 0;

  const next = idx + dir;
  if (next < 0) return 0;                       // below the smallest division = off
  if (next >= usable.length) return usable[usable.length - 1].beats * beatSec;
  return usable[next].beats * beatSec;
}
