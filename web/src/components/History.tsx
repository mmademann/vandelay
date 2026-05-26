import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../store";
import { useMixStore } from "../mixStore";
import { engine } from "../audio/engine";
import { evictBuffer } from "../lib/loadTrack";
import { removeSettings } from "../lib/settings";
import { getAllTrackMeta, putTrackMeta, deleteTrackMeta, type CachedTrackMeta } from "../lib/trackMetaCache";
import { formatTime } from "../lib/format";
import { cn } from "../lib/cn";
import { Spinner } from "./ui/Spinner";

interface HistoryProps {
  className?: string;
  scrollable?: boolean;
  /** single: load track on `/`. mix-add: append to current mix URL. */
  mode?: "single" | "mix-add";
  /** mix-add: hide tracks already in the mix */
  excludeIds?: string[];
  /** mix-add: highlight tracks currently loaded */
  activeIds?: string[];
  loadingId?: string | null;
}

export function History({
  className,
  scrollable = false,
  mode = "single",
  excludeIds = [],
  activeIds = [],
  loadingId: loadingIdProp = null,
}: HistoryProps) {
  const [entries, setEntries] = useState<CachedTrackMeta[]>([]);
  const [seeded, setSeeded] = useState(false);
  const status = useStore((s) => s.status);
  const currentId = useStore((s) => s.track?.id);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pendingId = searchParams.get("v");
  const loadingId = loadingIdProp ?? (status === "loading" && pendingId !== currentId ? pendingId : null);

  const exclude = new Set(excludeIds);
  const active = new Set(activeIds);
  const visible = mode === "mix-add" ? entries.filter((e) => !exclude.has(e.id)) : entries;

  const loadEntries = useCallback(async () => {
    const cached = await getAllTrackMeta();
    if (cached.length === 0 && !seeded) {
      try {
        const res = await fetch("/api/history");
        if (res.ok) {
          const serverEntries = await res.json() as CachedTrackMeta[];
          await Promise.all(serverEntries.map((e) => putTrackMeta(e)));
          setSeeded(true);
          setEntries(await getAllTrackMeta());
          return;
        }
      } catch {
        /* server unavailable — S3 deploy, ignore */
      }
      setSeeded(true);
    }
    setEntries(cached);
  }, [seeded]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries, currentId]);

  function handleLoad(entry: CachedTrackMeta) {
    if (mode === "single") {
      if (status === "loading") return;
      if (entry.id === currentId) return;
      navigate(`/?v=${entry.id}`);
      return;
    }

    const mixStatus = useMixStore.getState().status;
    if (mixStatus === "loading") return;
    if (active.has(entry.id)) return;

    const ids = (searchParams.get("v") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.includes(entry.id)) ids.push(entry.id);
    navigate(`/mix?v=${ids.join(",")}`);
  }

  async function handleRemove(id: string, e: React.MouseEvent) {
    e.stopPropagation();

    if (mode === "single") {
      const urlId = searchParams.get("v");
      const playingId = useStore.getState().track?.id;
      if (id === urlId || id === playingId) {
        engine.stop();
        useStore.getState().setIsPlaying(false);
        if (urlId === id) {
          navigate("/");
        } else {
          engine.dispose();
          useStore.getState().clearTrack();
        }
      }
    } else {
      const ids = (searchParams.get("v") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.includes(id)) {
        const next = ids.filter((x) => x !== id);
        navigate(next.length > 0 ? `/mix?v=${next.join(",")}` : "/mix");
      }
    }

    removeSettings(id);
    evictBuffer(id);
    await deleteTrackMeta(id);
    fetch(`/api/history/${id}`, { method: "DELETE" }).catch(() => undefined);
    setEntries(await getAllTrackMeta());
  }

  if (entries.length === 0) return null;
  if (mode === "mix-add" && visible.length === 0) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <div className="shrink-0 text-xs uppercase tracking-wide text-foreground/60">Recent</div>
        <div className="rounded-md border border-border bg-muted/30 px-2 py-3 text-xs text-foreground/50">
          All recent tracks are in the mix.
        </div>
      </div>
    );
  }

  const list = (
    <ul
      className={cn(
        "flex flex-col divide-y divide-border rounded-md border border-border bg-muted/30",
        scrollable && "min-h-0 flex-1 overflow-y-auto",
      )}
    >
      {visible.map((e) => (
        <li key={e.id} className="group relative">
          <button
            type="button"
            onClick={() => handleLoad(e)}
            className={cn(
              "flex w-full items-start justify-between gap-2 px-2 py-1.5 pr-8 text-left text-sm transition hover:bg-muted/60",
              (mode === "single" ? e.id === currentId : active.has(e.id)) && "bg-muted/40",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground">{e.title}</div>
              <div className="text-[10px] text-foreground/50 tabular-nums">
                {formatTime(e.duration)} · {timeAgo(e.addedAt)}
              </div>
            </div>
            {loadingId === e.id && <Spinner className="shrink-0 text-foreground/60" />}
          </button>
          <button
            type="button"
            onClick={(ev) => handleRemove(e.id, ev)}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-foreground/40 opacity-0 transition hover:bg-muted hover:text-foreground/80 group-hover:opacity-100"
            aria-label="Remove from history"
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={cn("flex flex-col gap-2", scrollable && "min-h-0", className)}>
      <div className="shrink-0 text-xs uppercase tracking-wide text-foreground/60">Recent</div>
      {list}
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
