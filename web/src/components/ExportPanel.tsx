import { useState } from "react";
import { exportOutputDuration } from "../audio/engine";
import { renderLoop, downloadBlob } from "../audio/render";
import { exportExtension } from "../audio/exportOptions";
import type { ExportFormat, ExportQuality } from "../audio/exportOptions";
import { effectiveEffects, useStore, sanitizeLoopRegion } from "../store";
import { formatLoopTime } from "../lib/format";
import { ExportSettingsBar } from "./ExportSettingsBar";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";

export function ExportPanel() {
  const { track, loopStart, loopEnd, loopCount, setLoopCount, effects, effectsEnabled } = useStore();
  const applied = effectiveEffects(effects, effectsEnabled);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [quality, setQuality] = useState<ExportQuality>("full");

  if (!track) return null;

  const duration = track.buffer.duration;
  const loop = sanitizeLoopRegion(loopStart, loopEnd, duration);
  const total = exportOutputDuration(loop.loopStart, loop.loopEnd, loopCount, applied);
  const canExport = (loop.loopEnd - loop.loopStart) >= 0.05 && loopCount >= 1;

  async function handleExport() {
    if (!track || !canExport) return;
    setRendering(true);
    setError(null);
    try {
      const blob = await renderLoop({
        buffer: track.buffer,
        loopStart: loop.loopStart,
        loopEnd: loop.loopEnd,
        loopCount,
        effects: applied,
        export: { format, quality },
      });
      if (blob.size < 44) {
        throw new Error("Export produced an empty file — try adjusting the loop region.");
      }
      const ext = exportExtension(format);
      downloadBlob(blob, `${track.title} (slowed ${loopCount}x).${ext}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
      <div className="text-xs uppercase tracking-wide text-foreground/60">Export</div>
      <div className="flex items-center gap-3">
        <label className="text-xs uppercase tracking-wide text-foreground/60">Loops</label>
        <input
          type="number"
          min={1}
          max={500}
          value={loopCount}
          onChange={(e) => setLoopCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
          className="w-20 rounded-md border border-border bg-muted px-2 py-1 text-sm outline-none focus:border-accent"
        />
        <span className="text-xs text-foreground/60">≈ {formatLoopTime(total)}</span>
      </div>
      <ExportSettingsBar
        durationSec={total}
        format={format}
        quality={quality}
        onFormatChange={setFormat}
        onQualityChange={setQuality}
      />
      {error && (
        <div className="text-sm text-red-400">{error}</div>
      )}
      <Button onClick={handleExport} disabled={rendering || !canExport}>
        {rendering ? <Spinner /> : `Export ${format.toUpperCase()}`}
      </Button>
    </div>
  );
}
