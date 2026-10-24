import { useEffect, useRef, useState } from "react";
import { multiEngine } from "../../audio/multiEngine";
import { renderMulti, canExportMulti } from "../../audio/renderMulti";
import { multiRecorder } from "../../audio/multiRecorder";
import {
  exportExtension,
  estimateExportBytes,
  formatFileSize,
  EXPORT_PRESETS,
  type ExportFormat,
  type ExportQuality,
} from "../../audio/exportOptions";
import type { MultiMasterSettings, MultiSlot, ThrowSettings, ThrowPreset } from "../../lib/multiSettings";
import { cn } from "../../lib/cn";
import { Knob } from "./Knob";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Resampling by a ratio shifts pitch by 12*log2(ratio) semitones. */
function formatSemitoneShift(rate: number): string {
  const semis = 12 * Math.log2(rate);
  if (Math.abs(semis) < 0.05) return "";
  return `${semis > 0 ? "+" : ""}${semis.toFixed(1)}st`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ThrowPanel({
  settings, onChange, presets, onSavePreset, onDeletePreset, onApplyPreset,
}: {
  settings: ThrowSettings;
  onChange: (s: ThrowSettings) => void;
  presets: ThrowPreset[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onApplyPreset: (preset: ThrowPreset) => void;
}) {
  const [presetName, setPresetName] = useState("");
  function set<K extends keyof ThrowSettings>(key: K, value: ThrowSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function handleSavePreset(e: React.FormEvent) {
    e.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    onSavePreset(name);
    setPresetName("");
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Delay knobs */}
      <div className="flex flex-col gap-2">
        <div className="text-[9px] uppercase tracking-widest text-foreground/30 border-b border-border/30 pb-1">
          Space Echo (Delay)
        </div>
        <div className="flex gap-4 flex-wrap">
          <Knob label="D.Time" value={settings.delayTime} min={0.05} max={2} step={0.01} defaultValue={0.25}
            displayValue={`${settings.delayTime.toFixed(2)}s`}
            onChange={(v) => set("delayTime", v)} />
          <Knob label="Feedbk" value={settings.delayFeedback} min={0} max={0.95} step={0.01} defaultValue={0.72}
            displayValue={`${Math.round(settings.delayFeedback * 100)}%`}
            onChange={(v) => set("delayFeedback", v)} />
          <Knob label="Wet" value={settings.delayWet} min={0} max={1} step={0.01} defaultValue={1.0}
            displayValue={`${Math.round(settings.delayWet * 100)}%`}
            onChange={(v) => set("delayWet", v)} />
        </div>
      </div>

      {/* Reverb knobs */}
      <div className="flex flex-col gap-2">
        <div className="text-[9px] uppercase tracking-widest text-foreground/30 border-b border-border/30 pb-1">
          Big Knob (Spring Reverb)
        </div>
        <div className="flex gap-4 flex-wrap">
          <Knob label="Decay" value={settings.reverbDecay} min={0.1} max={8} step={0.1} defaultValue={3.5}
            displayValue={`${settings.reverbDecay.toFixed(1)}s`}
            onChange={(v) => set("reverbDecay", v)} />
          <Knob label="Wet" value={settings.reverbWet} min={0} max={1} step={0.01} defaultValue={0.6}
            displayValue={`${Math.round(settings.reverbWet * 100)}%`}
            onChange={(v) => set("reverbWet", v)} />
        </div>
      </div>

      {/* Filter env knobs */}
      <div className="flex flex-col gap-2">
        <div className="text-[9px] uppercase tracking-widest text-foreground/30 border-b border-border/30 pb-1">
          Filter Env
        </div>
        <div className="flex gap-4 flex-wrap">
          <Knob label="Freq" value={settings.filterFreq} min={80} max={8000} step={10} defaultValue={700}
            displayValue={settings.filterFreq >= 1000 ? `${(settings.filterFreq / 1000).toFixed(1)}k` : `${Math.round(settings.filterFreq)}Hz`}
            onChange={(v) => set("filterFreq", v)} />
          <Knob label="Sweep" value={settings.filterSweep} min={0} max={1} step={0.01} defaultValue={0.5}
            displayValue={`${Math.round(settings.filterSweep * 100)}%`}
            onChange={(v) => set("filterSweep", v)} />
        </div>
      </div>

      {/* Presets */}
      <div className="border-t border-border/30 pt-3 flex flex-col gap-2">
        <div className="text-[9px] uppercase tracking-widest text-foreground/30">Presets</div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {presets.map((p) => (
            <div key={p.name} className="group flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2.5 py-1.5">
              <button type="button" onClick={() => onApplyPreset(p)}
                className="text-xs font-medium text-foreground/60 hover:text-teal-400 transition whitespace-nowrap">
                {p.name}
              </button>
              <button type="button" onClick={() => onDeletePreset(p.name)}
                title="Delete preset"
                className="text-xs text-foreground/20 opacity-0 group-hover:opacity-100 hover:text-red-400 transition pl-1 border-l border-border/50">
                🗑
              </button>
            </div>
          ))}
          <form onSubmit={handleSavePreset} className="flex gap-1.5 items-center">
            <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)}
              placeholder="Save preset…"
              className="w-28 rounded border border-border bg-muted/30 px-2 py-1 text-xs text-foreground/70 placeholder:text-foreground/30 outline-none focus:border-teal-500/60" />
            {presetName.trim() && (
              <button type="submit" className="rounded border border-border bg-muted/40 px-2 py-1 text-xs text-foreground/50 hover:text-foreground">
                Save
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

interface Props {
  masterSettings: MultiMasterSettings;
  slotCount: number;
  referenceSlotId: string | null;
  activeSessionName: string | null;
  slotTitles: string[];
  getSlotsAndBuffers: () => {
    slots: MultiSlot[];
    buffers: Map<string, AudioBuffer>;
    /** Anchor bar length per slot — the export needs it to reproduce each slot's phase. */
    phaseBarSec: Map<string, number>;
  };
  onStopAll: (fade?: boolean) => void;
  onPlayAll: (instant?: boolean) => void;
  onRewindAll: () => void;
  onThrowSettingsChange: (settings: ThrowSettings) => void;
  onMasterSpeedChange: (speed: number) => void;
  throwPresets: ThrowPreset[];
  onSaveThrowPreset: (name: string) => void;
  onDeleteThrowPreset: (name: string) => void;
  onApplyThrowPreset: (preset: ThrowPreset) => void;
  isPlaying: boolean;
  onMatchAll: () => void;
  onTempoMatchAll: () => void;
  onLockAll: () => void;
  /** Compute the ranking WITHOUT applying anything — opening the panel should not commit. */
  onComputeSuggestions: () => void;
  onPickSuggestion: (index: number) => void;
  suggestions: {
    why: string;
    score: number;
    label: { loop: string; tempoGroup: string; keyAnchor: string; separation: number; flavour: string };
  }[];
  suggestIndex: number | null;
  /** Undefined until a suggestion has been applied — there is nothing to undo before that. */
  onUndoSuggest?: () => void;
  suggestNote: string | null;
  suggestKeepLoops: boolean;
  onToggleKeepLoops: () => void;
  versions: {
    id: string;
    name: string;
    savedAt: number;
    /** What the suggestion row said, kept alongside the name. Absent for a hand-built rack. */
    from?: { flavour: string; loop: string; tempoGroup: string; keyAnchor: string; separation: number };
  }[];
  onSaveVersion: (name: string) => void;
  onRestoreVersion: (id: string) => void;
  onDeleteVersion: (id: string) => void;
  /** Any slot still decoding. Matching now would quantize against a half-loaded rack. */
  slotsLoading: boolean;
  gridNote: string | null;
  onDismissGridNote: () => void;
  /** Slots whose stretch no longer agrees with the anchor's current tempo. */
  staleTempoCount: number;
  onRelockStale: () => void;
  autoRelock: boolean;
  onToggleAutoRelock: () => void;
  tempoAnchorId: string | null;
  onRandomSession: () => void;
  randomDisabled: boolean;
}

function buildExportFilename(activeSessionName: string | null, slotTitles: string[]): string {
  if (activeSessionName) return activeSessionName;
  const unique = [...new Set(slotTitles.filter(Boolean))];
  if (unique.length === 0) return "multi-mix";
  if (unique.length <= 2) return unique.join(" × ");
  return `${unique.slice(0, 2).join(" × ")} +${unique.length - 2}`;
}

export function MultiTransport({ masterSettings, slotCount, referenceSlotId, activeSessionName, slotTitles, getSlotsAndBuffers, onStopAll, onPlayAll, onRewindAll, onThrowSettingsChange, onMasterSpeedChange, throwPresets, onSaveThrowPreset, onDeleteThrowPreset, onApplyThrowPreset, isPlaying, onMatchAll, onTempoMatchAll, onLockAll, onComputeSuggestions, onPickSuggestion, suggestions, suggestIndex, onUndoSuggest, suggestNote, suggestKeepLoops, onToggleKeepLoops, versions, onSaveVersion, onRestoreVersion, onDeleteVersion, slotsLoading, gridNote, onDismissGridNote, staleTempoCount, onRelockStale, autoRelock, onToggleAutoRelock, tempoAnchorId, onRandomSession, randomDisabled }: Props) {
  const [loopCount, setLoopCount] = useState(1);
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [recEncoding, setRecEncoding] = useState(false);
  /** Recording format is independent of the export panel — takes and exports have different needs. */
  const [recFormat, setRecFormat] = useState<ExportFormat>("wav");
  /** Separate from exportError — that only renders inside the export panel, which may be closed. */
  const [recError, setRecError] = useState<string | null>(null);
  /** Encoded take held pending a filename — set on stop, cleared on save or discard. */
  const [pendingTake, setPendingTake] = useState<{ blob: Blob; ext: string; seconds: number } | null>(null);
  const [takeName, setTakeName] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [versionName, setVersionName] = useState("");
  const suggestBtnRef = useRef<HTMLButtonElement>(null);
  const suggestPanelRef = useRef<HTMLDivElement>(null);

  // Close on an outside click, like the other floating panels here.
  useEffect(() => {
    if (!suggestOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (suggestPanelRef.current?.contains(t) || suggestBtnRef.current?.contains(t)) return;
      setSuggestOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [suggestOpen]);
  /** Filename of the last saved take — drives the transient "saved" confirmation. */
  const [savedTake, setSavedTake] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [quality, setQuality] = useState<ExportQuality>("full");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [throwPanelOpen, setThrowPanelOpen] = useState(false);
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  // Blank = use the auto-generated name (shown as the input's placeholder).
  const [filenameDraft, setFilenameDraft] = useState("");
  /**
   * Tracks the auto-filled name so a session change can replace it, while anything the user
   * typed is left alone. Without this the field either never updates or silently discards
   * an edit whenever the active session changes.
   */
  const autoFilledRef = useRef("");
  const throwPanelRef = useRef<HTMLDivElement>(null);
  const throwBtnRef = useRef<HTMLButtonElement>(null);
  const exportPanelRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  /** Anchors the pending-take panel so it can't be pushed off-screen by the transport row. */
  const recGroupRef = useRef<HTMLDivElement>(null);
  const masterLoopLength = multiEngine.getMasterLoopLength() ?? 0;
  const totalSec = masterLoopLength * loopCount;
  const estBytes = estimateExportBytes(totalSec, format, quality);
  const preset = EXPORT_PRESETS[quality];

  // Close panels on outside click
  useEffect(() => {
    if (!throwPanelOpen && !exportPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        throwPanelRef.current && !throwPanelRef.current.contains(e.target as Node) &&
        throwBtnRef.current && !throwBtnRef.current.contains(e.target as Node)
      ) {
        setThrowPanelOpen(false);
      }
      if (
        exportPanelRef.current && !exportPanelRef.current.contains(e.target as Node) &&
        exportBtnRef.current && !exportBtnRef.current.contains(e.target as Node)
      ) {
        setExportPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [throwPanelOpen, exportPanelOpen]);

  // Pre-fill the export filename from the session so it is editable text rather than a
  // grey placeholder — the common case is exporting under the session's own name.
  // Keyed on the joined titles, not the array: slotTitles is rebuilt every render, so the
  // array identity would re-run this constantly.
  const slotTitlesKey = slotTitles.join("|");
  useEffect(() => {
    const auto = buildExportFilename(activeSessionName, slotTitlesKey.split("|").filter(Boolean));
    setFilenameDraft((cur) => {
      if (cur && cur !== autoFilledRef.current) return cur; // user typed something — keep it
      autoFilledRef.current = auto;
      return auto;
    });
  }, [activeSessionName, slotTitlesKey]);

  // Tick the elapsed readout while recording.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecElapsed(multiRecorder.elapsed()), 200);
    return () => clearInterval(id);
  }, [recording]);

  // Don't leave a live tap on the master if the transport unmounts mid-take.
  useEffect(() => () => multiRecorder.cancel(), []);

  // The saved confirmation is transient — clear it so it can't be mistaken for a pending take.
  useEffect(() => {
    if (!savedTake) return;
    const id = setTimeout(() => setSavedTake(null), 4000);
    return () => clearTimeout(id);
  }, [savedTake]);

  // An unsaved take lives only in memory — warn before a reload throws it away.
  useEffect(() => {
    if (!pendingTake && !recording) return;
    function warn(e: BeforeUnloadEvent) { e.preventDefault(); }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingTake, recording]);

  function saveTake() {
    if (!pendingTake) return;
    const base = takeName.trim() || "take";
    downloadBlob(pendingTake.blob, `${base}.${pendingTake.ext}`);
    setPendingTake(null);
    setTakeName("");
    // The "save the current take first" warning is stale the moment the take is saved.
    setRecError(null);
    setSavedTake(`${base}.${pendingTake.ext}`);
  }

  function discardTake() {
    setPendingTake(null);
    setTakeName("");
    setRecError(null);
  }

  async function handleRecord() {
    if (recEncoding) return;
    setRecError(null);

    if (recording) {
      const seconds = multiRecorder.elapsed();
      setRecording(false);
      setRecEncoding(true);
      try {
        // Yield a frame before encoding. stop() stitches chunks and runs encodeExport
        // synchronously, blocking the main thread — without this the "Encoding…" state is
        // set but never painted, so stopping a take looks like nothing happened.
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        const blob = await multiRecorder.stop({ format: recFormat, quality });
        if (!blob) throw new Error("Recording was empty.");
        // Hold the take so it can be named before saving.
        setTakeName(buildExportFilename(activeSessionName, slotTitles));
        setPendingTake({ blob, ext: exportExtension(recFormat), seconds });
      } catch (e) {
        setRecError(e instanceof Error ? e.message : "Recording failed");
      } finally {
        setRecEncoding(false);
        setRecElapsed(0);
      }
      return;
    }

    // The pending take exists only in memory — starting over would lose it with no recovery.
    if (pendingTake) {
      setRecError("Save the current take first.");
      return;
    }

    try {
      await multiRecorder.start();
      setRecElapsed(0);
      setRecording(true);
    } catch (e) {
      console.error("[recorder] start failed", e);
      setRecError(e instanceof Error ? e.message : "Could not start recording");
    }
  }

  async function handleExport() {
    if (exporting) return;
    const { slots, buffers, phaseBarSec } = getSlotsAndBuffers();
    const loopLen = multiEngine.getMasterLoopLength() ?? 0;
    if (!canExportMulti({ slots, buffers, masterLoopLength: loopLen }) || loopLen <= 0) return;
    setExporting(true);
    setExportError(null);
    try {
      const blob = await renderMulti({
        slots,
        buffers,
        masterSettings,
        masterLoopLength: loopLen,
        loopCount,
        phaseBarSec,
        export: { format, quality },
      });
      if (blob.size < 44) throw new Error("Export produced an empty file.");
      const name = filenameDraft.trim() || buildExportFilename(activeSessionName, slotTitles);
      downloadBlob(blob, `${name}.${exportExtension(format)}`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  function handleThrowChange(settings: ThrowSettings) {
    multiEngine.setThrowSettings(settings);
    onThrowSettingsChange(settings);
  }

  return (
    // `display: contents` — this div draws nothing and every control below becomes a direct
    // flex item of the header row, so the π link, the session chip and all of these flow as
    // ONE line and wrap one button at a time.
    //
    // Any real wrapper here is an atomic box: the moment its contents do not fit, the whole
    // box drops to a line of its own and leaves a hole at the end of the line above. That is
    // what stranded Export, Random and Throw together on a second row. For the same reason
    // the buttons below are NOT grouped by subject — grouping is what caused it.
    //
    // The price is that a panel can no longer be positioned against this element, since it
    // has no box. Each button that owns a panel carries its own `relative` wrapper, which
    // also drops the panel directly under its own button instead of under the whole bar.
    <div className="contents">
        {/* Play All / Pause All + Rewind All */}
        {isPlaying && slotCount > 0 ? (
          /* Split control: left half stops at once, right half fades all slots out over 10s. */
          <div className="flex shrink-0 items-stretch overflow-hidden rounded">
            <button
              type="button"
              onClick={() => onStopAll(false)}
              disabled={slotCount === 0}
              title="Pause all immediately"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent transition hover:bg-accent/30 disabled:opacity-30"
            >
              ⏸ Pause All
            </button>
            <button
              type="button"
              onClick={() => onStopAll(true)}
              disabled={slotCount === 0}
              title="Pause all with fade-out"
              className="border-l border-background/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent transition hover:bg-accent/30 disabled:opacity-30"
            >
              Fade
            </button>
          </div>
        ) : (
          /* Split control: left half starts at full gain, right half fades all slots in over 10s. */
          <div className={cn("flex shrink-0 items-stretch overflow-hidden rounded", slotCount === 0 && "opacity-30")}>
            <button
              type="button"
              onClick={() => onPlayAll(true)}
              disabled={slotCount === 0}
              title="Play all immediately"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:cursor-not-allowed"
            >
              ▶ Play All
            </button>
            <button
              type="button"
              onClick={() => onPlayAll(false)}
              disabled={slotCount === 0}
              title="Play all with fade-in"
              className="border-l border-background/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:cursor-not-allowed"
            >
              Fade
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onRewindAll}
          disabled={slotCount === 0}
          className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
          title="Rewind all to loop start"
        >
          ⏮
        </button>
        <div ref={recGroupRef} className="relative flex shrink-0 items-center">
          <button
            type="button"
            onClick={handleRecord}
            disabled={slotCount === 0 || recEncoding}
            title={recording ? "Stop and save recording" : "Record master output live"}
            className={cn(
              "rounded-l px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              // Encoding is a real wait on long takes; keep it fully opaque and clearly
              // active rather than letting disabled:opacity-30 fade the only feedback out.
              recEncoding
                ? "bg-muted text-foreground/70 ring-1 ring-border/70 opacity-100"
                : recording
                  ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/40 hover:bg-red-500/30 disabled:opacity-30"
                  : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted disabled:opacity-30",
            )}
          >
            {recEncoding ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70" />
                Encoding…
              </span>
            ) : recording ? (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                ■ Stop {formatDuration(recElapsed)}
              </span>
            ) : (
              "● Rec"
            )}
          </button>
          {/* Format locked mid-take — the encode target is fixed once samples start arriving. */}
          <button
            type="button"
            onClick={() => setRecFormat((f) => (f === "wav" ? "mp3" : "wav"))}
            disabled={recording || recEncoding}
            title={`Recording format: ${recFormat.toUpperCase()} — click to switch`}
            className="rounded-r border-l border-background/40 bg-muted/80 px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-foreground/40 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
          >
            {recFormat}
          </button>

          {/* Anchored to the Rec button rather than inline in the transport row — the row
              overflows once enough controls are present and the form scrolled out of view. */}
          {pendingTake && (
            <form
              className="absolute left-0 top-full z-30 mt-2 flex w-max items-center gap-1.5 rounded-md border border-red-500/40 bg-background/95 px-2.5 py-2 shadow-xl backdrop-blur"
              onSubmit={(e) => { e.preventDefault(); saveTake(); }}
            >
              <span className="text-xs font-bold uppercase tracking-wide text-red-400">
                Take {formatDuration(pendingTake.seconds)}
              </span>
              <input
                autoFocus
                value={takeName}
                onChange={(e) => setTakeName(e.target.value)}
                placeholder="Filename…"
                className="w-44 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-accent/60"
              />
              <span className="text-xs text-foreground/40">.{pendingTake.ext}</span>
              <button
                type="submit"
                className="rounded bg-accent/20 px-2 py-1 text-xs font-bold uppercase tracking-wide text-accent transition hover:bg-accent/30"
              >
                Save
              </button>
              <button
                type="button"
                onClick={discardTake}
                title="Discard this take"
                className="rounded px-1.5 py-1 text-xs font-bold uppercase tracking-wide text-foreground/30 transition hover:text-red-400"
              >
                ✕
              </button>
            </form>
          )}

          {savedTake && !pendingTake && (
            <span className="absolute left-0 top-full z-30 mt-2 w-max rounded-md border border-accent/40 bg-background/95 px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide text-accent shadow-xl backdrop-blur">
              ✓ Saved {savedTake}
            </span>
          )}
        </div>
        {recError && (
          <span className="shrink-0 text-xs text-red-400" title={recError}>{recError}</span>
        )}

        {/* Master speed — a relative multiplier over every slot's own speed. Scaling all
            slots by the same ratio preserves the intervals between them, so key matching
            survives; the whole set just transposes together. */}
        {slotCount > 0 && (
          <div className="flex shrink-0 items-center gap-2 rounded bg-muted/50 px-2.5 py-1">
            <span className="text-[9px] font-bold uppercase tracking-widest text-foreground/30">
              Master
            </span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={masterSettings.masterSpeed}
              onChange={(e) => onMasterSpeedChange(Number(e.target.value))}
              onDoubleClick={() => onMasterSpeedChange(1)}
              title="Master speed — scales all slots together, preserving key relationships. Double-click to reset."
              className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-border accent-accent"
            />
            <span className="w-24 shrink-0 tabular-nums text-xs font-bold text-foreground/70">
              {masterSettings.masterSpeed.toFixed(2)}×
              <span className="ml-1 font-normal text-foreground/35">
                {formatSemitoneShift(masterSettings.masterSpeed)}
              </span>
            </span>
            {masterSettings.masterSpeed !== 1 && (
              <button
                type="button"
                onClick={() => onMasterSpeedChange(1)}
                title="Reset master speed to 1.00×"
                className="rounded px-1 text-xs font-bold text-foreground/30 transition hover:text-accent"
              >
                ↺
              </button>
            )}
          </div>
        )}

        {/* One control for the whole feature.
            It started as three loose buttons — Suggest, a keep-loops toggle, an undo — which
            sprawled across the transport and said nothing about how they related. They are
            all the same idea: a complete rack state. A suggestion is one the app proposed,
            a version is one you kept, and either is applied the same way. So they live in
            one list, and opening it no longer commits you to anything. */}
        {slotCount >= 2 && (
          <div className="relative shrink-0">
            <button
              ref={suggestBtnRef}
              type="button"
              onClick={() => {
                const next = !suggestOpen;
                setSuggestOpen(next);
                if (next) onComputeSuggestions();
              }}
              disabled={slotsLoading}
              title="Propose a whole rack — loops, both anchors, matching and locked delays — and keep the ones you like"
              className={`shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition disabled:opacity-30 ${
                suggestOpen
                  ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                  : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted"
              }`}
            >
              ✨ Suggest
              {suggestNote && (
                <span
                  title={suggestNote}
                  className="ml-1.5 inline-block max-w-[11rem] truncate align-middle rounded bg-foreground/10 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-foreground/70"
                >
                  {suggestNote}
                </span>
              )}
            </button>

            {suggestOpen && (
              <div
                ref={suggestPanelRef}
                className="absolute left-0 top-full mt-1 z-50 flex w-[28rem] max-h-[min(70vh,34rem)] flex-col gap-2 rounded-md border border-border/40 bg-zinc-900/95 p-3 shadow-xl ring-1 ring-border/30 backdrop-blur-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/40">Suggestions</span>
                  <button type="button" onClick={() => setSuggestOpen(false)}
                    className="px-1 text-sm leading-none text-foreground/30 hover:text-foreground/70">✕</button>
                </div>

                {/* Columns, not sentences. Thirty rows of "4 bar · tempo drums 129bpm · key
                    other · 68% separation" is four facts in prose repeated thirty times, and
                    nothing lines up to compare. Grouped under the tempo anchor because that
                    is the biggest decision a candidate makes — it lets you skip whole blocks
                    rather than reading every row. */}
                {/* Column headers. Without them the row was three unlabelled values and a
                    bar, and "74%" of what is not a question the reader should have to carry
                    down to a footnote. */}
                {suggestions.length > 0 && (
                  <div className="grid grid-cols-[4.5rem_4rem_1fr_auto] gap-2 border-b border-border/30 px-2 pb-1 text-[9px] font-semibold uppercase tracking-widest text-foreground/30">
                    {/* Character leads. It is the column that says how two rows differ to
                        the EAR — everything beside it describes structure, and a list sorted
                        by structure alone read as thirty copies of one suggestion. */}
                    <span title="How the rack is dressed: how much echo and space, whether a stem runs at half or double speed or sits off the beat.">character</span>
                    <span>loop</span>
                    <span>key anchor</span>
                    <span title="How much of the frequency range each stem has to itself. Higher means they stay out of each other's way, so you hear all of them.">clarity</span>
                  </div>
                )}
                <div className="-mr-1 flex min-h-0 flex-col overflow-y-auto pr-1">
                  {suggestions.length === 0 && (
                    <div className="py-2 text-xs text-foreground/30">Nothing to propose yet.</div>
                  )}
                  {suggestions.map((c, i) => {
                    const newGroup = i === 0 || suggestions[i - 1].label.tempoGroup !== c.label.tempoGroup;
                    const pct = Math.round(c.label.separation * 100);
                    const filled = Math.round(c.label.separation * 8);
                    return (
                      <div key={c.why}>
                        {newGroup && (
                          <div className="mt-2 flex items-center gap-2 px-1 pb-1 first:mt-0">
                            <span className="text-[9px] font-semibold uppercase tracking-widest text-foreground/35">
                              tempo {c.label.tempoGroup}
                            </span>
                            <span className="h-px flex-1 bg-border/30" />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => onPickSuggestion(i)}
                          className={`grid w-full grid-cols-[4.5rem_4rem_1fr_auto] items-center gap-2 rounded px-2 py-1 text-left text-xs transition ${
                            suggestIndex === i
                              ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                              : "text-foreground/60 hover:bg-muted/60 hover:text-foreground"
                          }`}
                        >
                          <span className="truncate font-medium">{c.label.flavour}</span>
                          <span className="tabular-nums">{c.label.loop}</span>
                          <span className="truncate text-foreground/40">{c.label.keyAnchor}</span>
                          {/* A bar reads at a glance; a percentage has to be compared row by
                              row. The number stays for when you want to be exact. */}
                          <span className="flex items-center gap-1.5 tabular-nums text-foreground/40">
                            <span className="tracking-[-0.1em] text-accent/60">
                              {"▓".repeat(filled)}
                              <span className="text-foreground/15">{"░".repeat(8 - filled)}</span>
                            </span>
                            {pct}%
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Ranks fit, not taste. Saying so once, here, is better than a button name
                    that overclaims every time you look at it. */}
                <p className="border-t border-border/30 pt-2 text-[10px] leading-snug text-foreground/30">
                  Ranked by fit — key distance, stretch cost and loop steadiness. Character is
                  the echo, space and timing each one dresses the rack in. Clarity is how
                  much of the frequency range each stem has to itself: higher means less mud.
                  Whether it sounds good is your call.
                </p>

                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/60">
                  <input type="checkbox" checked={suggestKeepLoops} onChange={onToggleKeepLoops}
                    className="accent-current" />
                  Use my existing loop sections
                </label>

                <div className="flex flex-col gap-1 border-t border-border/30 pt-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/40">Saved versions</span>
                  {versions.length === 0 && (
                    <div className="py-1 text-xs text-foreground/30">None saved yet.</div>
                  )}
                  {/* A saved version keeps the description the suggestion row carried, not
                      just the name it was given. "v3" six sessions later says nothing, and
                      all four facts were on screen at the moment it was saved. */}
                  {versions.map((v) => (
                    <div key={v.id} className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-muted/50">
                      <button type="button" onClick={() => onRestoreVersion(v.id)}
                        className="min-w-0 flex-1 text-left text-xs text-foreground/60 hover:text-foreground">
                        <span className="block truncate">{v.name}</span>
                        {v.from && (
                          <span className="mt-0.5 block truncate text-[10px] text-foreground/30">
                            {v.from.flavour} · {v.from.loop} · tempo {v.from.tempoGroup} · key {v.from.keyAnchor}
                            {" · "}{Math.round(v.from.separation * 100)}% clarity
                          </span>
                        )}
                      </button>
                      <button type="button" onClick={() => onDeleteVersion(v.id)}
                        title="Delete this version"
                        className="text-xs leading-none text-foreground/25 opacity-0 transition group-hover:opacity-100 hover:text-red-400">🗑</button>
                    </div>
                  ))}
                  <form
                    onSubmit={(e) => { e.preventDefault(); onSaveVersion(versionName); setVersionName(""); }}
                    className="flex items-center gap-1.5 pt-1"
                  >
                    <input
                      type="text"
                      value={versionName}
                      onChange={(e) => setVersionName(e.target.value)}
                      placeholder="Save this setup as…"
                      className="min-w-0 flex-1 rounded border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-accent/60 placeholder:text-foreground/30"
                    />
                    {versionName.trim() && (
                      <button type="submit"
                        className="rounded bg-accent/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-accent">Save</button>
                    )}
                  </form>
                </div>

                {onUndoSuggest && (
                  <button
                    type="button"
                    onClick={onUndoSuggest}
                    className="rounded border border-border/40 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/40 transition hover:border-red-500/30 hover:text-red-400"
                  >
                    ↺ Back to where I started
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Everything, in the one order that works: keys first, then tempos.
            Match Keys writes Speed and tempo matching reads it, so the reverse order leaves
            every slave stale. Set the two anchors, press this, done. The two buttons beside
            it stay for when you want one dimension without the other. */}
        {slotCount >= 2 && (
          <button
            type="button"
            onClick={onLockAll}
            disabled={(!referenceSlotId && !tempoAnchorId) || slotsLoading}
            className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/15 text-accent ring-1 ring-accent/30 transition hover:bg-accent/25 disabled:opacity-30 disabled:hover:bg-accent/15"
            title={(!referenceSlotId && !tempoAnchorId)
              ? "Set a key anchor and a tempo anchor first"
              : slotsLoading
                ? "Waiting for every slot to finish loading"
                : "Match keys, then match tempos — the order that holds. Runs whichever anchors are set."}
          >
            ⚓ Match All
          </button>
        )}

        {slotCount >= 2 && (
          <button
            type="button"
            onClick={onMatchAll}
            disabled={!referenceSlotId}
            className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-accent hover:bg-muted disabled:opacity-30 disabled:hover:text-foreground/50"
            title={referenceSlotId
              ? "Pitch-shift every other slot into key with the key anchor."
              : "Set a key anchor on a slot first — then every other slot shifts into its key"}
          >
            ↻ Match Keys
          </button>
        )}

        {/* Stretch all slots onto the tempo anchor's grid. Independent of key matching:
            stretching changes duration only, so both can be applied to the same slot. */}
        {slotCount >= 2 && (
          <button
            type="button"
            onClick={onTempoMatchAll}
            disabled={!tempoAnchorId || slotsLoading}
            className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-orange-300 hover:bg-muted disabled:opacity-30 disabled:hover:text-foreground/50"
            title={tempoAnchorId
              ? slotsLoading
                ? "Waiting for every slot to finish loading — matching now would quantize against a half-loaded rack"
                : "Time-stretch every other slot to the tempo anchor's tempo. Pitch is unchanged, so key matching still holds."
              : "Set a tempo anchor on a slot first — then every other slot stretches to its tempo"}
          >
            ↻ Match Tempos
            {/* Result rides on the button rather than as a separate element — it describes
                what this button just did, and a floating note was easy to miss. */}
            {gridNote && (
              <span
                onClick={(e) => { e.stopPropagation(); onDismissGridNote(); }}
                className="ml-1.5 rounded bg-orange-400/15 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-orange-300/90"
                title="Click to dismiss"
              >
                {gridNote}
              </span>
            )}
          </button>
        )}

        {/* Re-match: only the slots that drifted, unlike Match Tempos which rebuilds all of
            them. Appears only when something is actually stale so it is not one more
            permanent button competing for attention. */}
        {staleTempoCount > 0 && (
          <button
            type="button"
            onClick={onRelockStale}
            className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40 transition hover:bg-amber-500/30 animate-pulse"
            title={`${staleTempoCount} slot${staleTempoCount === 1 ? "" : "s"} drifted from the tempo anchor — re-stretch just those`}
          >
            ↻ Re-match {staleTempoCount}
          </button>
        )}

        {slotCount >= 2 && tempoAnchorId && (
          <button
            type="button"
            onClick={onToggleAutoRelock}
            className={cn(
              "shrink-0 rounded px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide transition",
              autoRelock
                ? "bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/25"
                : "bg-muted/80 text-foreground/40 hover:text-foreground/70",
            )}
            title={autoRelock
              ? "Auto-match is ON — slots re-match themselves shortly after the anchor's tempo changes"
              : "Auto-match is OFF — slots go amber when they drift and wait for you to re-match"}
          >
            auto-match {autoRelock ? "on" : "off"}
          </button>
        )}

        {/* Export, Random and Throw are NOT wrapped in a group. Grouping them is what put
            all three on a second row the moment the first one would not fit: a wrapper is
            one atomic flex item. Flat, they wrap one at a time and fill the line. */}
        {slotCount > 0 && (
          <div className="relative shrink-0">
            <button
              ref={exportBtnRef}
              type="button"
              onClick={() => setExportPanelOpen((o) => !o)}
              className={cn(
                "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
                exportPanelOpen
                  ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                  : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted",
              )}
            >
              ↓ Export
            </button>

            {/* Export floating panel */}
            {exportPanelOpen && (
              <div
                ref={exportPanelRef}
                className="absolute right-0 top-full mt-1 z-50 w-72 rounded-md border border-border/40 bg-zinc-900/95 shadow-xl backdrop-blur-sm ring-1 ring-border/30 p-4 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/40">Export</span>
                  <button type="button" onClick={() => setExportPanelOpen(false)}
                    className="text-foreground/30 hover:text-foreground/70 text-sm leading-none px-1">✕</button>
                </div>

                {/* Filename */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-foreground/40">Filename</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={filenameDraft}
                      onChange={(e) => setFilenameDraft(e.target.value)}
                      placeholder={buildExportFilename(activeSessionName, slotTitles)}
                      className="min-w-0 flex-1 rounded border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-accent/60 placeholder:text-foreground/30"
                    />
                    <span className="shrink-0 text-[10px] text-foreground/35">.{exportExtension(format)}</span>
                  </div>
                </div>

                {/* Loops */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-foreground/50">Loops</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={1} max={500} value={loopCount}
                      onChange={(e) => setLoopCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                      className="w-16 rounded border border-border bg-muted/50 px-2 py-1 text-xs outline-none focus:border-accent/60"
                    />
                    {totalSec > 0 && (
                      <span className="text-[10px] text-foreground/40">≈ {formatDuration(totalSec)}</span>
                    )}
                  </div>
                </div>

                {/* Format */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-foreground/50">Format</label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ExportFormat)}
                    className="rounded border border-border bg-muted/50 px-2 py-1 text-xs text-foreground outline-none focus:border-accent/60 [color-scheme:dark]"
                  >
                    <option value="wav">WAV</option>
                    <option value="mp3">MP3</option>
                  </select>
                </div>

                {/* Quality */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-foreground/50">Quality</label>
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as ExportQuality)}
                    className="rounded border border-border bg-muted/50 px-2 py-1 text-xs text-foreground outline-none focus:border-accent/60 [color-scheme:dark]"
                  >
                    {(Object.entries(EXPORT_PRESETS) as [ExportQuality, typeof preset][]).map(([key, p]) => (
                      <option key={key} value={key}>
                        {p.label} ({p.sampleRate / 1000}k{p.channels === 1 ? " mono" : ""})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="text-[10px] text-foreground/30">
                  ≈ {formatFileSize(estBytes)}{format === "mp3" ? ` · ${preset.mp3Kbps}kbps` : ""}
                </div>

                {exportError && <span className="text-xs text-red-400">{exportError}</span>}

                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exporting || masterLoopLength <= 0 || slotCount === 0}
                  className="rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent transition hover:bg-accent/30 disabled:opacity-40"
                >
                  {exporting ? "Exporting…" : `Export ${format.toUpperCase()}`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Random session */}
        <button
          type="button"
          onClick={onRandomSession}
          disabled={randomDisabled}
          className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
          title="Build a random session from stems library"
        >
          ⚄ Random
        </button>

        {slotCount > 0 && (
          <div className="relative shrink-0">
            <button
              ref={throwBtnRef}
              type="button"
              onClick={() => setThrowPanelOpen((o) => !o)}
              className={cn(
                "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
                throwPanelOpen
                  ? "bg-teal-500/20 text-teal-400 ring-1 ring-teal-400/40"
                  : "bg-muted/80 text-foreground/50 hover:text-teal-400 hover:bg-muted",
              )}
              title="Configure Throw character — delay time, feedback, spring reverb"
            >
              ↯ Throw
            </button>

            {/* Throw character floating overlay */}
            {throwPanelOpen && (
              <div
                ref={throwPanelRef}
                className="absolute left-0 top-full mt-1 z-50 w-80 rounded-md border border-teal-500/20 bg-zinc-900/95 shadow-xl backdrop-blur-sm ring-1 ring-border/30"
              >
                <div className="flex items-center justify-between px-4 pt-3 pb-0">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-teal-400">Throw Character</span>
                  <button type="button" onClick={() => setThrowPanelOpen(false)}
                    className="text-foreground/30 hover:text-foreground/70 text-sm leading-none px-1">✕</button>
                </div>
                <ThrowPanel
                  settings={masterSettings.throwSettings}
                  onChange={handleThrowChange}
                  presets={throwPresets}
                  onSavePreset={onSaveThrowPreset}
                  onDeletePreset={onDeleteThrowPreset}
                  onApplyPreset={onApplyThrowPreset}
                />
              </div>
            )}
          </div>
        )}
    </div>
  );
}
