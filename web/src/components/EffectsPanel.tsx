import { useEffect } from "react";
import { effectiveEffects, useStore } from "../store";
import { engine } from "../audio/engine";
import { cn } from "../lib/cn";
import { Slider } from "./ui/Slider";
import { Switch } from "./ui/Switch";
import { Button } from "./ui/Button";
import { ReverbControls } from "./ReverbControls";

interface EffectsPanelProps {
  layout?: "stack" | "grid";
}

export function EffectsPanel({ layout = "stack" }: EffectsPanelProps) {
  const trackId = useStore((s) => s.track?.id);
  const effects = useStore((s) => s.effects);
  const effectsEnabled = useStore((s) => s.effectsEnabled);
  const setEffect = useStore((s) => s.setEffect);
  const setEffectsEnabled = useStore((s) => s.setEffectsEnabled);
  const resetEffects = useStore((s) => s.resetEffects);
  useEffect(() => {
    engine.applyEffects(effectiveEffects(effects, effectsEnabled));
  }, [trackId, effects, effectsEnabled]);

  const grid = layout === "grid";

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-foreground/60">Effects</span>
        <div className="flex items-center gap-2 text-xs text-foreground/70">
          <span>{effectsEnabled ? "On" : "Off"}</span>
          <Switch checked={effectsEnabled} onChange={setEffectsEnabled} />
        </div>
      </div>

      <div className={cn("mt-3", effectsEnabled ? undefined : "pointer-events-none opacity-40")}>
      <div className={cn("grid gap-3", grid && "sm:grid-cols-2 sm:gap-x-4")}>
      <Row label={`Speed: ${effects.speed.toFixed(2)}×`}>
        <Slider value={effects.speed} onChange={(v) => setEffect("speed", v)} min={0.5} max={1.0} />
      </Row>

      <Row
        label={`Pitch: ${effects.linkPitch ? "linked" : `${effects.pitch >= 0 ? "+" : ""}${effects.pitch} st`}`}
        right={
          <div className="flex items-center gap-2 text-xs text-foreground/70">
            link
            <Switch checked={effects.linkPitch} onChange={(b) => setEffect("linkPitch", b)} />
          </div>
        }
      >
        <Slider
          value={effects.pitch}
          onChange={(v) => setEffect("pitch", Math.round(v))}
          min={-12}
          max={12}
          step={1}
          className={effects.linkPitch ? "opacity-40 pointer-events-none" : ""}
        />
      </Row>

      <ReverbControls effects={effects} onChange={setEffect} />

      <Row label={`Delay mix: ${(effects.delayWet * 100).toFixed(0)}%`}>
        <Slider value={effects.delayWet} onChange={(v) => setEffect("delayWet", v)} min={0} max={1} />
      </Row>

      <Row label={`Delay time: ${effects.delayTime.toFixed(2)}s`}>
        <Slider value={effects.delayTime} onChange={(v) => setEffect("delayTime", v)} min={0.01} max={4} step={0.01} />
      </Row>

      <Row label={`Delay feedback: ${(effects.delayFeedback * 100).toFixed(0)}%`}>
        <Slider value={effects.delayFeedback} onChange={(v) => setEffect("delayFeedback", v)} min={0} max={0.95} step={0.01} />
      </Row>

      <Row label={`Bass boost: ${effects.bassBoost >= 0 ? "+" : ""}${effects.bassBoost.toFixed(0)} dB`}>
        <Slider value={effects.bassBoost} onChange={(v) => setEffect("bassBoost", v)} min={-20} max={20} step={1} />
      </Row>

      <Row label={`Gain: ${(effects.gain * 100).toFixed(0)}%`}>
        <Slider value={effects.gain} onChange={(v) => setEffect("gain", v)} min={0} max={3} step={0.01} />
      </Row>

      {grid && (
        <div className="flex justify-end sm:col-span-2">
          <Button variant="ghost" onClick={resetEffects} className="text-xs text-foreground/50">
            Reset effects
          </Button>
        </div>
      )}
      </div>

      {!grid && (
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" onClick={resetEffects} className="text-xs text-foreground/50">
          Reset effects
        </Button>
      </div>
      )}
      </div>
    </div>
  );
}

function Row({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-foreground/60">
        <span>{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}
