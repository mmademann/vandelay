import { useState } from "react";
import { collabEngine } from "../../audio/collabEngine";
import { renderCollab, canExportCollab } from "../../audio/renderCollab";
import {
  exportExtension,
  estimateExportBytes,
  formatFileSize,
  EXPORT_PRESETS,
  type ExportFormat,
  type ExportQuality,
} from "../../audio/exportOptions";
import type { CollabMasterSettings, CollabSlot } from "../../lib/collabSettings";

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

interface Props {
  masterSettings: CollabMasterSettings;
  slotCount: number;
  getSlotsAndBuffers: () => { slots: CollabSlot[]; buffers: Map<string, AudioBuffer> };
  onStopAll: () => void;
  onPlayAll: () => void;
  onRewindAll: () => void;
  isPlaying: boolean;
}

export function CollabTransport({ masterSettings, slotCount, getSlotsAndBuffers, onStopAll, onPlayAll, onRewindAll, isPlaying }: Props) {
  const [loopCount, setLoopCount] = useState(4);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [quality, setQuality] = useState<ExportQuality>("full");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const masterLoopLength = collabEngine.getMasterLoopLength() ?? 0;
  const totalSec = masterLoopLength * loopCount;
  const estBytes = estimateExportBytes(totalSec, format, quality);
  const preset = EXPORT_PRESETS[quality];

  async function handleExport() {
    if (exporting) return;
    const { slots, buffers } = getSlotsAndBuffers();
    const loopLen = collabEngine.getMasterLoopLength() ?? 0;
    if (!canExportCollab({ slots, buffers, masterLoopLength: loopLen }) || loopLen <= 0) return;
    setExporting(true);
    setExportError(null);
    try {
      const blob = await renderCollab({
        slots,
        buffers,
        masterSettings,
        masterLoopLength: loopLen,
        loopCount,
        export: { format, quality },
      });
      if (blob.size < 44) throw new Error("Export produced an empty file.");
      downloadBlob(blob, `collab-mix (${loopCount}x).${exportExtension(format)}`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* Play All / Pause All + Rewind All */}
      <button
        type="button"
        onClick={isPlaying ? onStopAll : onPlayAll}
        disabled={slotCount === 0}
        className={isPlaying
          ? "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent ring-1 ring-accent/40 transition hover:bg-accent/30 disabled:opacity-30"
          : "shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-muted/80 text-foreground/50 transition hover:text-foreground hover:bg-muted disabled:opacity-30"
        }
      >
        {isPlaying ? "⏸ Pause All" : "▶ Play All"}
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

      {/* Export controls */}
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-1.5">
          {/* Loops */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-foreground/40">Loops</label>
            <input
              type="number" min={1} max={500} value={loopCount}
              onChange={(e) => setLoopCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-14 rounded border border-border bg-muted/50 px-2 py-1 text-xs outline-none focus:border-accent/60"
            />
            <span className="w-12 text-[10px] text-foreground/40">
              {totalSec > 0 ? `≈ ${formatDuration(totalSec)}` : ""}
            </span>
          </div>

          <div className="h-4 w-px bg-border/50" />

          {/* Format */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-foreground/40">Format</label>
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
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-foreground/40">Quality</label>
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

          {/* Size estimate */}
          <span className="w-28 shrink-0 text-[10px] text-foreground/40">
            ≈ {formatFileSize(estBytes)}{format === "mp3" ? ` · ${preset.mp3Kbps}kbps` : ""}
          </span>

          {exportError && <span className="text-xs text-red-400">{exportError}</span>}

          {/* Export button */}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || masterLoopLength <= 0 || slotCount === 0}
            className="rounded px-3 py-1 text-xs font-bold uppercase tracking-wide bg-accent/20 text-accent transition hover:bg-accent/30 disabled:opacity-40"
          >
            {exporting ? "Exporting…" : `Export ${format.toUpperCase()}`}
          </button>
        </div>
    </div>
  );
}
