import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { STEM_NAMES, type StemName } from "../../audio/dubEngine";

interface LibraryEntry {
  id: string;
  title: string;
}

const STEM_LABELS: Record<StemName, string> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  other: "Other",
};

interface Props {
  library?: LibraryEntry[];
  onConfirm: (trackId: string, stemName: StemName | null) => void;
  onClose: () => void;
  onLibraryUpdated?: (library: LibraryEntry[]) => void;
}

function extractVideoId(input: string): string {
  try {
    const url = new URL(input);
    // ?v= param (youtube.com/watch?v=...)
    const v = url.searchParams.get("v");
    if (v) return v;
    // youtu.be/<id> short links
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      if (id) return id;
    }
  } catch {
    // not a URL — treat raw input as the ID
  }
  return input.trim();
}

export function SlotPicker({ library: libraryProp, onConfirm, onClose, onLibraryUpdated }: Props) {
  const [library, setLibrary] = useState<LibraryEntry[]>(libraryProp ?? []);
  const [libraryLoading, setLibraryLoading] = useState(libraryProp === undefined);
  const [search, setSearch] = useState("");
  const [selectedTrack, setSelectedTrack] = useState<LibraryEntry | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [separating, setSeparating] = useState(false);
  const [urlError, setUrlError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchLibrary(signal?: AbortSignal) {
    // no-store: the endpoint sets max-age=10, so a refetch right after separation would
    // otherwise be served from cache and still be missing the track that just finished.
    return fetch("/api/stems/library", { signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load library");
        return r.json() as Promise<LibraryEntry[]>;
      });
  }

  // Always refetch on open (the picker remounts each time). The prop is only a first paint —
  // it can be stale if a track was separated elsewhere or after this page mounted.
  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve()
      .then(() => fetchLibrary(controller.signal))
      .then((data) => {
        if (controller.signal.aborted) return;
        setLibrary(data);
        setLibraryLoading(false);
        // Push upward so slot title resolution sees the fresh titles too.
        onLibraryUpdated?.(data);
      })
      .catch((e) => {
        if (e instanceof Error && e.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setLibraryLoading(false);
      });
    return () => { controller.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleUrlSubmit() {
    const trimmed = urlInput.trim();
    if (!trimmed || separating) return;
    const id = extractVideoId(trimmed);
    if (!id) return;
    setUrlError("");
    setSeparating(true);

    try {
      const res = await fetch("/api/stems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
      });
      const data = await res.json() as { title?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Server error");

      const title = data.title ?? id;

      let retries = 0;
      const MAX_RETRIES = 180; // 6 min at 2s
      pollRef.current = setInterval(async () => {
        if (++retries > MAX_RETRIES) {
          if (pollRef.current) clearInterval(pollRef.current);
          setSeparating(false);
          setUrlError("Separation timed out — check server logs");
          return;
        }
        try {
          const statusRes = await fetch(`/api/stems/${id}/status`);
          if (!statusRes.ok) return;
          const { ready } = await statusRes.json() as { ready: boolean };
          if (!ready) return;

          if (pollRef.current) clearInterval(pollRef.current);

          const updatedLibrary = await fetchLibrary();
          setLibrary(updatedLibrary);
          onLibraryUpdated?.(updatedLibrary);
          setSeparating(false);
          setUrlInput("");

          const entry = updatedLibrary.find((e) => e.id === id) ?? { id, title };
          setSelectedTrack(entry);
        } catch {
          // poll errors are transient — keep polling
        }
      }, 2000);
    } catch (e) {
      setSeparating(false);
      setUrlError(e instanceof Error ? e.message : "Unknown error");
    }
  }

  const filtered = search.trim()
    ? library.filter((e) => e.title.toLowerCase().includes(search.trim().toLowerCase()))
    : library;

  return (
    <div className="flex h-[420px] flex-col gap-3 overflow-hidden rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-foreground/50">Add a stem or track</div>
        <button type="button" onClick={onClose} className="text-foreground/30 hover:text-foreground/70 text-xs px-1">✕</button>
      </div>

      {/* URL submit */}
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleUrlSubmit(); }}
            disabled={separating}
            placeholder="Paste YouTube URL…"
            className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleUrlSubmit}
            disabled={separating || !urlInput.trim()}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground transition hover:bg-muted/70 disabled:opacity-40"
          >
            {separating ? "…" : "Add"}
          </button>
        </div>
        {separating && <div className="text-xs text-foreground/50">Separating… 5–10 min</div>}
        {urlError && <div className="text-xs text-red-400">{urlError}</div>}
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search tracks…"
        className="rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40"
      />

      {/* Track list */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {libraryLoading && (
          <div className="py-6 text-center text-sm text-foreground/50">Loading…</div>
        )}
        {!libraryLoading && library.length === 0 && (
          <div className="py-6 text-center text-sm text-foreground/50">
            Paste a YouTube URL above to separate your first track
          </div>
        )}
        {!libraryLoading && library.length > 0 && filtered.length === 0 && (
          <div className="py-6 text-center text-sm text-foreground/50">No results</div>
        )}
        {!libraryLoading && filtered.map((entry) => (
          <div key={entry.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => setSelectedTrack(selectedTrack?.id === entry.id ? null : entry)}
              className={cn(
                "w-full truncate rounded-md px-3 py-2 text-left text-sm transition",
                selectedTrack?.id === entry.id
                  ? "bg-accent/15 text-foreground"
                  : "text-foreground/70 hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {entry.title}
            </button>
            {selectedTrack?.id === entry.id && (
              <div className="mb-1 mt-1 px-3 pb-2">
                <div className="grid grid-cols-5 gap-2">
                  {STEM_NAMES.map((stem) => (
                    <button
                      key={stem}
                      type="button"
                      onClick={() => {
                        onConfirm(entry.id, stem);
                        onClose();
                      }}
                      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground transition hover:border-accent/50 hover:bg-accent/10 hover:text-accent"
                    >
                      {STEM_LABELS[stem]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      onConfirm(entry.id, null);
                      onClose();
                    }}
                    className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground/70 transition hover:border-accent/50 hover:bg-accent/10 hover:text-accent"
                  >
                    Full track
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
