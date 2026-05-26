import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "../../lib/cn";

interface Props {
  checked: boolean;
  onChange: (b: boolean) => void;
  className?: string;
}

export function Switch({ checked, onChange, className }: Props) {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      className={cn(
        "relative h-5 w-9 rounded-full bg-muted data-[state=checked]:bg-accent transition",
        className,
      )}
    >
      <RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}
