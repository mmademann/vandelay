import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = "primary", ...props }, ref) => {
    const styles: Record<Variant, string> = {
      primary: "bg-accent text-black hover:opacity-90",
      secondary: "bg-muted text-foreground hover:bg-muted/80",
      ghost: "bg-transparent hover:bg-muted/50",
    };
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none",
          styles[variant],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
