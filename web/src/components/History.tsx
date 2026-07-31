import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../store";
import { useMixStore } from "../mixStore";
import { engine } from "../audio/engine";
import { evictBuffer } from "../lib/loadTrack";
import { removeSettings } from "../lib/settings";
import { removeDubSettings } from "../lib/dubSettings";
import { getAllTrackMeta, putTrackMeta, deleteTrackMeta, type CachedTrackMeta } from "../lib/trackMetaCache";
import { formatTime } from "../lib/format";
import { cn } from "../lib/cn";
import { Spinner } from "./ui/Spinner";

interface HistoryProps {
  className?: string;
  scrollable?: boolean;
  /** single: load track on `/single`. mix-add: append to current mix URL. stems: load stems on `/stems`. */
  mode?: "single" | "mix-add" | "stems";
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
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const status = useStore((s) => s.status);
  const currentId = useStore((s) => s.track?.id);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pendingId = searchParams.get("v");
  const loadingId = loadingIdProp ?? (status === "loading" && pendingId !== currentId ? pendingId : null);

  const exclude = new Set(excludeIds);
  const active = new Set(activeIds);
  const q = query.trim().toLowerCase();
  const visible = entries
    .filter((e) => mode === "mix-add" ? !exclude.has(e.id) : true)
    .filter((e) => !q || e.title.toLowerCase().includes(q));

  function handleQueryChange(val: string) {
    setQuery(val);
    setHighlightIdx(-1);
  }

  function handleKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (visible.length === 0) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, visible.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (ev.key === "Enter" && highlightIdx >= 0) {
      ev.preventDefault();
      handleLoad(visible[highlightIdx]);
    }
  }

  useEffect(() => {
    if (highlightIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlightIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

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
    // Backfill entries where title === id (stored without a real title)
    const broken = cached.filter((e) => e.title === e.id);
    if (broken.length > 0) {
      try {
        const res = await fetch("/api/history");
        if (res.ok) {
          const serverEntries = await res.json() as CachedTrackMeta[];
          const serverMap = new Map(serverEntries.map((e) => [e.id, e]));
          await Promise.all(
            broken.flatMap((e) => {
              const server = serverMap.get(e.id);
              return server && server.title !== e.id ? [putTrackMeta(server)] : [];
            })
          );
        }
      } catch { /* server unavailable */ }
    }
    setEntries(await getAllTrackMeta());
  }, [seeded]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries, currentId]);

  function handleLoad(entry: CachedTrackMeta) {
    if (mode === "stems") {
      navigate(`/stems?v=${entry.id}`);
      return;
    }

    if (mode === "single") {
      if (status === "loading") return;
      if (entry.id === currentId) return;
      navigate(`/single?v=${entry.id}`);
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
          navigate("/single");
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
    removeDubSettings(id);
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

  const list = visible.length === 0 && q ? (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-3 text-xs text-foreground/50">
      No results for "{query.trim()}".
    </div>
  ) : (
    <ul
      ref={listRef}
      className={cn(
        "flex flex-col divide-y divide-border rounded-md border border-border bg-muted/30",
        scrollable && "min-h-0 flex-1 overflow-y-auto",
      )}
    >
      {visible.map((e, idx) => (
        <li key={e.id} className="group relative">
          <button
            type="button"
            onClick={() => handleLoad(e)}
            data-idx={idx}
            className={cn(
              "flex w-full items-start justify-between gap-2 px-2 py-1.5 pr-8 text-left text-sm transition hover:bg-muted/60",
              (mode === "single" ? e.id === currentId : active.has(e.id)) && "bg-muted/40",
              idx === highlightIdx && "bg-muted/60 outline-none ring-1 ring-inset ring-accent/50",
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
      <div className="flex shrink-0 flex-col gap-1.5">
        <div className="text-xs uppercase tracking-wide text-foreground/60">Recent</div>
        {entries.length > 4 && (
          <input
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full rounded-md border border-border bg-muted px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
        )}
      </div>
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
