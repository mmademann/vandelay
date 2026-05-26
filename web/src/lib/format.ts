export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(":")) {
    const [m, s] = trimmed.split(":");
    const mins = Number(m);
    const secs = Number(s);
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
    return mins * 60 + secs;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Round to nearest 0.01 s for loop regions (matches m:ss.ss display). */
export function roundLoopTime(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 100) / 100;
}

/** Shown beside Start/End loop inputs (matches formatLoopTime, e.g. 3:21.50). */
export const LOOP_TIME_FORMAT_HINT = "m:ss.ss";

/** Loop fields: always m:ss.ss (two fractional digits, e.g. 3:21.50). */
export function formatLoopTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const rounded = roundLoopTime(seconds);
  const m = Math.floor(rounded / 60);
  const sec = rounded - m * 60;
  const whole = Math.floor(sec + 1e-9);
  const frac = Math.min(99, Math.round((sec - whole) * 100));
  return `${m}:${whole.toString().padStart(2, "0")}.${frac.toString().padStart(2, "0")}`;
}

export function parseLoopTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let seconds: number;
  if (trimmed.includes(":")) {
    const colon = trimmed.indexOf(":");
    const mins = Number(trimmed.slice(0, colon));
    const secs = Number(trimmed.slice(colon + 1));
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
    seconds = mins * 60 + secs;
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    seconds = n;
  }
  return roundLoopTime(Math.max(0, seconds));
}

/** 0–100 playhead position, clamped so the line stays visible at track edges. */
export function playheadPercent(position: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (position / duration) * 100));
}

export function setPlayheadLeft(el: HTMLElement | null, position: number, duration: number) {
  if (!el) return;
  el.style.left = `${playheadPercent(position, duration)}%`;
}
