import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { collabEngine } from "../../audio/collabEngine";
import type { CollabSlot } from "../../lib/collabSettings";
import { Knob } from "./Knob";
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

// --- SlotStrip ---

function formatKeyBadge(key: string | null | undefined): string {
  if (!key) return "?";
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key;
  const scale = parts[1];
  const uncertain = scale.endsWith("?");
  const mode = scale.startsWith("maj") ? "maj" : "min";
  return `${parts[0]} ${mode}${uncertain ? "?" : ""}`;
}

interface Props {
  slot: CollabSlot;
  title: string;
  buffer: AudioBuffer | null;
  presets: CollabPreset[];
  isReference: boolean;
  hasReference: boolean;
  detectedKey?: string | null | undefined;
  detectedBpm?: number;
  isMatched: boolean;
  matchedBasePitch: number;
  pitchInterval: 1 | 7 | 12;
  onPitchIntervalChange: (n: 1 | 7 | 12) => void;
  onRemove: () => void;
  onChange: (patch: Partial<CollabSlot>) => void;
  onSetReference: () => void;
  onMatch: () => void;
  onSavePreset: (name: string, preset: Omit<CollabPreset, "name">) => void;
  onDeletePreset: (name: string) => void;
  onApplyPreset: (preset: CollabPreset) => void;
}

export function SlotStrip({ slot, title, buffer, presets, isReference, hasReference, detectedKey, detectedBpm, isMatched, matchedBasePitch, pitchInterval, onPitchIntervalChange, onRemove, onChange, onSetReference, onMatch, onSavePreset, onDeletePreset, onApplyPreset }: Props) {
  const [presetName, setPresetName] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [throwActive, setThrowActive] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);
  const [presetsPanelOpen, setPresetsPanelOpen] = useState(false);
  const presetsPanelRef = useRef<HTMLDivElement>(null);
  const presetsBtnRef = useRef<HTMLButtonElement>(null);

  // Keep isPlaying and throwActive in sync with engine state
  useEffect(() => {
    const id = setInterval(() => {
      setIsPlaying(collabEngine.isSlotPlaying(slot.id));
      setThrowActive(collabEngine.isThrowActive(slot.id));
    }, 100);
    return () => clearInterval(id);
  }, [slot.id]);

  useEffect(() => {
    if (!presetsPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        presetsPanelRef.current && !presetsPanelRef.current.contains(e.target as Node) &&
        presetsBtnRef.current && !presetsBtnRef.current.contains(e.target as Node)
      ) setPresetsPanelOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [presetsPanelOpen]);

  async function handlePlayStop() {
    if (isPlaying) {
      collabEngine.stopSlot(slot.id);
      setIsPlaying(false);
    } else {
      await collabEngine.playSlot(slot.id);
      setIsPlaying(true);
    }
  }

  function persistSettings(patch: Partial<CollabSlot>, overridePitchInterval?: 1 | 7 | 12) {
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
      isMatched,
      matchedBasePitch,
      pitchInterval: overridePitchInterval ?? pitchInterval,
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
    const patch = { effects: { ...DRY_EFFECTS, phaserWet: 0, chorusWet: 0 }, speed: 1, pitch: 0, linkPitch: true, gain: 0 };
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
      "flex flex-col gap-3 rounded-md border bg-muted/30 p-4 transition",
      slot.muted && "opacity-40",
      isReference ? "border-accent/60 ring-1 ring-accent/20 bg-accent/5" : "border-border",
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
          <button type="button" onClick={() => collabEngine.throwSlot(slot.id)} disabled={!buffer}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              throwActive
                ? "bg-teal-500/25 text-teal-400 ring-1 ring-teal-400/60"
                : "bg-muted/80 text-foreground/50 hover:text-teal-400 hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}
            title="Throw — tape echo burst + spring reverb">
            ↯ Throw
          </button>
        </div>
        <div className="flex flex-1 items-center gap-2 min-w-0 justify-end">
          {/* Key badge — shown once buffer has loaded (detectedKey !== undefined) */}
          {detectedKey !== undefined && (
            <span
              title={detectedBpm ? `${detectedBpm} bpm` : undefined}
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-muted/60 text-foreground/50 border border-border/60 cursor-default"
            >
              {detectedKey ? `Key: ${formatKeyBadge(detectedKey)}` : "Key: unknown"}
            </span>
          )}
          {/* Matched tag + pitch shift controls */}
          {isMatched && (
            <span className="shrink-0 flex items-center gap-0 rounded border border-accent/30 bg-accent/15 overflow-hidden">
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent/70">Matched</span>
              {([1, 7, 12] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { onPitchIntervalChange(n); persistSettings({}, n); }}
                  className={cn(
                    "px-1.5 py-0.5 text-[10px] font-semibold transition border-l border-accent/20",
                    pitchInterval === n
                      ? "bg-accent/20 text-accent"
                      : "text-accent/40 hover:text-accent/70 hover:bg-accent/10",
                  )}
                >{n}</button>
              ))}
              <button
                type="button"
                title={`Shift down ${pitchInterval} semitone${pitchInterval > 1 ? "s" : ""}`}
                onClick={() => {
                  const diff = slot.pitch - matchedBasePitch;
                  const step = Math.floor(diff / pitchInterval);
                  const snapped = matchedBasePitch + step * pitchInterval;
                  const next = Math.abs(snapped - slot.pitch) < 0.01 ? snapped - pitchInterval : snapped;
                  update({ pitch: next, linkPitch: false });
                }}
                className="px-1.5 py-0.5 text-[11px] text-accent/60 hover:text-accent hover:bg-accent/10 transition border-l border-accent/20"
              >▼</button>
              <button
                type="button"
                title={`Shift up ${pitchInterval} semitone${pitchInterval > 1 ? "s" : ""}`}
                onClick={() => {
                  const diff = slot.pitch - matchedBasePitch;
                  const step = Math.ceil(diff / pitchInterval);
                  const snapped = matchedBasePitch + step * pitchInterval;
                  const next = Math.abs(snapped - slot.pitch) < 0.01 ? snapped + pitchInterval : snapped;
                  update({ pitch: next, linkPitch: false });
                }}
                className="px-1.5 py-0.5 text-[11px] text-accent/60 hover:text-accent hover:bg-accent/10 transition border-l border-accent/20"
              >▲</button>
            </span>
          )}
          {/* Pin as reference */}
          <button
            type="button"
            onClick={onSetReference}
            title={isReference ? "Remove as key anchor" : "Set as key anchor — other slots will match to this key + speed"}
            className={cn(
              "shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition",
              isReference
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border/60 bg-muted/60 text-foreground/40 hover:border-accent/40 hover:text-accent",
            )}
          >
            {isReference ? "Key Anchor ✓" : "Set Key Anchor"}
          </button>
          {/* Match this slot to reference */}
          {hasReference && !isReference && !isMatched && (
            <button
              type="button"
              onClick={onMatch}
              title="Match speed + pitch to key anchor"
              className="shrink-0 rounded border border-border/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-muted/60 text-foreground/40 transition hover:border-accent/40 hover:text-accent"
            >
              Match
            </button>
          )}
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            slot.stemName ? STEM_COLORS[slot.stemName as StemName] : "bg-zinc-500/15 text-zinc-400"
          )}>
            {slot.stemName ? STEM_LABELS[slot.stemName as StemName] : "Track"}
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
        <Knob label="D.Feedbk" value={slot.effects.delayFeedback} min={EFFECTS_LIMITS.delayFeedback.min} max={EFFECTS_LIMITS.delayFeedback.max} step={0.01} defaultValue={0}
          displayValue={`${Math.round(slot.effects.delayFeedback * 100)}%`} onChange={(v) => updateEffect({ delayFeedback: v })} />
        <Knob label="Bass" value={slot.effects.bassBoost} min={EFFECTS_LIMITS.bassBoost.min} max={EFFECTS_LIMITS.bassBoost.max} step={1} defaultValue={0}
          displayValue={`${slot.effects.bassBoost > 0 ? "+" : ""}${slot.effects.bassBoost}dB`} onChange={(v) => updateEffect({ bassBoost: v })} />
        <Knob label="Grit" value={slot.effects.grit ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.grit ?? 0) * 100)}%`} onChange={(v) => updateEffect({ grit: v })} />
        <Knob label="S.Echo" value={slot.effects.spaceEchoWow ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.spaceEchoWow ?? 0) * 100)}%`} onChange={(v) => updateEffect({ spaceEchoWow: v })} />
        <Knob label="B.Knob" value={slot.effects.bigKnobWet ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.bigKnobWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ bigKnobWet: v })} />
        <Knob label="EQ Lo" value={slot.effects.eqLow ?? 0} min={-12} max={12} step={0.5} defaultValue={0}
          displayValue={`${(slot.effects.eqLow ?? 0) > 0 ? "+" : ""}${(slot.effects.eqLow ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqLow: v })} />
        <Knob label="EQ Mid" value={slot.effects.eqMid ?? 0} min={-12} max={12} step={0.5} defaultValue={0}
          displayValue={`${(slot.effects.eqMid ?? 0) > 0 ? "+" : ""}${(slot.effects.eqMid ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqMid: v })} />
        <Knob label="EQ Hi" value={slot.effects.eqHigh ?? 0} min={-12} max={12} step={0.5} defaultValue={0}
          displayValue={`${(slot.effects.eqHigh ?? 0) > 0 ? "+" : ""}${(slot.effects.eqHigh ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqHigh: v })} />
        <Knob label="Phaser" value={slot.effects.phaserWet ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.phaserWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ phaserWet: v })} />
        <Knob label="Chorus" value={slot.effects.chorusWet ?? 0} min={0} max={1} step={0.01} defaultValue={0}
          displayValue={`${Math.round((slot.effects.chorusWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ chorusWet: v })} />
        <div className="flex flex-col items-center justify-end gap-0.5 ml-auto">
          <button type="button" onClick={handleReset}
            className="rounded px-2 py-1 text-[9px] uppercase tracking-wide font-semibold text-foreground/30 bg-muted/60 hover:text-foreground/60 hover:bg-muted transition">
            ↺ Reset
          </button>
        </div>
      </div>

      {/* Presets dropdown */}
      <div className="relative border-t border-border/50 pt-3">
        <button
          ref={presetsBtnRef}
          type="button"
          onClick={() => setPresetsPanelOpen((o) => !o)}
          className="text-[10px] uppercase tracking-wide text-foreground/40 hover:text-foreground/70 transition"
        >
          Presets {presets.length > 0 ? `(${presets.length})` : ""}{activePreset ? ` · ${activePreset}` : ""} {presetsPanelOpen ? "▲" : "▼"}
        </button>
        {presetsPanelOpen && (
          <div
            ref={presetsPanelRef}
            className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-md border border-border bg-background shadow-lg p-3 flex flex-col gap-2"
          >
            {presets.length === 0 && (
              <div className="text-xs text-foreground/40">No presets saved yet</div>
            )}
            {presets.map((p) => (
              <div key={p.name} className={cn(
                "group flex items-center rounded-md border px-2 py-1.5",
                activePreset === p.name ? "border-accent/50 bg-accent/10" : "border-border bg-muted/50",
              )}>
                <button type="button" onClick={() => applyPreset(p)}
                  className={cn("text-sm font-medium transition whitespace-nowrap", activePreset === p.name ? "text-accent" : "text-foreground/60 hover:text-foreground")}>
                  {p.name}
                </button>
                <button type="button" onClick={() => {
                    onSavePreset(p.name, { effects: slot.effects, speed: slot.speed, pitch: slot.pitch, linkPitch: slot.linkPitch, gain: slot.gain });
                    setActivePreset(p.name);
                  }}
                  className="text-base leading-none text-foreground/20 opacity-0 transition hover:text-accent group-hover:opacity-100 pl-3"
                  aria-label="Resave preset" title="Resave with current settings">💾</button>
                <span className="flex-1" />
                <button type="button" onClick={() => { onDeletePreset(p.name); if (activePreset === p.name) setActivePreset(null); }}
                  className="text-base leading-none text-foreground/20 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                  aria-label="Delete preset">✕</button>
              </div>
            ))}
            <form onSubmit={handleSavePreset} className="flex gap-1.5 items-center pt-1 border-t border-border/40">
              <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)}
                placeholder="Save preset…"
                className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm text-foreground/70 placeholder:text-foreground/30 outline-none focus:border-accent/60" />
              {presetName.trim() && (
                <button type="submit"
                  className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-foreground/50 hover:text-foreground">
                  Save
                </button>
              )}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
