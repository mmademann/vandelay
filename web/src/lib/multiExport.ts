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
  readAllVersions,
  writeAllVersions,
  type MultiVersion,
} from "./multiSettings";
import { readAllPanels, writeAllPanels, type PanelState } from "./midiDevices";
import { readAllPatterns, writeAllPatterns, type Pattern } from "./midiSequencer";

export interface MultiExportFile {
  exportedAt: number;
  version: 1;
  namedSessions: MultiSession[];
  slotSettings: Record<string, unknown>;
  presets: MultiPreset[];
  throwPresets: ThrowPreset[];
  masterSettings: MultiMasterSettings;
  anchor: { trackId: string; stemName: StemName | null } | null;
  /** Optional: backups written before in-session versions existed have none. */
  versions?: Record<string, MultiVersion[]>;
  /**
   * The outboard synths: every front panel and every bassline, by device id.
   *
   * Optional for the same reason `versions` is — a backup written before the hardware
   * existed carries neither, and restoring an empty one would wipe patches that took
   * real time to dial and cannot be read back off the synth, since none of them answer
   * SysEx. The app IS the patch, so the app's backup has to hold it.
   */
  midiPanels?: Record<string, Partial<PanelState>>;
  midiPatterns?: Record<string, Pattern>;
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
    // In-session versions ride with the backup like everything else; losing the
    // alternatives you kept would make the feature untrustworthy.
    versions: readAllVersions(),
    midiPanels: readAllPanels(),
    midiPatterns: readAllPatterns(),
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
  // Only when the backup actually carries them. An older file has no `versions` key, and
  // writing an empty store for it would delete versions the user still has locally.
  if (data.versions) writeAllVersions(data.versions);
  if (data.midiPanels) writeAllPanels(data.midiPanels);
  if (data.midiPatterns) writeAllPatterns(data.midiPatterns);
  if (data.anchor) {
    saveAnchorKey(data.anchor.trackId, data.anchor.stemName);
  } else {
    clearAnchorKey();
  }
}
