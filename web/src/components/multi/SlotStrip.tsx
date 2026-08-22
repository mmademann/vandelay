import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { snapLoop, estimateBpm, snapDelayToTempo } from "../../lib/loopSnap";
import { multiEngine } from "../../audio/multiEngine";
import type { MultiSlot } from "../../lib/multiSettings";
import { Knob } from "./Knob";
import {
  saveSlotSettings,
  type MultiPreset,
} from "../../lib/multiSettings";
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

const WAVEFORM_H = 56;
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

  // Playhead — clamped inside the loop region. A stopped slot keeps its startOffset
  // when the loop handles move, so an unclamped line can sit outside the brackets.
  const clamped =
    loopEndRatio > loopStartRatio
      ? Math.max(loopStartRatio, Math.min(loopEndRatio, playRatio))
      : playRatio;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  // Keep the full 1px width visible at the right edge rather than half-clipped.
  ctx.fillRect(Math.min(Math.floor(clamped * w), Math.floor(w) - 1), 0, 1, h);
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

function formatTime(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

// --- SlotStrip ---

interface Props {
  slot: MultiSlot;
  title: string;
  buffer: AudioBuffer | null;
  presets: MultiPreset[];
  isReference: boolean;
  hasReference: boolean;
  isMatched: boolean;
  matchedBasePitch: number;
  pitchInterval: 1 | 7 | 12;
  onPitchIntervalChange: (n: 1 | 7 | 12) => void;
  onRemove: () => void;
  onChange: (patch: Partial<MultiSlot>) => void;
  onSetReference: () => void;
  onMatch: () => void;
  /** Tempo anchor — separate from the key anchor; drives stretch, not speed/pitch. */
  isTempoAnchor: boolean;
  hasTempoAnchor: boolean;
  onSetTempoAnchor: () => void;
  onTempoMatch: () => void;
  /** Apply an explicit stretch ratio (1 = original length). Rebuilds the buffer, so it is
   *  driven from the knob's commit rather than its drag. */
  onStretchChange: (ratio: number) => void;
  /** Length multiple currently applied; 1 = original audio. */
  stretch: number;
  stretching: boolean;
  onSavePreset: (name: string, preset: Omit<MultiPreset, "name">) => void;
  masterSpeed: number;
  /** Detected tempo for this stem, if analysis produced one. Drives Snap Loop. */
  detectedBpm: number | undefined;
  /** Tempo anchor's BPM, when one is set. Snapping to this rather than the slot's own tempo
   *  is what lands every slot on one shared grid. */
  anchorBpm: number | undefined;
  /** True when this slot's stretch no longer agrees with the anchor's current tempo —
   *  usually because the anchor itself changed after this slot was matched. */
  tempoStale: boolean;
  onDeletePreset: (name: string) => void;
  onApplyPreset: (preset: MultiPreset) => void;
}

export function SlotStrip({ slot, title, buffer, presets, masterSpeed, detectedBpm, anchorBpm, tempoStale, isReference, hasReference, isMatched, matchedBasePitch, pitchInterval, onPitchIntervalChange, onRemove, onChange, onSetReference, onMatch, isTempoAnchor, hasTempoAnchor, onSetTempoAnchor, onTempoMatch, onStretchChange, stretch, stretching, onSavePreset, onDeletePreset, onApplyPreset }: Props) {
  const [presetName, setPresetName] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [throwActive, setThrowActive] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [presetsPanelOpen, setPresetsPanelOpen] = useState(false);
  const presetsPanelRef = useRef<HTMLDivElement>(null);
  const presetsBtnRef = useRef<HTMLButtonElement>(null);

  // Keep isPlaying and throwActive in sync with engine state
  useEffect(() => {
    const id = setInterval(() => {
      setIsPlaying(multiEngine.isSlotPlaying(slot.id));
      setThrowActive(multiEngine.isThrowActive(slot.id));
      setCurrentTime(multiEngine.getSlotPosition(slot.id));
      // Catches seeks made elsewhere (Rewind All) — a stopped slot has no repaint loop.
      setSeekRevision(multiEngine.getSeekNonce(slot.id));
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

  async function handlePlayStop(instant = false) {
    if (isPlaying) {
      multiEngine.stopSlot(slot.id, instant);
      setIsPlaying(false);
    } else {
      await multiEngine.playSlot(slot.id, instant);
      setIsPlaying(true);
    }
  }

  function persistSettings(patch: Partial<MultiSlot>, overridePitchInterval?: 1 | 7 | 12) {
    const merged = { ...slot, ...patch };
    const dur = (buffer?.duration ?? 0) > 0 ? buffer!.duration : 1;
    saveSlotSettings(slot.id, {
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
      bypassMasterSpeed: merged.bypassMasterSpeed,
      // saveSlotSettings replaces the whole record; without this every knob turn would
      // wipe the slot's stretch and it would load unstretched after a refresh.
      stretch,
    });
  }

  function update(patch: Partial<MultiSlot>) {
    multiEngine.updateSlot(slot.id, patch);
    onChange(patch);
    persistSettings(patch);
    if (patch.speed !== undefined || patch.pitch !== undefined || patch.linkPitch !== undefined) {
      setActivePreset(null);
    }
  }

  function updateEffect(patch: Partial<MultiSlot["effects"]>) {
    const effects = { ...slot.effects, ...patch };
    multiEngine.updateSlot(slot.id, { effects });
    onChange({ effects });
    persistSettings({ effects });
    setActivePreset(null);
  }

  function handleReset() {
    const patch = { effects: { ...DRY_EFFECTS, phaserWet: 0, chorusWet: 0 }, speed: 1, pitch: 0, linkPitch: true, gain: 0 };
    multiEngine.updateSlot(slot.id, patch);
    onChange(patch);
    persistSettings(patch);
    setActivePreset(null);
  }

  function applyPreset(preset: MultiPreset) {
    onApplyPreset(preset);
    setActivePreset(preset.name);
  }

  // A bypassed slot is unaffected by master, so its readout stays plain.
  const effectiveMasterSpeed = slot.bypassMasterSpeed ? 1 : masterSpeed;
  // Stretched away from its source length means this slot is holding a tempo match.
  const isTempoMatched = !isTempoAnchor && Math.abs(stretch - 1) > 0.005;

  /**
   * Knob position while dragging. The applied stretch only changes on release — rebuilding
   * the buffer per frame would be both far too slow and audibly destructive — so the knob
   * needs its own value to follow the pointer in the meantime.
   */
  // Delay syncs to the anchor's grid when one exists, so every slot's echoes agree; without
  // an anchor it falls back to this slot's own tempo rather than going unsynced.
  const delayBpm = anchorBpm ?? detectedBpm;
  /** Division the current delay time sits on, when synced. Null at zero — a delay of 0 is
   *  "off", not a musical value, and snapping it would make it impossible to turn off. */
  const delaySync = slot.effects.delayTime > 0.001
    ? snapDelayToTempo(slot.effects.delayTime, delayBpm, EFFECTS_LIMITS.delayTime.max)
    : null;

  const [pendingStretch, setPendingStretch] = useState<number | null>(null);
  // Drop the pending value once the prop catches up, so external changes (Match Tempos,
  // session load) are not masked by a stale drag position.
  useEffect(() => { setPendingStretch(null); }, [stretch]);
  const shownStretch = pendingStretch ?? stretch;
  /** What the last snap did. Persists so the loop's bar count stays readable, and is
      cleared when the loop moves — a stale "2 bars" over a dragged region would lie.
      `detail` is the full explanation, surfaced on hover so the inline note stays short. */
  const [snapNote, setSnapNote] = useState<{ text: string; detail: string; ok: boolean } | null>(null);
  /** Loop bounds the note was computed for, so an unrelated re-render doesn't clear it. */
  const snapBoundsRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    const b = snapBoundsRef.current;
    if (!b) return;
    // Sub-ms tolerance: the note is only invalidated by a real edit, not float noise.
    if (Math.abs(slot.loopStart - b.start) > 1e-4 || Math.abs(slot.loopEnd - b.end) > 1e-4) {
      snapBoundsRef.current = null;
      setSnapNote(null);
    }
  }, [slot.loopStart, slot.loopEnd]);

  function handleSnapLoop() {
    if (!buffer) return;
    // Fall back to measuring the buffer directly. Essentia's cached BPM is often missing
    // — unpitched stems used to fail key detection and lose their tempo with it — and the
    // snap is useless without one, so don't depend on the cache being populated.
    // Anchor's grid wins: two slots each snapped to their own detected tempo are both
    // "snapped" and still drift apart. Falls back to this slot's own tempo with no anchor.
    const bpm = anchorBpm ?? detectedBpm ?? estimateBpm(buffer);
    const r = snapLoop(buffer, slot.loopStart, slot.loopEnd, bpm);
    update({ loopStart: r.loopStart, loopEnd: r.loopEnd });
    // Remember what the note describes; the effect above clears it if the loop moves off this.
    snapBoundsRef.current = { start: r.loopStart, end: r.loopEnd };

    if (r.mode === "grid") {
      // Sub-bar regions round to beats; reporting those as a fraction of a bar
      // ("0.25 bars") reads as a bug rather than as one beat.
      const n = r.bars ?? r.beats!;
      const unit = r.bars !== undefined ? "bar" : "beat";
      const plural = `${n} ${unit}${n === 1 ? "" : "s"}`;
      setSnapNote({
        text: `${plural} · ${Math.round(bpm!)} bpm`,
        detail: `Loop is now exactly ${plural} at ${Math.round(bpm!)} bpm, with both ends on zero crossings.`,
        ok: true,
      });
      return;
    }

    // Every fallback still de-clicked the loop; say what was skipped and why.
    const detail = {
      "no-tempo":
        "No steady tempo found in this audio, so the loop length was left as you set it. Ends were aligned to zero crossings to remove clicks — the loop may still drift against the beat.",
      "no-room":
        "Not enough audio after the loop start to fit a whole bar. Move the start earlier, then snap again. Ends were aligned to zero crossings.",
      "too-short":
        "Loop region is shorter than half a beat, so there is no bar or beat to round to. Ends were aligned to zero crossings.",
    }[r.reason ?? "no-tempo"];

    const label = { "no-tempo": "no tempo", "no-room": "no room", "too-short": "too short" }[
      r.reason ?? "no-tempo"
    ];

    setSnapNote({ text: `${label} · de-clicked`, detail, ok: false });
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
      "flex flex-col gap-2 rounded-md border bg-muted/30 p-3 transition",
      slot.muted && "opacity-40",
      isReference ? "border-accent/60 ring-1 ring-accent/20 bg-accent/5" : "border-border",
    )}>
      {/* Header: two rows — title row + controls row */}
      <div className="flex flex-col gap-1.5">
        {/* Row 1: stem label + title + remove */}
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            slot.stemName ? STEM_COLORS[slot.stemName as StemName] : "bg-zinc-500/15 text-zinc-400"
          )}>
            {slot.stemName ? STEM_LABELS[slot.stemName as StemName] : "Track"}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/70">{title}</span>
          <button type="button" onClick={onRemove}
            className="shrink-0 text-foreground/20 transition hover:text-red-400 text-sm px-1"
            aria-label="Remove slot" title="Remove slot">🗑</button>
        </div>
        {/* Row 2: playback controls + key/match badges — wraps on narrow slots */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {isPlaying ? (
            /* Split control: left half stops at once, right half fades out over 10s. */
            <div className={cn("flex items-stretch overflow-hidden rounded", !buffer && "opacity-30")}>
              <button type="button" onClick={() => handlePlayStop(true)} disabled={!buffer}
                title="Pause immediately"
                className={cn("px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
                  "bg-accent/25 text-accent hover:bg-accent/35",
                  !buffer && "cursor-not-allowed")}>
                ⏸ Pause
              </button>
              <button type="button" onClick={() => handlePlayStop(false)} disabled={!buffer}
                title="Pause with fade-out"
                className={cn("border-l border-background/40 px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
                  "bg-accent/25 text-accent hover:bg-accent/35",
                  !buffer && "cursor-not-allowed")}>
                Fade
              </button>
            </div>
          ) : (
            /* Split control: left half starts at full gain, right half fades in over 10s. */
            <div className={cn("flex items-stretch overflow-hidden rounded", !buffer && "opacity-30")}>
              <button type="button" onClick={() => handlePlayStop(true)} disabled={!buffer}
                title="Play immediately"
                className={cn("px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
                  "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
                  !buffer && "cursor-not-allowed")}>
                ▶ Play
              </button>
              <button type="button" onClick={() => handlePlayStop(false)} disabled={!buffer}
                title="Play with fade-in"
                className={cn("border-l border-background/40 px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
                  "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
                  !buffer && "cursor-not-allowed")}>
                Fade
              </button>
            </div>
          )}
          <button type="button" onClick={() => { multiEngine.seekSlot(slot.id, slot.loopStart); setSeekRevision(multiEngine.getSeekNonce(slot.id)); }} disabled={!buffer}
            className={cn("rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}
            title="Rewind to loop start">
            ⏮
          </button>
          <button type="button" onClick={() => update({ soloed: !slot.soloed })}
            className={cn("rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
              slot.soloed ? "bg-yellow-500/25 text-yellow-400 ring-1 ring-yellow-500/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted")}>
            ✦ Solo
          </button>
          <button type="button" onClick={() => update({ muted: !slot.muted })}
            className={cn("rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
              slot.muted ? "bg-red-500/25 text-red-400 ring-1 ring-red-500/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted")}>
            {slot.muted ? "✕ Muted" : "◎ Mute"}
          </button>
          <button type="button" onClick={() => multiEngine.throwSlot(slot.id)} disabled={!buffer}
            className={cn("rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
              throwActive
                ? "bg-teal-500/25 text-teal-400 ring-1 ring-teal-400/60"
                : "bg-muted/80 text-foreground/50 hover:text-teal-400 hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}
            title="Throw — tape echo burst + spring reverb">
            ↯ Throw
          </button>
          <button type="button"
            onClick={() => update({
              // Linked pitch so the slowdown drags pitch with it — the screwed sound.
              speed: 0.75,
              linkPitch: true,
              effects: { ...slot.effects, reverbWet: 0.4, reverbDecay: 4 },
            })}
            className="rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted"
            title="Screw — 75% speed (linked pitch) + reverb">
            ☾ Screw
          </button>
          <button type="button" onClick={handleSnapLoop} disabled={!buffer}
            className={cn("rounded px-2 py-1 text-xs font-bold uppercase tracking-wide transition",
              "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
              !buffer && "opacity-30 cursor-not-allowed")}
            title={anchorBpm
              ? `Snap loop to whole bars at ${Math.round(anchorBpm)} BPM — the tempo anchor's grid — then to zero crossings`
              : detectedBpm
              ? `Snap loop to whole bars at ${Math.round(detectedBpm)} BPM (this slot's own tempo), then to zero crossings`
              : "Snap loop to whole bars (tempo measured from the audio), then to zero crossings"}>
            ⇥ Snap
          </button>
          {snapNote && (
            <span
              title={snapNote.detail}
              className={cn(
                "cursor-help self-center text-[9px] uppercase tracking-wide",
                snapNote.ok ? "text-accent/70" : "text-amber-400/80",
              )}
            >
              {snapNote.text}
            </span>
          )}
          {/* Tempo anchor — same state-driven shape as the key anchor, but drives
              time stretch instead of speed/pitch, so both can be active on one slot. */}
          <button
            type="button"
            onClick={isTempoAnchor || !hasTempoAnchor ? onSetTempoAnchor : onTempoMatch}
            disabled={stretching || !buffer}
            title={
              isTempoAnchor
                ? "This slot is the tempo anchor — click to unpin"
                : !hasTempoAnchor
                  ? "Set as the tempo anchor"
                  : tempoStale
                    ? "Out of sync with the tempo anchor — the anchor's tempo changed after this slot was matched. Click to re-match."
                    : isTempoMatched
                      ? `Tempo matched at ${Math.round(stretch * 100)}% — click to re-match`
                      : "Match to the tempo anchor (pitch unchanged)"
            }
            className={cn(
              "shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition",
              stretching && "opacity-60",
              !buffer && "opacity-30 cursor-not-allowed",
              isTempoAnchor
                ? "border-orange-400/50 bg-orange-500/20 text-orange-300"
                : tempoStale
                  ? "border-amber-400/60 bg-amber-500/20 text-amber-300 animate-pulse"
                  : isTempoMatched
                    ? "border-orange-400/30 bg-orange-500/10 text-orange-300/70 hover:bg-orange-500/20 hover:text-orange-300"
                    : "border-border/60 bg-muted/60 text-foreground/40 hover:border-orange-400/40 hover:text-orange-300",
            )}
          >
            {stretching
              ? "Stretching…"
              : isTempoAnchor
                ? "⚓ Tempo Anchor"
                : !hasTempoAnchor
                  ? "Set Tempo Anchor"
                  : tempoStale
                    ? "↻ Re-lock Tempo"
                    : isTempoMatched
                      ? `Tempo Matched ${Math.round(stretch * 100)}% ↻`
                      : "Match Tempo"}
          </button>

          {/* One control for the whole anchor/match cycle. Label and action follow state:
              no anchor anywhere -> pin this slot; anchor elsewhere -> match to it;
              already matched -> re-match (it can drift when speed/pitch are nudged). */}
          <button
            type="button"
            onClick={isReference || !hasReference ? onSetReference : onMatch}
            title={
              isReference
                ? "This slot is the key anchor — click to unpin"
                : !hasReference
                  ? "Set as the key anchor"
                  : isMatched
                    ? "Already key matched — click to re-match"
                    : "Match to the key anchor"
            }
            className={cn(
              "shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition",
              isReference
                ? "border-accent/50 bg-accent/20 text-accent"
                : isMatched
                  ? "border-accent/30 bg-accent/10 text-accent/70 hover:bg-accent/20 hover:text-accent"
                  : "border-border/60 bg-muted/60 text-foreground/40 hover:border-accent/40 hover:text-accent",
            )}
          >
            {isReference
              ? "⚓ Key Anchor"
              : !hasReference
                ? "Set Key Anchor"
                : isMatched
                  ? "Key Matched ↻"
                  : "Match Key"}
          </button>



          {/* Semitone shift — always live, independent of match state. */}
          <span className="shrink-0 flex items-center gap-0 overflow-hidden rounded border border-border/50 bg-muted/40">
            {([1, 7, 12] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { onPitchIntervalChange(n); persistSettings({}, n); }}
                title={`Step by ${n} semitone${n > 1 ? "s" : ""}`}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] font-semibold transition",
                  n !== 1 && "border-l border-border/40",
                  pitchInterval === n
                    ? "bg-accent/20 text-accent"
                    : "text-foreground/30 hover:text-foreground/60 hover:bg-muted/60",
                )}
              >{n}</button>
            ))}
            <button
              type="button"
              title={`Down ${pitchInterval} semitone${pitchInterval > 1 ? "s" : ""}`}
              onClick={() => {
                // Matched slots step on a grid anchored at their match pitch so repeated
                // shifts stay musically related to the anchor; unmatched slots step freely.
                const base = isMatched ? matchedBasePitch : slot.pitch;
                const diff = slot.pitch - base;
                const step = Math.floor(diff / pitchInterval);
                const snapped = base + step * pitchInterval;
                const next = Math.max(-24, Math.abs(snapped - slot.pitch) < 0.01 ? snapped - pitchInterval : snapped);
                update({ pitch: next, linkPitch: false });
              }}
              className="border-l border-border/40 px-1.5 py-0.5 text-[11px] text-foreground/40 transition hover:bg-muted/60 hover:text-foreground"
            >▼</button>
            <button
              type="button"
              title={`Up ${pitchInterval} semitone${pitchInterval > 1 ? "s" : ""}`}
              onClick={() => {
                const base = isMatched ? matchedBasePitch : slot.pitch;
                const diff = slot.pitch - base;
                const step = Math.ceil(diff / pitchInterval);
                const snapped = base + step * pitchInterval;
                const next = Math.min(24, Math.abs(snapped - slot.pitch) < 0.01 ? snapped + pitchInterval : snapped);
                update({ pitch: next, linkPitch: false });
              }}
              className="border-l border-border/40 px-1.5 py-0.5 text-[11px] text-foreground/40 transition hover:bg-muted/60 hover:text-foreground"
            >▲</button>
          </span>


        </div>
      </div>

      {/* Waveform */}
      {buffer ? (
        <div className="relative">
          <SlotWaveform
            buffer={buffer}
            isPlaying={isPlaying}
            loopStart={slot.loopStart}
            loopEnd={slot.loopEnd}
            seekRevision={seekRevision}
            getPosition={() => multiEngine.getSlotPosition(slot.id)}
            onLoopChange={(start, end) => update({ loopStart: start, loopEnd: end })}
            onSeek={(time) => { multiEngine.seekSlot(slot.id, time); setSeekRevision(multiEngine.getSeekNonce(slot.id)); }}
          />
          <div className="pointer-events-none absolute bottom-1 left-1.5 flex gap-1.5 text-[9px] font-mono tabular-nums text-white/40">
            <span>{formatTime(currentTime)}</span>
            <span className="text-white/20">/</span>
            <span>{formatTime(slot.loopEnd - slot.loopStart)}</span>
          </div>
        </div>
      ) : (
        <div style={{ height: WAVEFORM_H }} className="w-full rounded bg-muted/30 flex items-center justify-center text-[10px] text-foreground/20">
          loading…
        </div>
      )}

      {/* Knobs */}
      <div className="flex flex-wrap gap-x-3 gap-y-2 border-t border-border/50 pt-2">
        <Knob label="Gain" value={slot.gain} min={-60} max={6} step={0.5} defaultValue={0} size={40}
          displayValue={slot.gain <= -60 ? "−∞" : `${slot.gain > 0 ? "+" : ""}${slot.gain.toFixed(1)}dB`}
          onChange={(v) => update({ gain: v })} />
        <div className="flex flex-col items-center gap-0.5">
          {/* The knob sets this slot's own speed; master multiplies it. When master is
              engaged the readout shows the rate actually playing, with the base beneath. */}
          <Knob label="Speed" value={slot.speed} min={0.1} max={2} step={0.01} defaultValue={1} size={40}
            displayValue={
              effectiveMasterSpeed === 1
                ? `${slot.speed.toFixed(2)}×`
                : `${(slot.speed * effectiveMasterSpeed).toFixed(2)}×`
            }
            onChange={(v) => update({ speed: v })} />
          {effectiveMasterSpeed !== 1 && (
            <span className="text-[8px] uppercase tracking-wide text-foreground/25">
              base {slot.speed.toFixed(2)}
            </span>
          )}
          {/* Speed resamples, so it moves tempo and pitch together and breaks both matches
              at once. Warn rather than disable — deliberately detuning a slot is a valid move. */}
          {isTempoMatched && (
            <span
              className="text-[8px] uppercase tracking-wide text-amber-400/70 cursor-help"
              title="This slot is tempo matched. The Speed knob resamples, so it changes tempo and pitch together and will break the match. Use Stretch to change tempo without touching pitch."
            >
              ⚠ breaks match
            </span>
          )}
          <button type="button"
            onClick={() => update({ bypassMasterSpeed: !slot.bypassMasterSpeed })}
            title={slot.bypassMasterSpeed
              ? "This slot ignores the master speed dial — click to follow it again"
              : "This slot follows the master speed dial — click to hold it at its own speed"}
            className={cn("rounded px-2 py-0.5 text-[8px] uppercase tracking-wide font-semibold transition whitespace-nowrap",
              slot.bypassMasterSpeed
                ? "bg-amber-500/25 text-amber-400"
                : "bg-muted text-foreground/30 hover:text-foreground/60")}>
            {slot.bypassMasterSpeed ? "master: off" : "master: on"}
          </button>
        </div>

        {/* Time stretch — the pitch-safe counterpart to Speed. Committed on release because
            each change rebuilds the whole buffer; the knob tracks the pointer meanwhile. */}
        <div className="flex flex-col items-center gap-0.5">
          <Knob label="Stretch" value={shownStretch} min={0.5} max={2} step={0.01} defaultValue={1} size={40}
            disabled={!buffer || stretching}
            displayValue={`${Math.round(shownStretch * 100)}%`}
            onChange={(v) => setPendingStretch(v)}
            onCommit={(v) => { setPendingStretch(null); onStretchChange(v); }} />
          {stretching ? (
            <span className="text-[8px] uppercase tracking-wide text-orange-300/70">working…</span>
          ) : pendingStretch !== null ? (
            <span className="text-[8px] uppercase tracking-wide text-foreground/30">release to apply</span>
          ) : Math.abs(stretch - 1) > 0.005 ? (
            <span className="text-[8px] uppercase tracking-wide text-foreground/25">2× click resets</span>
          ) : null}
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <Knob label="Pitch" value={slot.pitch} min={-24} max={24} step={1} defaultValue={0} size={40}
            displayValue={`${slot.pitch > 0 ? "+" : ""}${slot.pitch}st`} disabled={slot.linkPitch}
            onChange={(v) => update({ pitch: v })} />
          <button type="button" onClick={() => update({ linkPitch: !slot.linkPitch })}
            className={cn("rounded px-2 py-0.5 text-[9px] uppercase tracking-wide font-semibold transition",
              slot.linkPitch ? "bg-accent/25 text-accent" : "bg-muted text-foreground/30 hover:text-foreground/60")}>
            Link
          </button>
        </div>
        <Knob label="Reverb" value={slot.effects.reverbWet} min={EFFECTS_LIMITS.reverbWet.min} max={EFFECTS_LIMITS.reverbWet.max} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round(slot.effects.reverbWet * 100)}%`} onChange={(v) => updateEffect({ reverbWet: v })} />
        <Knob label="Decay" value={slot.effects.reverbDecay} min={EFFECTS_LIMITS.reverbDecay.min} max={EFFECTS_LIMITS.reverbDecay.max} step={0.1} defaultValue={0.1} size={40}
          displayValue={`${slot.effects.reverbDecay.toFixed(1)}s`} onChange={(v) => updateEffect({ reverbDecay: v })} />
        <Knob label="Delay" value={slot.effects.delayWet} min={EFFECTS_LIMITS.delayWet.min} max={EFFECTS_LIMITS.delayWet.max} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round(slot.effects.delayWet * 100)}%`} onChange={(v) => updateEffect({ delayWet: v })} />
        <Knob label="D.Time" value={slot.effects.delayTime} min={EFFECTS_LIMITS.delayTime.min} max={EFFECTS_LIMITS.delayTime.max} step={0.01} defaultValue={0} size={40}
          displayValue={delaySync ? `${delaySync.label} · ${Math.round(slot.effects.delayTime * 1000)}ms` : `${slot.effects.delayTime.toFixed(2)}s`}
          onChange={(v) => {
            // Snap while dragging so the knob lands on divisions rather than sliding past
            // them — a delay one frame off the grid is exactly what this is preventing.
            // Below the smallest division, let it fall to a true zero so the delay can be
            // switched off rather than sticking at 1/32.
            const snapped = v < 0.02 ? null : snapDelayToTempo(v, delayBpm, EFFECTS_LIMITS.delayTime.max);
            updateEffect({ delayTime: v < 0.02 ? 0 : snapped ? snapped.seconds : v });
          }} />
        <Knob label="D.Feedbk" value={slot.effects.delayFeedback} min={EFFECTS_LIMITS.delayFeedback.min} max={EFFECTS_LIMITS.delayFeedback.max} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round(slot.effects.delayFeedback * 100)}%`} onChange={(v) => updateEffect({ delayFeedback: v })} />
        <Knob label="Bass" value={slot.effects.bassBoost} min={EFFECTS_LIMITS.bassBoost.min} max={EFFECTS_LIMITS.bassBoost.max} step={1} defaultValue={0} size={40}
          displayValue={`${slot.effects.bassBoost > 0 ? "+" : ""}${Math.round(slot.effects.bassBoost)}dB`} onChange={(v) => updateEffect({ bassBoost: v })} />
        <Knob label="Grit" value={slot.effects.grit ?? 0} min={0} max={1} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round((slot.effects.grit ?? 0) * 100)}%`} onChange={(v) => updateEffect({ grit: v })} />
        {/* Hidden from the rack, but the effects and their saved values are untouched —
            uncomment to bring the knobs back.
        <Knob label="S.Echo" value={slot.effects.spaceEchoWow ?? 0} min={0} max={1} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round((slot.effects.spaceEchoWow ?? 0) * 100)}%`} onChange={(v) => updateEffect({ spaceEchoWow: v })} />
        <Knob label="B.Knob" value={slot.effects.bigKnobWet ?? 0} min={0} max={1} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round((slot.effects.bigKnobWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ bigKnobWet: v })} />
        */}
        <Knob label="EQ Lo" value={slot.effects.eqLow ?? 0} min={-12} max={12} step={0.5} defaultValue={0} size={40}
          displayValue={`${(slot.effects.eqLow ?? 0) > 0 ? "+" : ""}${(slot.effects.eqLow ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqLow: v })} />
        <Knob label="EQ Mid" value={slot.effects.eqMid ?? 0} min={-12} max={12} step={0.5} defaultValue={0} size={40}
          displayValue={`${(slot.effects.eqMid ?? 0) > 0 ? "+" : ""}${(slot.effects.eqMid ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqMid: v })} />
        <Knob label="EQ Hi" value={slot.effects.eqHigh ?? 0} min={-12} max={12} step={0.5} defaultValue={0} size={40}
          displayValue={`${(slot.effects.eqHigh ?? 0) > 0 ? "+" : ""}${(slot.effects.eqHigh ?? 0).toFixed(1)}dB`} onChange={(v) => updateEffect({ eqHigh: v })} />
        <Knob label="Phaser" value={slot.effects.phaserWet ?? 0} min={0} max={1} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round((slot.effects.phaserWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ phaserWet: v })} />
        <Knob label="Chorus" value={slot.effects.chorusWet ?? 0} min={0} max={1} step={0.01} defaultValue={0} size={40}
          displayValue={`${Math.round((slot.effects.chorusWet ?? 0) * 100)}%`} onChange={(v) => updateEffect({ chorusWet: v })} />
      </div>

      {/* Presets row */}
      <div className="relative flex items-center gap-2 border-t border-border/50 pt-2">
        <button
          ref={presetsBtnRef}
          type="button"
          onClick={() => setPresetsPanelOpen((o) => !o)}
          className="text-[10px] uppercase tracking-wide text-foreground/40 hover:text-foreground/70 transition text-left"
        >
          Presets {presets.length > 0 ? `(${presets.length})` : ""}{activePreset ? ` · ${activePreset}` : ""} {presetsPanelOpen ? "▲" : "▼"}
        </button>
        <span className="flex-1" />
        <button type="button" onClick={handleReset}
          className="rounded px-2 py-0.5 text-[9px] uppercase tracking-wide font-semibold text-foreground/25 hover:text-foreground/60 hover:bg-muted transition">
          ↺ Reset
        </button>
        {presetsPanelOpen && (
          <div
            ref={presetsPanelRef}
            className="absolute top-full left-0 z-50 mt-1 w-72 rounded-md border border-border bg-background shadow-lg p-3 flex flex-col"
          >
            <div className="overflow-y-auto max-h-56 flex flex-col gap-2 mb-2">
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
                    aria-label="Delete preset" title="Delete preset">🗑</button>
                </div>
              ))}
            </div>
            <form onSubmit={handleSavePreset} className="flex gap-1.5 items-center pt-2 border-t border-border/40">
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
