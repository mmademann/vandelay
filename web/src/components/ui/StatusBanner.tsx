import { Spinner } from "./Spinner";

interface Props {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

export function StatusBanner({ status, error }: Props) {
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center rounded-md border border-border bg-muted/30 px-4 py-3 text-foreground/70">
        <Spinner />
      </div>
    );
  }
  if (status === "error" && error) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {error}
      </div>
    );
  }
  return null;
}
