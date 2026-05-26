export type ExportFormat = "wav" | "mp3";
export type ExportQuality = "full" | "balanced" | "small";

export interface ExportPreset {
  label: string;
  sampleRate: number;
  channels: 1 | 2;
  mp3Kbps: number;
}

export const EXPORT_PRESETS: Record<ExportQuality, ExportPreset> = {
  full: {
    label: "Full",
    sampleRate: 44100,
    channels: 2,
    mp3Kbps: 320,
  },
  balanced: {
    label: "Balanced",
    sampleRate: 32000,
    channels: 2,
    mp3Kbps: 192,
  },
  small: {
    label: "Small & fast",
    sampleRate: 22050,
    channels: 1,
    mp3Kbps: 128,
  },
};

export interface ExportEncodeOptions {
  format: ExportFormat;
  quality: ExportQuality;
}

export function exportExtension(format: ExportFormat): string {
  return format === "mp3" ? "mp3" : "wav";
}

/** Rough output size in bytes (WAV header + PCM, or CBR MP3). */
export function estimateExportBytes(
  durationSec: number,
  format: ExportFormat,
  quality: ExportQuality,
): number {
  const p = EXPORT_PRESETS[quality];
  if (format === "wav") {
    return 44 + durationSec * p.sampleRate * p.channels * 2;
  }
  return (durationSec * p.mp3Kbps * 1000) / 8;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
