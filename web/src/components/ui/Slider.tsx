import * as RadixSlider from "@radix-ui/react-slider";
import { cn } from "../../lib/cn";

interface Props {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  className?: string;
}

export function Slider({ value, onChange, min, max, step = 0.01, className }: Props) {
  return (
    <RadixSlider.Root
      className={cn("relative flex h-5 w-full touch-none select-none items-center", className)}
      value={[value]}
      onValueChange={(v) => onChange(v[0])}
      min={min}
      max={max}
      step={step}
    >
      <RadixSlider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <RadixSlider.Range className="absolute h-full bg-accent" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="block h-4 w-4 rounded-full border border-border bg-foreground shadow focus:outline-none" />
    </RadixSlider.Root>
  );
}
