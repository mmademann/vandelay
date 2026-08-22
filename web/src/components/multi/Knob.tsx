import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const STROKE = 4;
const START_ANGLE = 225;
const SWEEP = 270;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function Knob({
  label, value, min, max, step, defaultValue, displayValue, disabled, onChange, onCommit, size = 48,
}: {
  label: string; value: number; min: number; max: number; step: number;
  defaultValue: number; displayValue: string; disabled?: boolean; onChange: (v: number) => void;
  /**
   * Fired once the value settles — pointer release, key press, or double-click reset —
   * rather than on every drag frame. For knobs whose work is too expensive to run per
   * frame (time stretch rebuilds the whole buffer), onChange drives the visual and this
   * drives the audio.
   */
  onCommit?: (v: number) => void;
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
  const dragRef = useRef<{ startY: number; startVal: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Drag always repaints via onChange; onCommit is what gates the expensive work.
  function setLive(v: number) { onChange(v); }

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
      const next = clampStep(value + dir * step * (e.shiftKey ? 10 : 1));
      onChange(next);
      onCommit?.(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hovered, disabled, value, step, min, max, onChange, onCommit]); // eslint-disable-line react-hooks/exhaustive-deps

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
          onPointerMove={(e) => { if (!dragRef.current || disabled) return; const delta = (dragRef.current.startY - e.clientY) / 100; const next = clampStep(dragRef.current.startVal + delta * (max - min)); dragRef.current.last = next; setLive(next); }}
          onPointerUp={() => { const d = dragRef.current; if (!d) return; dragRef.current = null; setDragging(false); if (d.last !== d.startVal) onCommit?.(d.last); }}
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
