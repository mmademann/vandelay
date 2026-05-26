import { useEffect, useState } from "react";
import { useMixStore } from "../../mixStore";
import { mixEngine } from "../../audio/mixEngine";
import { drumEngine } from "../../audio/drumEngine";
import { canExportMix, computeMixExportDuration, renderMix } from "../../audio/renderMix";
import { exportExtension } from "../../audio/exportOptions";
import type { ExportFormat, ExportQuality } from "../../audio/exportOptions";
import { DRUM_TRACK_ID, type DrumTrackSettings, type AudioTrackSettings } from "../../lib/mixSettings";
import { downloadBlob } from "../../audio/render";
import { formatLoopTime } from "../../lib/format";
import { ExportSettingsBar } from "../ExportSettingsBar";
import { Button } from "../ui/Button";
import { Slider } from "../ui/Slider";
import { Spinner } from "../ui/Spinner";

interface MasterControlsProps {
  compact?: boolean;
}

export function MasterControls({ compact = false }: MasterControlsProps) {
  const tracks = useMixStore((s) => s.tracks);
  const settings = useMixStore((s) => s.settings);
  const pausedIds = useMixStore((s) => s.pausedIds);
  const masterGain = useMixStore((s) => s.masterGain);
  const setMasterGain = useMixStore((s) => s.setMasterGain);
  const loopCount = useMixStore((s) => s.loopCount);
  const setLoopCount = useMixStore((s) => s.setLoopCount);
  const isPlaying = useMixStore((s) => s.isPlaying);
  const setIsPlaying = useMixStore((s) => s.setIsPlaying);
  const drumSettings = useMixStore((s) => s.settings[DRUM_TRACK_ID]);
  const [rendering, setRendering] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [quality, setQuality] = useState<ExportQuality>("full");

  useEffect(() => {
    mixEngine.setMasterGain(masterGain);
  }, [masterGain]);

  const drumsActive = drumSettings?.type === "drums" && drumSettings.pattern !== "off";

  async function togglePlay() {
    if (tracks.length === 0 && !drumsActive) return;
    if (isPlaying) {
      mixEngine.stopAll();
      drumEngine.stop();
      setIsPlaying(false);
    } else {
      await mixEngine.playAll({
        getConfig: (id) => {
          const cfg = settings[id];
          if (!cfg || cfg.type !== "audio") return null;
          return { settings: cfg as AudioTrackSettings, paused: pausedIds.has(id) };
        },
      });
      if (drumSettings?.type === "drums") {
        await drumEngine.start(drumSettings as DrumTrackSettings);
      }
      setIsPlaying(true);
    }
  }

  const canExport = canExportMix({ tracks, settings, pausedIds });

  async function handleExport() {
    if (!canExport) return;
    setRendering(true);
    try {
      const blob = await renderMix({
        tracks,
        settings,
        masterGain,
        loopCount,
        pausedIds,
        export: { format, quality },
      });
      const ext = exportExtension(format);
      downloadBlob(blob, `vandelay-mix-${Date.now()}.${ext}`);
    } finally {
      setRendering(false);
    }
  }

  const total = computeMixExportDuration({ tracks, settings, loopCount, pausedIds });

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
      <div className="text-xs uppercase tracking-wide text-foreground/60">Master</div>

      <Button onClick={togglePlay} disabled={tracks.length === 0 && !drumsActive}>
        {isPlaying ? "Stop all" : "Play all"}
      </Button>

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

      <Button onClick={handleExport} disabled={rendering || !canExport}>
        {rendering ? <Spinner /> : `Export ${format.toUpperCase()}`}
      </Button>

      <div className="flex flex-col gap-2">
        <div className="text-xs uppercase tracking-wide text-foreground/60">
          Master gain: {(masterGain * 100).toFixed(0)}%
        </div>
        <Slider
          value={masterGain}
          onChange={setMasterGain}
          min={0}
          max={2}
          step={0.01}
        />
      </div>

      {!compact && (
        <p className="text-xs text-foreground/40">
          Layer multiple loops together. Each track has its own loop region and effects. Loops drift
          naturally over time.
        </p>
      )}
    </div>
  );
}

