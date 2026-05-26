import {
  EXPORT_PRESETS,
  estimateExportBytes,
  formatFileSize,
  type ExportFormat,
  type ExportQuality,
} from "../audio/exportOptions";
import { cn } from "../lib/cn";

interface Props {
  durationSec: number;
  format: ExportFormat;
  quality: ExportQuality;
  onFormatChange: (f: ExportFormat) => void;
  onQualityChange: (q: ExportQuality) => void;
}

function Select({
  value,
  onChange,
  children,
  className,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-border bg-muted",
          "pl-2 pr-8 text-sm text-foreground outline-none focus:border-accent [color-scheme:dark]",
          className,
        )}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-foreground/40"
      >
        ▾
      </span>
    </div>
  );
}

export function ExportSettingsBar({
  durationSec,
  format,
  quality,
  onFormatChange,
  onQualityChange,
}: Props) {
  const estBytes = estimateExportBytes(durationSec, format, quality);
  const preset = EXPORT_PRESETS[quality];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-foreground/60">
        <span className="uppercase tracking-wide">Format</span>
        <Select value={format} onChange={(e) => onFormatChange(e.target.value as ExportFormat)}>
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-foreground/60">
        <span className="uppercase tracking-wide">Quality</span>
        <Select value={quality} onChange={(e) => onQualityChange(e.target.value as ExportQuality)}>
          {(Object.entries(EXPORT_PRESETS) as [ExportQuality, typeof preset][]).map(
            ([key, p]) => (
              <option key={key} value={key}>
                {p.label} ({p.sampleRate / 1000}k{p.channels === 1 ? " mono" : ""})
              </option>
            ),
          )}
        </Select>
      </label>
      <span className="text-xs text-foreground/50">
        ≈ {formatFileSize(estBytes)}
        {format === "mp3" ? ` · ${preset.mp3Kbps} kbps` : ""}
      </span>
    </div>
  );
}
