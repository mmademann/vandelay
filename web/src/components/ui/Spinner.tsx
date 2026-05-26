import { cn } from "../../lib/cn";

interface Props {
  className?: string;
}

export function Spinner({ className }: Props) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}
