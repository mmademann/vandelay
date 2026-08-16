import type { StemName } from "../audio/dubEngine";
import type { MultiMasterSettings, MultiSession, MultiPreset, ThrowPreset } from "./multiSettings";
import {
  loadNamedSessions,
  loadMultiPresets,
  loadThrowPresets,
  loadAnchorKey,
  saveThrowSettings,
  saveAnchorKey,
  clearAnchorKey,
} from "./multiSettings";

export interface MultiExportFile {
  exportedAt: number;
  version: 1;
  namedSessions: MultiSession[];
  slotSettings: Record<string, unknown>;
  presets: MultiPreset[];
  throwPresets: ThrowPreset[];
  masterSettings: MultiMasterSettings;
  anchor: { trackId: string; stemName: StemName | null } | null;
}

export function buildExport(masterSettings: MultiMasterSettings): MultiExportFile {
  return {
    exportedAt: Date.now(),
    version: 1,
    namedSessions: loadNamedSessions(),
    slotSettings: JSON.parse(localStorage.getItem("vandelay:multi:slot-settings:v1") ?? "{}"),
    presets: loadMultiPresets(),
    throwPresets: loadThrowPresets(),
    masterSettings,
    anchor: loadAnchorKey(),
  };
}

export async function saveExportToServer(data: MultiExportFile): Promise<void> {
  const res = await fetch("/api/multi-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  // Without this a 400 resolves silently and the UI reports success on a write that never happened.
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Backup failed (${res.status}) ${detail}`.trim());
  }
}

export async function loadExportFromServer(): Promise<MultiExportFile | null> {
  const res = await fetch("/api/multi-state");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json() as Promise<MultiExportFile>;
}

export function applyImport(data: MultiExportFile): void {
  localStorage.setItem("vandelay:multi:slot-settings:v1", JSON.stringify(data.slotSettings));
  localStorage.setItem("vandelay:multi:sessions:v1", JSON.stringify(data.namedSessions));
  localStorage.setItem("vandelay:multi:presets:v1", JSON.stringify(data.presets));
  localStorage.setItem("vandelay:multi:throw-presets:v1", JSON.stringify(data.throwPresets));
  saveThrowSettings(data.masterSettings.throwSettings);
  if (data.anchor) {
    saveAnchorKey(data.anchor.trackId, data.anchor.stemName);
  } else {
    clearAnchorKey();
  }
}
