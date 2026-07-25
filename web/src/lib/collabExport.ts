import type { StemName } from "../audio/dubEngine";
import type { CollabMasterSettings, CollabSession, CollabPreset, ThrowPreset } from "./collabSettings";
import {
  loadNamedSessions,
  loadCollabPresets,
  loadThrowPresets,
  loadAnchorKey,
  saveThrowSettings,
  saveAnchorKey,
  clearAnchorKey,
} from "./collabSettings";

export interface CollabExportFile {
  exportedAt: number;
  version: 1;
  namedSessions: CollabSession[];
  slotSettings: Record<string, unknown>;
  presets: CollabPreset[];
  throwPresets: ThrowPreset[];
  masterSettings: CollabMasterSettings;
  anchor: { trackId: string; stemName: StemName | null } | null;
}

export function buildExport(masterSettings: CollabMasterSettings): CollabExportFile {
  return {
    exportedAt: Date.now(),
    version: 1,
    namedSessions: loadNamedSessions(),
    slotSettings: JSON.parse(localStorage.getItem("vandelay:multi:slot-settings:v1") ?? "{}"),
    presets: loadCollabPresets(),
    throwPresets: loadThrowPresets(),
    masterSettings,
    anchor: loadAnchorKey(),
  };
}

export async function saveExportToServer(data: CollabExportFile): Promise<void> {
  await fetch("/api/collab-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function loadExportFromServer(): Promise<CollabExportFile | null> {
  const res = await fetch("/api/collab-state");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json() as Promise<CollabExportFile>;
}

export function applyImport(data: CollabExportFile): void {
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
