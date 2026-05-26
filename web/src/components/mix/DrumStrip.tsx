import { useEffect, useState } from "react";
import { useMixStore } from "../../mixStore";
import { drumEngine } from "../../audio/drumEngine";
import { DRUM_TRACK_ID, DRUM_PATTERNS, DEFAULT_DRUM_TRACK, type DrumPattern, type DrumTrackSettings } from "../../lib/mixSettings";
import { loadPresets, savePreset, deletePreset, type DrumPreset } from "../../lib/drumPresets";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { ReverbControls } from "../ReverbControls";
import type { EffectsState } from "../../store";

const PATTERNS: { label: string; value: DrumPattern }[] = [
  { label: "Off", value: "off" },
  { label: "4-on-the-floor", value: "four-on-the-floor" },
  { label: "Half-time", value: "half-time" },
  { label: "Custom", value: "custom" },
];

export function DrumStrip() {
  const raw = useMixStore((s) => s.settings[DRUM_TRACK_ID]);
  const setDrums = useMixStore((s) => s.setDrums);
  const setEffect = useMixStore((s) => s.setEffect);
  const setHatEffect = useMixStore((s) => s.setHatEffect);
  const setVolume = useMixStore((s) => s.setVolume);
  const setMuted = useMixStore((s) => s.setMuted);
  const isPlaying = useMixStore((s) => s.isPlaying);

  const settings = raw?.type === "drums" ? (raw as DrumTrackSettings) : null;
  const [presets, setPresets] = useState<DrumPreset[]>(() => loadPresets());
  const [presetName, setPresetName] = useState("");
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null);
  const trimmedPresetName = presetName.trim();
  const typedPresetExists = trimmedPresetName.length > 0 && presets.some((p) => p.name === trimmedPresetName);
  const saveTargetName = trimmedPresetName || selectedPresetName || "";
  const isUpdatingExistingPreset = saveTargetName.length > 0
    && presets.some((p) => p.name === saveTargetName);

  // Start/stop based on pattern and play state
  useEffect(() => {
    if (!isPlaying || !settings) return;
    if (settings.pattern !== "off" && !drumEngine.isRunning()) {
      drumEngine.start(settings);
    } else if (settings.pattern === "off" && drumEngine.isRunning()) {
      drumEngine.stop();
    }
  }, [isPlaying, settings?.pattern]);

  // Update steps when step grid or kickTone changes
  useEffect(() => {
    if (!isPlaying || !settings || !drumEngine.isRunning()) return;
    drumEngine.updateSteps(settings);
  }, [settings?.kickSteps, settings?.hatSteps, settings?.kickTone]);

  // Update continuous params without rebuilding sequence
  useEffect(() => {
    if (!isPlaying || !settings || !drumEngine.isRunning()) return;
    drumEngine.applyEffects(settings.effects);
    drumEngine.applyHatEffects(settings.hatEffects);
    drumEngine.updateVolumes(settings.kickVolume, settings.hatVolume);
    drumEngine.updateVolume(settings.volumeDb, settings.muted);
    drumEngine.updateBpm(settings.bpm);
    drumEngine.updateKickDecay(settings.kickDecay);
    drumEngine.updateKickPunch(settings.kickPunch);
  }, [
    isPlaying,
    settings?.effects,
    settings?.hatEffects,
    settings?.kickVolume,
    settings?.hatVolume,
    settings?.volumeDb,
    settings?.muted,
    settings?.bpm,
    settings?.kickDecay,
    settings?.kickPunch,
  ]);

  if (!settings) return null;

  function selectPattern(pattern: DrumPattern) {
    if (pattern === "off" || pattern === "custom") {
      setDrums({ pattern });
      return;
    }
    const preset = DRUM_PATTERNS[pattern];
    setDrums({ pattern, kickSteps: [...preset.kickSteps], hatSteps: [...preset.hatSteps] });
  }

  function toggleStep(row: "kick" | "hat", index: number) {
    const steps = row === "kick" ? [...settings!.kickSteps] : [...settings!.hatSteps];
    steps[index] = !steps[index];
    setDrums(row === "kick"
      ? { kickSteps: steps, pattern: "custom" }
      : { hatSteps: steps, pattern: "custom" },
    );
  }

  function handleSavePreset() {
    if (!settings || !saveTargetName) return;
    setPresets(savePreset(saveTargetName, settings));
    setSelectedPresetName(saveTargetName);
    setPresetName("");
  }

  function handleLoadPreset(preset: DrumPreset) {
    setDrums({
      ...preset.settings,
      kickSteps: [...preset.settings.kickSteps],
      hatSteps: [...preset.settings.hatSteps],
      effects: { ...preset.settings.effects },
      hatEffects: { ...preset.settings.hatEffects },
    });
    setSelectedPresetName(preset.name);
    setPresetName("");
  }

  function handleDeletePreset(name: string) {
    setPresets(deletePreset(name));
    if (trimmedPresetName === name) {
      setPresetName("");
    }
    if (selectedPresetName === name) {
      setSelectedPresetName(null);
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-foreground">Drum machine</div>
          <div className="text-xs text-foreground/50">{settings.bpm} BPM · {settings.pattern}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground/50 uppercase tracking-wide">Mute</span>
          <Switch checked={settings.muted} onChange={(b) => setMuted(DRUM_TRACK_ID, b)} />
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex gap-2">
            {PATTERNS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => selectPattern(p.value)}
                className={`rounded-md px-3 py-1 text-xs transition ${
                  settings.pattern === p.value
                    ? "bg-accent text-black"
                    : "bg-muted text-foreground/60 hover:bg-muted/80"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-foreground/50">BPM</span>
            <input
              type="number"
              min={40}
              max={200}
              value={settings.bpm}
              onChange={(e) => setDrums({ bpm: Math.max(40, Math.min(200, Number(e.target.value) || 75)) })}
              className="w-16 rounded-md border border-border bg-muted px-2 py-1 text-sm outline-none focus:border-accent"
            />
          </div>
        </div>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSavePreset();
          }}
        >
          <input
            type="text"
            placeholder={selectedPresetName ? `Save as new preset (editing ${selectedPresetName})` : "Preset name"}
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            className="flex-1 rounded-md border border-border bg-muted px-2 py-1 text-sm outline-none focus:border-accent"
          />
          <Button
            type="submit"
            variant="secondary"
            className="px-3 py-1 text-xs"
            disabled={!saveTargetName}
          >
            {isUpdatingExistingPreset ? "Update preset" : "Save preset"}
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/40">
          <span>
            {selectedPresetName
              ? `Editing ${selectedPresetName}. Press Enter or click save to update it.`
              : typedPresetExists
                ? "Press Enter to update this preset name."
                : "Press Enter to save. Click a preset to edit it without retyping its name."}
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

        {presets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <div key={p.name} className="group flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1">
                <button
                  type="button"
                  onClick={() => handleLoadPreset(p)}
                  className={`text-xs hover:text-foreground ${
                    selectedPresetName === p.name || trimmedPresetName === p.name
                      ? "text-accent"
                      : "text-foreground/70"
                  }`}
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

        {settings.pattern !== "off" && (
          <>
            <StepGrid label="Kick" steps={settings.kickSteps} color="bg-accent" onToggle={(i) => toggleStep("kick", i)} />
            <StepGrid label="Hat" steps={settings.hatSteps} color="bg-foreground/40" onToggle={(i) => toggleStep("hat", i)} />
          </>
        )}
      </div>

      {settings.pattern !== "off" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Volume: ${settings.muted ? "muted" : `${settings.volumeDb.toFixed(0)} dB`}`}>
            <Slider value={settings.volumeDb} onChange={(v) => setVolume(DRUM_TRACK_ID, v)} min={-30} max={6} step={0.5}
              className={settings.muted ? "opacity-40 pointer-events-none" : ""} />
          </Field>

          <Field label={`Kick volume: ${(settings.kickVolume * 100).toFixed(0)}%`}>
            <Slider value={settings.kickVolume} onChange={(v) => setDrums({ kickVolume: v })} min={0} max={3} step={0.01} />
          </Field>

          <Field label={`Hat volume: ${(settings.hatVolume * 100).toFixed(0)}%`}>
            <Slider value={settings.hatVolume} onChange={(v) => setDrums({ hatVolume: v })} min={0} max={1} step={0.01} />
          </Field>

          <Field label={`Kick decay: ${settings.kickDecay.toFixed(2)}s`}>
            <Slider value={settings.kickDecay} onChange={(v) => setDrums({ kickDecay: v })} min={0.1} max={4} step={0.01} />
          </Field>

          <Field label={`Kick tone: ${settings.kickTone} Hz`}>
            <Slider value={settings.kickTone} onChange={(v) => setDrums({ kickTone: v })} min={1} max={120} step={1} />
          </Field>

          <Field label={`Kick punch: ${settings.kickPunch.toFixed(1)}`}>
            <Slider value={settings.kickPunch} onChange={(v) => setDrums({ kickPunch: v })} min={1} max={8} step={0.1} />
          </Field>

          <ReverbControls
            effects={settings.effects}
            onChange={(key: keyof EffectsState, value: EffectsState[keyof EffectsState]) =>
              setEffect(DRUM_TRACK_ID, key, value)}
          />

          <Field label={`Delay mix: ${(settings.effects.delayWet * 100).toFixed(0)}%`}>
            <Slider value={settings.effects.delayWet} onChange={(v) => setEffect(DRUM_TRACK_ID, "delayWet", v)} min={0} max={1} />
          </Field>

          <Field label={`Delay time: ${settings.effects.delayTime.toFixed(2)}s`}>
            <Slider value={settings.effects.delayTime} onChange={(v) => setEffect(DRUM_TRACK_ID, "delayTime", v)} min={0.01} max={4} step={0.01} />
          </Field>

          <Field label={`Delay feedback: ${(settings.effects.delayFeedback * 100).toFixed(0)}%`}>
            <Slider value={settings.effects.delayFeedback} onChange={(v) => setEffect(DRUM_TRACK_ID, "delayFeedback", v)} min={0} max={0.95} step={0.01} />
          </Field>

          <Field label={`Bass boost: ${settings.effects.bassBoost >= 0 ? "+" : ""}${settings.effects.bassBoost.toFixed(0)} dB`}>
            <Slider value={settings.effects.bassBoost} onChange={(v) => setEffect(DRUM_TRACK_ID, "bassBoost", v)} min={-20} max={20} step={1} />
          </Field>

          <Field label={`Gain: ${(settings.effects.gain * 100).toFixed(0)}%`}>
            <Slider value={settings.effects.gain} onChange={(v) => setEffect(DRUM_TRACK_ID, "gain", v)} min={0} max={3} step={0.01} />
          </Field>

          <div className="col-span-2 mt-2 border-t border-border/40 pt-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-foreground/40">Hat effects</div>
          </div>

          <ReverbControls
            effects={settings.hatEffects}
            onChange={(key: keyof EffectsState, value: EffectsState[keyof EffectsState]) =>
              setHatEffect(key, value)}
          />

          <Field label={`Hat delay mix: ${(settings.hatEffects.delayWet * 100).toFixed(0)}%`}>
            <Slider value={settings.hatEffects.delayWet} onChange={(v) => setHatEffect("delayWet", v)} min={0} max={1} />
          </Field>

          <Field label={`Hat delay time: ${settings.hatEffects.delayTime.toFixed(2)}s`}>
            <Slider value={settings.hatEffects.delayTime} onChange={(v) => setHatEffect("delayTime", v)} min={0.01} max={4} step={0.01} />
          </Field>

          <Field label={`Hat delay feedback: ${(settings.hatEffects.delayFeedback * 100).toFixed(0)}%`}>
            <Slider value={settings.hatEffects.delayFeedback} onChange={(v) => setHatEffect("delayFeedback", v)} min={0} max={0.95} step={0.01} />
          </Field>

          <Field label={`Hat bass boost: ${settings.hatEffects.bassBoost >= 0 ? "+" : ""}${settings.hatEffects.bassBoost.toFixed(0)} dB`}>
            <Slider value={settings.hatEffects.bassBoost} onChange={(v) => setHatEffect("bassBoost", v)} min={-20} max={20} step={1} />
          </Field>

          <Field label={`Hat gain: ${(settings.hatEffects.gain * 100).toFixed(0)}%`}>
            <Slider value={settings.hatEffects.gain} onChange={(v) => setHatEffect("gain", v)} min={0} max={3} step={0.01} />
          </Field>
        </div>
      )}

      <div className="mt-2 flex justify-end">
        <Button variant="ghost" onClick={() => setDrums({
          bpm: DEFAULT_DRUM_TRACK.bpm,
          kickVolume: DEFAULT_DRUM_TRACK.kickVolume,
          hatVolume: DEFAULT_DRUM_TRACK.hatVolume,
          kickDecay: DEFAULT_DRUM_TRACK.kickDecay,
          kickTone: DEFAULT_DRUM_TRACK.kickTone,
          kickPunch: DEFAULT_DRUM_TRACK.kickPunch,
          volumeDb: DEFAULT_DRUM_TRACK.volumeDb,
          muted: DEFAULT_DRUM_TRACK.muted,
          effects: DEFAULT_DRUM_TRACK.effects,
          hatEffects: DEFAULT_DRUM_TRACK.hatEffects,
        })} className="text-xs text-foreground/50">
          Reset
        </Button>
      </div>
    </div>
  );
}

function StepGrid({ label, steps, color, onToggle }: {
  label: string; steps: boolean[]; color: string; onToggle: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-8 text-xs text-foreground/50">{label}</div>
      <div className="grid flex-1 gap-1" style={{ gridTemplateColumns: "repeat(16, 1fr)" }}>
        {steps.map((active, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onToggle(i)}
            className={`h-7 rounded-sm transition ${active ? color : "bg-muted hover:bg-muted/60"} ${i % 4 === 0 ? "ring-1 ring-inset ring-border/50" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs uppercase tracking-wide text-foreground/60">{label}</div>
      {children}
    </div>
  );
}
