import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { collabEngine } from "../../audio/collabEngine";
import type { CollabSlot } from "../../lib/collabSettings";
import {
  saveSlotSettings,
  type CollabPreset,
} from "../../lib/collabSettings";
import { DRY_EFFECTS, type StemName } from "../../audio/dubEngine";
import { EFFECTS_LIMITS } from "../../store";

const STEM_LABELS: Record<StemName, string> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  other: "Other",
};

const STEM_COLORS: Record<StemName, string> = {
  drums: "bg-orange-500/15 text-orange-400",
  bass: "bg-blue-500/15 text-blue-400",
  vocals: "bg-purple-500/15 text-purple-400",
  other: "bg-emerald-500/15 text-emerald-400",
};

const WAVEFORM_H = 80;
const LOOP_MIN_GAP = 0.05;

// --- Waveform ---

function computePeaks(buffer: AudioBuffer, width: number): { pmin: Float32Array; pmax: Float32Array } {
  const totalSamples = buffer.length;
  const step = totalSamples / width;
  const stride = Math.max(1, Math.floor(step / 64));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const pmin = new Float32Array(width);
  const pmax = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * step);
    const end = Math.min(Math.floor((x + 1) * step), totalSamples);
    let lo = 0, hi = 0;
    for (let i = start; i < end; i += stride) {
      let sample = 0;
      for (const ch of channels) sample += ch[i];
      sample /= channels.length;
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    pmin[x] = lo;
    pmax[x] = hi;
  }
  let peak = 0;
  for (let x = 0; x < width; x++) {
    if (pmax[x] > peak) peak = pmax[x];
    if (-pmin[x] > peak) peak = -pmin[x];
  }
  if (peak > 0) {
    for (let x = 0; x < width; x++) { pmin[x] /= peak; pmax[x] /= peak; }
  }
  return { pmin, pmax };
}

function renderBase(canvas: HTMLCanvasElement, buffer: AudioBuffer): ImageData | null {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  if (w === 0) return null;
  canvas.width = w * dpr;
  canvas.height = WAVEFORM_H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, WAVEFORM_H);
  const { pmin, pmax } = computePeaks(buffer, w);
  const mid = WAVEFORM_H / 2;
  ctx.fillStyle = "rgba(45, 212, 191, 0.35)";
  for (let x = 0; x < w; x++) {
    const top = mid - pmax[x] * mid;
    const bot = mid - pmin[x] * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

const HANDLE_W = 3;
const HANDLE_TAB = 8;

function renderFrame(
  canvas: HTMLCanvasElement,
  base: ImageData,
  playRatio: number,
  loopStartRatio: number,
  loopEndRatio: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(base, 0, 0);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  if (loopEndRatio > loopStartRatio) {
    const lx = Math.floor(loopStartRatio * w);
    const rx = Math.floor(loopEndRatio * w);

    // Darken outside regions
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    if (lx > 0) ctx.fillRect(0, 0, lx, h);
    if (rx < w) ctx.fillRect(rx, 0, w - rx, h);

    // Loop region tint
    ctx.fillStyle = "rgba(45, 212, 191, 0.08)";
    ctx.fillRect(lx, 0, rx - lx, h);

    // Handle bars
    ctx.fillStyle = "rgba(45,212,191,0.9)";
    ctx.fillRect(lx, 0, HANDLE_W, h);
    ctx.fillRect(rx - HANDLE_W, 0, HANDLE_W, h);

    // Handle tabs (small rect at top so user can see the grab target)
    ctx.fillStyle = "rgba(45,212,191,1)";
    ctx.fillRect(lx, 0, HANDLE_TAB, HANDLE_W + 1);
    ctx.fillRect(rx - HANDLE_TAB, 0, HANDLE_TAB, HANDLE_W + 1);
    ctx.fillRect(lx, h - HANDLE_W - 1, HANDLE_TAB, HANDLE_W + 1);
    ctx.fillRect(rx - HANDLE_TAB, h - HANDLE_W - 1, HANDLE_TAB, HANDLE_W + 1);
  }

  // Playhead
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(Math.floor(playRatio * w), 0, 1, h);
}

function SlotWaveform({
  buffer,
  isPlaying,
  loopStart,
  loopEnd,
  seekRevision,
  getPosition,
  onLoopChange,
  onSeek,
}: {
  buffer: AudioBuffer;
  isPlaying: boolean;
  loopStart: number;
  loopEnd: number;
  seekRevision: number;
  getPosition: () => number;
  onLoopChange: (start: number, end: number) => void;
  onSeek: (time: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<ImageData | null>(null);
  const rafRef = useRef(0);
  const loopStartRef = useRef(loopStart);
  const loopEndRef = useRef(loopEnd);
  const durationRef = useRef(buffer.duration);
  const onLoopChangeRef = useRef(onLoopChange);
  const onSeekRef = useRef(onSeek);
  const getPositionRef = useRef(getPosition);
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;
  durationRef.current = buffer.duration;
  onLoopChangeRef.current = onLoopChange;
  onSeekRef.current = onSeek;
  getPositionRef.current = getPosition;

  function getPlayRatio() {
    const dur = durationRef.current;
    if (dur <= 0) return 0;
    const pos = getPositionRef.current();
    return Math.max(0, Math.min(1, pos / dur));
  }

  function repaint(playRatio?: number) {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base) return;
    const dur = durationRef.current;
    renderFrame(canvas, base, playRatio ?? getPlayRatio(), loopStartRef.current / dur, loopEndRef.current / dur);
  }

  function rebuild() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    baseRef.current = renderBase(canvas, buffer);
    repaint(0);
  }

  useEffect(() => { rebuild(); }, [buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => rebuild());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    repaint();
  }, [loopStart, loopEnd, seekRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!isPlaying) {
      repaint();
      return;
    }
    function tick() {
      repaint();
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  const dragRef = useRef<{ handle: "start" | "end"; startX: number; startVal: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const dur = durationRef.current;
    const ls = loopStartRef.current;
    const le = loopEndRef.current;
    const distStart = Math.abs(ratio - ls / dur);
    const distEnd = Math.abs(ratio - le / dur);
    const threshold = 12 / rect.width;
    if (distStart < threshold && distStart <= distEnd) {
      dragRef.current = { handle: "start", startX: e.clientX, startVal: ls };
      canvas.setPointerCapture(e.pointerId);
    } else if (distEnd < threshold) {
      dragRef.current = { handle: "end", startX: e.clientX, startVal: le };
      canvas.setPointerCapture(e.pointerId);
    } else {
      // Per-slot seek — does NOT affect other slots
      const seekTime = Math.max(0, Math.min(dur, ratio * dur));
      onSeekRef.current(seekTime);
      repaint(ratio);
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dur = durationRef.current;
    const delta = ((e.clientX - drag.startX) / rect.width) * dur;
    const raw = drag.startVal + delta;
    if (drag.handle === "start") {
      onLoopChangeRef.current(Math.max(0, Math.min(loopEndRef.current - LOOP_MIN_GAP, raw)), loopEndRef.current);
    } else {
      onLoopChangeRef.current(loopStartRef.current, Math.min(dur, Math.max(loopStartRef.current + LOOP_MIN_GAP, raw)));
    }
  }

  function handlePointerUp() { dragRef.current = null; }

  return (
    <canvas
      ref={canvasRef}
      style={{ height: WAVEFORM_H }}
      className="w-full cursor-pointer rounded bg-muted/30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}

// --- Knob ---

function Knob({
  label, value, min, max, step, defaultValue, displayValue, disabled, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  defaultValue: number; displayValue: string; disabled?: boolean; onChange: (v: number) => void;
}) {
  const SIZE = 48;
  const STROKE = 4;
  const R = (SIZE - STROKE) / 2 - 1;
  const START_ANGLE = 225;
  const SWEEP = 270;
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = START_ANGLE + ratio * SWEEP;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  function arcPath(startDeg: number, endDeg: number) {
    const s = toRad(startDeg); const e = toRad(endDeg);
    const x1 = cx + R * Math.cos(s); const y1 = cy + R * Math.sin(s);
    const x2 = cx + R * Math.cos(e); const y2 = cy + R * Math.sin(e);
    return `M ${x1} ${y1} A ${R} ${R} 0 ${endDeg - startDeg > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  }
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function clampStep(v: number) {
    const snapped = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, parseFloat(snapped.toFixed(10))));
  }
  const indicatorLen = R - 4;
  const indX2 = cx + indicatorLen * Math.cos(toRad(angle));
  const indY2 = cy + indicatorLen * Math.sin(toRad(angle));
  const indX1 = cx + (R - indicatorLen - 6) * Math.cos(toRad(angle));
  const indY1 = cy + (R - indicatorLen - 6) * Math.sin(toRad(angle));
  return (
    <div className={cn("flex flex-col items-center gap-0.5", disabled && "opacity-35 pointer-events-none")}>
      <div className="relative select-none">
        <svg width={SIZE} height={SIZE}
          onPointerDown={(e) => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = { startY: e.clientY, startVal: value }; setDragging(true); }}
          onPointerMove={(e) => { if (!dragRef.current || disabled) return; const delta = (dragRef.current.startY - e.clientY) / 100; onChange(clampStep(dragRef.current.startVal + delta * (max - min))); }}
          onPointerUp={() => { dragRef.current = null; setDragging(false); }}
          onDoubleClick={() => { if (!disabled) onChange(defaultValue); }}
          className="cursor-ns-resize touch-none" style={{ display: "block" }}>
          <path d={arcPath(START_ANGLE, START_ANGLE + SWEEP)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={STROKE} strokeLinecap="round" />
          {ratio > 0.001 && <path d={arcPath(START_ANGLE, Math.max(START_ANGLE + 0.5, angle))} fill="none" stroke="rgba(45,212,191,0.75)" strokeWidth={STROKE} strokeLinecap="round" />}
          <circle cx={cx} cy={cy} r={R - STROKE - 2} fill="rgba(255,255,255,0.03)" />
          <line x1={indX1} y1={indY1} x2={indX2} y2={indY2} stroke="rgba(45,212,191,0.9)" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
        {dragging && (
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

// --- SlotStrip ---

interface Props {
  slot: CollabSlot;
  title: string;
  buffer: AudioBuffer | null;
  presets: CollabPreset[];
  onRemove: () => void;
  onChange: (patch: Partial<CollabSlot>) => void;
  onSavePreset: (name: string, preset: Omit<CollabPreset, "name">) => void;
  onDeletePreset: (name: string) => void;
  onApplyPreset: (preset: CollabPreset) => void;
}

export function SlotStrip({ slot, title, buffer, presets, onRemove, onChange, onSavePreset, onDeletePreset, onApplyPreset }: Props) {
  const [presetName, setPresetName] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);

  // Keep isPlaying in sync with engine state
  useEffect(() => {
    const id = setInterval(() => {
      setIsPlaying(collabEngine.isSlotPlaying(slot.id));
    }, 100);
    return () => clearInterval(id);
  }, [slot.id]);

  async function handlePlayStop() {
    if (isPlaying) {
      collabEngine.stopSlot(slot.id);
      setIsPlaying(false);
    } else {
      await collabEngine.playSlot(slot.id);
      setIsPlaying(true);
    }
  }

  function persistSettings(patch: Partial<CollabSlot>) {
    const merged = { ...slot, ...patch };
    const dur = buffer?.duration ?? 1;
    saveSlotSettings(slot.trackId, slot.stemName, {
      speed: merged.speed,
      pitch: merged.pitch,
      linkPitch: merged.linkPitch,
      gain: merged.gain,
      muted: merged.muted,
      effects: merged.effects,
      loopStartFrac: merged.loopStart / dur,
      loopEndFrac: merged.loopEnd / dur,
    });
  }

  function update(patch: Partial<CollabSlot>) {
    collabEngine.updateSlot(slot.id, patch);
    onChange(patch);
    persistSettings(patch);
    if (patch.speed !== undefined || patch.pitch !== undefined || patch.linkPitch !== undefined) {
      setActivePreset(null);
    }
  }

  function updateEffect(patch: Partial<CollabSlot["effects"]>) {
    const effects = { ...slot.effects, ...patch };
    collabEngine.updateSlot(slot.id, { effects });
    onChange({ effects });
    persistSettings({ effects });
    setActivePreset(null);
  }

  function handleReset() {
    const patch = { effects: { ...DRY_EFFECTS }, speed: 1, pitch: 0, linkPitch: true, gain: 0 };
    collabEngine.updateSlot(slot.id, patch);
    onChange(patch);
    persistSettings(patch);
    setActivePreset(null);
  }

  function applyPreset(preset: CollabPreset) {
    onApplyPreset(preset);
    setActivePreset(preset.name);
  }

  function handleSavePreset(e: React.FormEvent) {
    e.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    onSavePreset(name, {
      effects: slot.effects,
      speed: slot.speed,
      pitch: slot.pitch,
      linkPitch: slot.linkPitch,
      gain: slot.gain,
    });
    setActivePreset(name);
    setPresetName("");
  }

  return (
    <div className={cn(
      "flex flex-col gap-3 overflow-y-auto rounded-md border border-border bg-muted/30 p-4 transition",
      slot.muted && "opacity-40",
    )}>
      {/* Header: buttons left, title right */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={handlePlayStop} disabled={!buffer}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              isPlaying ? "bg-accent/25 text-accent ring-1 ring-accent/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}>
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <button type="button" onClick={() => { collabEngine.seekSlot(slot.id, slot.loopStart); setSeekRevision((n) => n + 1); }} disabled={!buffer}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}
            title="Rewind to loop start">
            ⏮
          </button>
          <button type="button" onClick={() => update({ soloed: !slot.soloed })}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              slot.soloed ? "bg-yellow-500/25 text-yellow-400 ring-1 ring-yellow-500/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted")}>
            ✦ Solo
          </button>
          <button type="button" onClick={() => update({ muted: !slot.muted })}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              slot.muted ? "bg-red-500/25 text-red-400 ring-1 ring-red-500/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted")}>
            {slot.muted ? "✕ Muted" : "◎ Mute"}
          </button>
        </div>
        <div className="flex flex-1 items-center gap-2 min-w-0 justify-end">
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", STEM_COLORS[slot.stemName])}>
            {STEM_LABELS[slot.stemName]}
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground/70">{title}</span>
          <button type="button" onClick={onRemove}
            className="shrink-0 text-foreground/20 transition hover:text-foreground/60 text-sm px-1"
            aria-label="Remove">✕</button>
        </div>
      </div>

      {/* Waveform */}
      {buffer ? (
        <SlotWaveform
          buffer={buffer}
          isPlaying={isPlaying}
          loopStart={slot.loopStart}
          loopEnd={slot.loopEnd}
          seekRevision={seekRevision}
          getPosition={() => collabEngine.getSlotPosition(slot.id)}
          onLoopChange={(start, end) => update({ loopStart: start, loopEnd: end })}
          onSeek={(time) => { collabEngine.seekSlot(slot.id, time); setSeekRevision((n) => n + 1); }}
        />
      ) : (
        <div style={{ height: WAVEFORM_H }} className="w-full rounded bg-muted/30 flex items-center justify-center text-[10px] text-foreground/20">
          loading…
        </div>
      )}

      {/* Knobs */}
      <div className="flex flex-wrap gap-x-4 gap-y-3 border-t border-border/50 pt-3">
        <Knob label="Gain" value={slot.gain} min={-24} max={6} step={0.5} defaultValue={0}
          displayValue={`${slot.gain > 0 ? "+" : ""}${slot.gain.toFixed(1)}dB`} onChange={(v) => update({ gain: v })} />
        <Knob label="Speed" value={slot.speed} min={0.1} max={1} step={0.01} defaultValue={1}
          displayValue={`${slot.speed.toFixed(2)}×`} onChange={(v) => update({ speed: v })} />
        <div className="flex flex-col items-center gap-0.5">
          <Knob label="Pitch" value={slot.pitch} min={-12} max={12} step={1} defaultValue={0}
            displayValue={`${slot.pitch > 0 ? "+" : ""}${slot.pitch}st`} disabled={slot.linkPitch}
            onChange={(v) => update({ pitch: v })} />
          <button type="button" onClick={() => update({ linkPitch: !slot.linkPitch })}
            className={cn("rounded px-2 py-0.5 text-[9px] uppercase tracking-wide font-semibold transition",
              slot.linkPitch ? "bg-accent/25 text-accent" : "bg-muted text-foreground/30 hover:text-foreground/60")}>
            Link
          </button>
        </div>
        <Knob label="Reverb" value={slot.effects.reverbWet} min={EFFECTS_LIMITS.reverbWet.min} max={EFFECTS_LIMITS.reverbWet.max} step={0.01} defaultValue={0}
          displayValue={`${Math.round(slot.effects.reverbWet * 100)}%`} onChange={(v) => updateEffect({ reverbWet: v })} />
        <Knob label="Decay" value={slot.effects.reverbDecay} min={EFFECTS_LIMITS.reverbDecay.min} max={EFFECTS_LIMITS.reverbDecay.max} step={0.1} defaultValue={0.1}
          displayValue={`${slot.effects.reverbDecay.toFixed(1)}s`} onChange={(v) => updateEffect({ reverbDecay: v })} />
        <Knob label="Delay" value={slot.effects.delayWet} min={EFFECTS_LIMITS.delayWet.min} max={EFFECTS_LIMITS.delayWet.max} step={0.01} defaultValue={0}
          displayValue={`${Math.round(slot.effects.delayWet * 100)}%`} onChange={(v) => updateEffect({ delayWet: v })} />
        <Knob label="D.Time" value={slot.effects.delayTime} min={EFFECTS_LIMITS.delayTime.min} max={EFFECTS_LIMITS.delayTime.max} step={0.01} defaultValue={0}
          displayValue={`${slot.effects.delayTime.toFixed(2)}s`} onChange={(v) => updateEffect({ delayTime: v })} />
        <Knob label="Feedbk" value={slot.effects.delayFeedback} min={EFFECTS_LIMITS.delayFeedback.min} max={EFFECTS_LIMITS.delayFeedback.max} step={0.01} defaultValue={0}
          displayValue={`${Math.round(slot.effects.delayFeedback * 100)}%`} onChange={(v) => updateEffect({ delayFeedback: v })} />
        <Knob label="Bass" value={slot.effects.bassBoost} min={EFFECTS_LIMITS.bassBoost.min} max={EFFECTS_LIMITS.bassBoost.max} step={1} defaultValue={0}
          displayValue={`${slot.effects.bassBoost > 0 ? "+" : ""}${slot.effects.bassBoost}dB`} onChange={(v) => updateEffect({ bassBoost: v })} />
        <Knob label="Grit" value={slot.effects.grit ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.grit ?? 0) * 100)}%`} onChange={(v) => updateEffect({ grit: v })} />
        <div className="flex flex-col items-center justify-end gap-0.5 ml-auto">
          <button type="button" onClick={handleReset}
            className="rounded px-2 py-1 text-[9px] uppercase tracking-wide font-semibold text-foreground/30 bg-muted/60 hover:text-foreground/60 hover:bg-muted transition">
            ↺ Reset
          </button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
        <div className="text-[10px] uppercase tracking-wide text-foreground/40">Presets</div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {presets.map((p) => (
            <div key={p.name} className={cn(
                "group flex items-center gap-2 rounded-md border px-3 py-2",
                activePreset === p.name ? "border-accent/50 bg-accent/10" : "border-border bg-muted/50",
              )}>
              <button type="button" onClick={() => applyPreset(p)}
                className={cn("text-sm font-medium transition whitespace-nowrap", activePreset === p.name ? "text-accent" : "text-foreground/60 hover:text-foreground")}>
                {p.name}
              </button>
              <button type="button" onClick={() => { onDeletePreset(p.name); if (activePreset === p.name) setActivePreset(null); }}
                className="text-base leading-none text-foreground/20 opacity-0 transition hover:text-red-400 group-hover:opacity-100 border-l border-border/50 pl-2"
                aria-label="Delete preset">✕</button>
            </div>
          ))}
          <form onSubmit={handleSavePreset} className="flex gap-1.5 items-center">
            <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)}
              placeholder="Save preset…"
              className="w-36 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground/70 placeholder:text-foreground/30 outline-none focus:border-accent/60" />
            {presetName.trim() && (
              <button type="submit"
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/50 hover:text-foreground">
                Save
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
