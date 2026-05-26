import { useState } from "react";
import { useStore } from "../store";
import {
  deleteSinglePreset,
  loadSinglePresets,
  saveSinglePreset,
  trackToPresetSettings,
  type SinglePreset,
} from "../lib/singlePresets";
import { cn } from "../lib/cn";
import { Button } from "./ui/Button";

interface SinglePresetBarProps {
  compact?: boolean;
}

export function SinglePresetBar({ compact = false }: SinglePresetBarProps) {
  const track = useStore((s) => s.track);
  const loopStart = useStore((s) => s.loopStart);
  const loopEnd = useStore((s) => s.loopEnd);
  const loopCount = useStore((s) => s.loopCount);
  const effects = useStore((s) => s.effects);
  const applyPreset = useStore((s) => s.applyPreset);

  const [presets, setPresets] = useState<SinglePreset[]>(() => loadSinglePresets());
  const [presetName, setPresetName] = useState("");
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null);

  if (!track) return null;

  const trimmedPresetName = presetName.trim();
  const typedPresetExists =
    trimmedPresetName.length > 0 && presets.some((p) => p.name === trimmedPresetName);
  const saveTargetName = trimmedPresetName || selectedPresetName || "";
  const isUpdatingExistingPreset =
    saveTargetName.length > 0 && presets.some((p) => p.name === saveTargetName);

  function handleSavePreset() {
    if (!saveTargetName || !track) return;
    const settings = trackToPresetSettings(
      track.buffer.duration,
      loopStart,
      loopEnd,
      loopCount,
      effects,
    );
    setPresets(saveSinglePreset(saveTargetName, settings));
    setSelectedPresetName(saveTargetName);
    setPresetName("");
  }

  function handleLoadPreset(preset: SinglePreset) {
    applyPreset(preset.settings);
    setSelectedPresetName(preset.name);
    setPresetName("");
  }

  function handleDeletePreset(name: string) {
    setPresets(deleteSinglePreset(name));
    if (trimmedPresetName === name) setPresetName("");
    if (selectedPresetName === name) setSelectedPresetName(null);
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
      <div className="text-xs uppercase tracking-wide text-foreground/60">Presets</div>

      <form
        className={cn("flex gap-2", compact ? "flex-col" : "flex-wrap items-center")}
        onSubmit={(e) => {
          e.preventDefault();
          handleSavePreset();
        }}
      >
        <input
          type="text"
          placeholder={compact ? "Preset name" : selectedPresetName ? `Editing ${selectedPresetName}` : "Preset name"}
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 text-sm outline-none focus:border-accent"
        />
        <Button
          type="submit"
          variant="secondary"
          className="shrink-0 px-3 py-1 text-xs"
          disabled={!saveTargetName}
        >
          {isUpdatingExistingPreset ? "Update" : "Save"}
        </Button>
      </form>

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/40">
          <span>
            {selectedPresetName
              ? `Editing ${selectedPresetName}. Press Enter or click save to update it.`
              : typedPresetExists
                ? "Press Enter to update this preset name."
                : "Saves effects, loop count, and loop region (% of track). Works on any track."}
          </span>
          {selectedPresetName && (
            <button
              type="button"
              onClick={() => setSelectedPresetName(null)}
              className="text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear selection
            </button>
          )}
        </div>
      )}

      {compact && selectedPresetName && (
        <button
          type="button"
          onClick={() => setSelectedPresetName(null)}
          className="text-left text-[10px] text-foreground/40 underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear {selectedPresetName}
        </button>
      )}

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <div
              key={p.name}
              className="group flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5"
            >
              <button
                type="button"
                onClick={() => handleLoadPreset(p)}
                className={cn(
                  "text-xs hover:text-foreground",
                  selectedPresetName === p.name || trimmedPresetName === p.name
                    ? "text-accent"
                    : "text-foreground/70",
                )}
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => handleDeletePreset(p.name)}
                className="text-foreground/30 opacity-0 transition hover:text-foreground/70 group-hover:opacity-100"
                aria-label="Delete preset"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
