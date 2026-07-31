import { useEffect, useRef, useState } from "react";
import { multiEngine } from "../../audio/multiEngine";
import { renderMulti, canExportMulti } from "../../audio/renderMulti";
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
import type { GenreName } from "../../lib/vibePresets";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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
                className="text-xs text-foreground/20 opacity-0 group-hover:opacity-100 hover:text-red-400 transition pl-1 border-l border-border/50">
                ✕
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
  getSlotsAndBuffers: () => { slots: MultiSlot[]; buffers: Map<string, AudioBuffer> };
  onStopAll: () => void;
  onPlayAll: () => void;
  onRewindAll: () => void;
  onThrowSettingsChange: (settings: ThrowSettings) => void;
  throwPresets: ThrowPreset[];
  onSaveThrowPreset: (name: string) => void;
  onDeleteThrowPreset: (name: string) => void;
  onApplyThrowPreset: (preset: ThrowPreset) => void;
  isPlaying: boolean;
  onMatchAll: () => void;
  onApplyGenre: (genre: GenreName) => void;
  onRandomizeAll: () => void;
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

export function MultiTransport({ masterSettings, slotCount, referenceSlotId, activeSessionName, slotTitles, getSlotsAndBuffers, onStopAll, onPlayAll, onRewindAll, onThrowSettingsChange, throwPresets, onSaveThrowPreset, onDeleteThrowPreset, onApplyThrowPreset, isPlaying, onMatchAll, onApplyGenre, onRandomizeAll, onRandomSession, randomDisabled }: Props) {
  const [loopCount, setLoopCount] = useState(1);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [quality, setQuality] = useState<ExportQuality>("full");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [throwPanelOpen, setThrowPanelOpen] = useState(false);
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [genrePanelOpen, setGenrePanelOpen] = useState(false);
  const throwPanelRef = useRef<HTMLDivElement>(null);
  const throwBtnRef = useRef<HTMLButtonElement>(null);
  const exportPanelRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const genrePanelRef = useRef<HTMLDivElement>(null);
  const genreBtnRef = useRef<HTMLButtonElement>(null);
  const masterLoopLength = multiEngine.getMasterLoopLength() ?? 0;
  const totalSec = masterLoopLength * loopCount;
  const estBytes = estimateExportBytes(totalSec, format, quality);
  const preset = EXPORT_PRESETS[quality];

  // Close panels on outside click
  useEffect(() => {
    if (!throwPanelOpen && !exportPanelOpen && !genrePanelOpen) return;
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
      if (
        genrePanelRef.current && !genrePanelRef.current.contains(e.target as Node) &&
        genreBtnRef.current && !genreBtnRef.current.contains(e.target as Node)
      ) {
        setGenrePanelOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [throwPanelOpen, exportPanelOpen, genrePanelOpen]);

  async function handleExport() {
    if (exporting) return;
    const { slots, buffers } = getSlotsAndBuffers();
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
        export: { format, quality },
      });
      if (blob.size < 44) throw new Error("Export produced an empty file.");
      const name = buildExportFilename(activeSessionName, slotTitles);
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
    <div className="relative">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* Play All / Pause All + Rewind All */}
        <button
          type="button"
          onClick={isPlaying && slotCount > 0 ? onStopAll : onPlayAll}
          disabled={slotCount === 0}
          className={isPlaying && slotCount > 0
            ? "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent ring-1 ring-accent/40 transition hover:bg-accent/30 disabled:opacity-30"
            : "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
          }
        >
          {isPlaying && slotCount > 0 ? "⏸ Pause All" : "▶ Play All"}
        </button>
        <button
          type="button"
          onClick={onRewindAll}
          disabled={slotCount === 0}
          className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
          title="Rewind all to loop start"
        >
          ⏮
        </button>

        {/* Throw character panel toggle */}
        {slotCount > 0 && (
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
        )}

        {/* Genre panel toggle */}
        {slotCount > 0 && (
          <button
            ref={genreBtnRef}
            type="button"
            onClick={() => setGenrePanelOpen((o) => !o)}
            className={cn(
              "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition",
              genrePanelOpen
                ? "bg-purple-500/20 text-purple-400 ring-1 ring-purple-400/40"
                : "bg-muted/80 text-foreground/50 hover:text-purple-400 hover:bg-muted",
            )}
            title="Apply genre preset or randomize effects"
          >
            ✦ Genre
          </button>
        )}

        {/* Match all to reference */}
        {referenceSlotId && slotCount >= 2 && (
          <button
            type="button"
            onClick={onMatchAll}
            className="shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-accent hover:bg-muted"
            title="Match all slots to the key anchor"
          >
            Match to Anchor
          </button>
        )}

        {/* Export dropdown */}
        {slotCount > 0 && (
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

      </div>

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

      {/* Genre floating panel */}
      {genrePanelOpen && (
        <div
          ref={genrePanelRef}
          className="absolute left-0 top-full mt-1 z-50 w-64 rounded-md border border-purple-500/20 bg-zinc-900/95 shadow-xl backdrop-blur-sm ring-1 ring-border/30 p-4 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-purple-400">Genre</span>
            <button type="button" onClick={() => setGenrePanelOpen(false)}
              className="text-foreground/30 hover:text-foreground/70 text-sm leading-none px-1">✕</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["Dub", "Lo-fi", "Ambient", "Dry"] as const).map((genre) => (
              <button
                key={genre}
                type="button"
                onClick={() => { onApplyGenre(genre); setGenrePanelOpen(false); }}
                className="rounded border border-border bg-muted/50 px-3 py-2 text-xs font-semibold text-foreground/60 transition hover:border-purple-400/40 hover:text-purple-300 hover:bg-purple-500/10"
              >
                {genre}
              </button>
            ))}
          </div>
          <div className="border-t border-border/30 pt-2">
            <button
              type="button"
              onClick={() => { onRandomizeAll(); setGenrePanelOpen(false); }}
              className="w-full rounded border border-border bg-muted/50 px-3 py-2 text-xs font-semibold text-foreground/60 transition hover:border-purple-400/40 hover:text-purple-300 hover:bg-purple-500/10"
            >
              ⚄ Randomize All
            </button>
          </div>
        </div>
      )}

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
  );
}
