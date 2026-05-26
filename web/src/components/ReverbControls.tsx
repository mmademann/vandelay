import type { EffectsState, ReverbType } from "../store";
import { resolveReverbType } from "../store";
import { cn } from "../lib/cn";
import { Slider } from "./ui/Slider";

const REVERB_TYPES: { label: string; value: ReverbType }[] = [
  { label: "Synth", value: "algorithmic" },
  { label: "Hall", value: "convolution" },
];

interface ReverbControlsProps {
  effects: EffectsState;
  onChange: <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => void;
  labelClassName?: string;
}

export function ReverbControls({ effects, onChange, labelClassName }: ReverbControlsProps) {
  const reverbType = resolveReverbType(effects);
  const labelClass = cn(
    "text-xs uppercase tracking-wide text-foreground/60",
    labelClassName,
  );

  return (
    <>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <div className={labelClass}>Reverb type</div>
        <div className="flex gap-2">
          {REVERB_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onChange("reverbType", t.value)}
              className={cn(
                "rounded-md px-3 py-1 text-xs transition",
                reverbType === t.value
                  ? "bg-accent text-black"
                  : "bg-muted text-foreground/60 hover:bg-muted/80",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-foreground/40">
          {reverbType === "convolution"
            ? "Hall uses an impulse-response reverb (closer to classic slowed+reverb)."
            : "Synth is the original Tone.js algorithmic reverb with adjustable decay."}
        </p>
      </div>

      {reverbType === "algorithmic" && (
        <div className="flex flex-col gap-2">
          <div className={labelClass}>Reverb decay: {effects.reverbDecay.toFixed(1)}s</div>
          <Slider
            value={effects.reverbDecay}
            onChange={(v) => onChange("reverbDecay", v)}
            min={0.1}
            max={10}
            step={0.1}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className={labelClass}>Reverb wet: {(effects.reverbWet * 100).toFixed(0)}%</div>
        <Slider
          value={effects.reverbWet}
          onChange={(v) => onChange("reverbWet", v)}
          min={0}
          max={1}
        />
      </div>
    </>
  );
}
