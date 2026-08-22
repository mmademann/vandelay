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
export const DELAY_DIVISIONS: { label: string; beats: number }[] = [
  { label: "1/32", beats: 0.125 },
  { label: "1/16", beats: 0.25 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/16.", beats: 0.375 },
  { label: "1/8", beats: 0.5 },
  { label: "1/4T", beats: 2 / 3 },
  { label: "1/8.", beats: 0.75 },
  { label: "1/4", beats: 1 },
  { label: "1/2T", beats: 4 / 3 },
  { label: "1/4.", beats: 1.5 },
  { label: "1/2", beats: 2 },
  { label: "1/2.", beats: 3 },
  { label: "1 bar", beats: 4 },
  { label: "2 bars", beats: 8 },
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
