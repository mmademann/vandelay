import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const STROKE = 4;
const START_ANGLE = 225;
const SWEEP = 270;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function Knob({
  label, value, min, max, step, defaultValue, displayValue, disabled, onChange, onCommit, onStep, size = 48,
}: {
  label: string; value: number; min: number; max: number; step: number;
  defaultValue: number; displayValue: string; disabled?: boolean;
  /**
   * `opts.free` means the pointer or key was held with Shift: the caller should skip any
   * snapping of its own. The knob has already skipped its own step quantisation.
   */
  onChange: (v: number, opts?: { free?: boolean }) => void;
  /**
   * Fired once the value settles — pointer release, key press, or double-click reset —
   * rather than on every drag frame. For knobs whose work is too expensive to run per
   * frame (time stretch rebuilds the whole buffer), onChange drives the visual and this
   * drives the audio.
   */
  onCommit?: (v: number, opts?: { free?: boolean }) => void;
  /**
   * Overrides arrow-key stepping. For knobs whose useful values are an uneven scale (the
   * tempo-synced delay divisions), a fixed `step` is either too small to leave the current
   * value or big enough to skip several — this lets the owner move by one meaningful
   * increment instead. Return null to fall back to the normal step.
   */
  onStep?: (current: number, dir: 1 | -1) => number | null;
  size?: number;
}) {
  const R = (size - STROKE) / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;

  function arcPath(startDeg: number, endDeg: number) {
    const s = toRad(startDeg); const e = toRad(endDeg);
    const x1 = cx + R * Math.cos(s); const y1 = cy + R * Math.sin(s);
    const x2 = cx + R * Math.cos(e); const y2 = cy + R * Math.sin(e);
    return `M ${x1} ${y1} A ${R} ${R} 0 ${endDeg - startDeg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  }

  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = START_ANGLE + ratio * SWEEP;
  const dragRef = useRef<{ startY: number; startVal: number; last: number; free?: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Drag always repaints via onChange; onCommit is what gates the expensive work.
  function setLive(v: number, opts?: { free?: boolean }) { onChange(v, opts); }

  /** Clamped to the range but NOT to the step — Shift-drag is continuous. */
  function clampRange(v: number) { return Math.min(max, Math.max(min, v)); }

  function clampStep(v: number) {
    const snapped = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, parseFloat(snapped.toFixed(10))));
  }

  // Arrow keys adjust the hovered knob — no click/focus needed. Shift = 10x coarse step.
  // Listener is only attached while hovered, so exactly one knob can respond at a time.
  useEffect(() => {
    if (!hovered || disabled) return;
    function onKey(e: KeyboardEvent) {
      let dir = 0;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") dir = 1;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") dir = -1;
      else return;
      e.preventDefault(); // stop the page from scrolling
      // Shift escapes the ladder. On a knob that HAS one (the tempo-synced delay) that means
      // stepping by the raw step instead of by division, so a value between two divisions is
      // reachable from the keyboard as well as by dragging. On a knob without one, Shift
      // keeps its older meaning: a 10x coarse step.
      const free = e.shiftKey && onStep !== undefined;
      const stepped = free ? null : onStep?.(value, dir as 1 | -1);
      const coarse = e.shiftKey && onStep === undefined ? 10 : 1;
      const next = stepped ?? clampStep(value + dir * step * coarse);
      onChange(next, { free });
      onCommit?.(next, { free });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered, disabled, value, step, min, max, onChange, onCommit, onStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const indicatorLen = R - 4;
  const indX2 = cx + indicatorLen * Math.cos(toRad(angle));
  const indY2 = cy + indicatorLen * Math.sin(toRad(angle));
  const indX1 = cx + (R - indicatorLen - 6) * Math.cos(toRad(angle));
  const indY1 = cy + (R - indicatorLen - 6) * Math.sin(toRad(angle));

  return (
    <div className={cn("flex flex-col items-center gap-0.5", disabled && "opacity-35 pointer-events-none")}>
      <div className="relative select-none"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}>
        <svg width={size} height={size}
          onPointerDown={(e) => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = { startY: e.clientY, startVal: value, last: value }; setDragging(true); }}
          onPointerMove={(e) => {
            if (!dragRef.current || disabled) return;
            const delta = (dragRef.current.startY - e.clientY) / 100;
            const raw = dragRef.current.startVal + delta * (max - min);
            // Shift-drag is continuous: neither the knob's own step nor the caller's snapping.
            const next = e.shiftKey ? clampRange(raw) : clampStep(raw);
            dragRef.current.last = next;
            dragRef.current.free = e.shiftKey;
            setLive(next, { free: e.shiftKey });
          }}
          onPointerUp={() => { const d = dragRef.current; if (!d) return; dragRef.current = null; setDragging(false); if (d.last !== d.startVal) onCommit?.(d.last, { free: d.free }); }}
          onDoubleClick={() => { if (disabled) return; onChange(defaultValue); onCommit?.(defaultValue); }}
          className="cursor-ns-resize touch-none" style={{ display: "block" }}>
          <path d={arcPath(START_ANGLE, START_ANGLE + SWEEP)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={STROKE} strokeLinecap="round" />
          {ratio > 0.001 && <path d={arcPath(START_ANGLE, Math.max(START_ANGLE + 0.5, angle))} fill="none" stroke="rgba(45,212,191,0.75)" strokeWidth={STROKE} strokeLinecap="round" />}
          <circle cx={cx} cy={cy} r={R - STROKE - 2} fill="rgba(255,255,255,0.03)" />
          <line x1={indX1} y1={indY1} x2={indX2} y2={indY2} stroke="rgba(45,212,191,0.9)" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
        {(dragging || hovered) && (
          <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-foreground/90 ring-1 ring-border/60 shadow-lg">
            {displayValue}
          </div>
        )}
      </div>
      <span className="text-[9px] uppercase tracking-wide text-foreground/35 leading-none">{label}</span>
      <span className="text-[9px] tabular-nums text-foreground/55 leading-none">{displayValue}</span>
    </div>
  );
}
