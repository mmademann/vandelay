import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useMixStore } from "../mixStore";
import { mixEngine } from "../audio/mixEngine";
import { drumEngine } from "../audio/drumEngine";
import { loadMixTrack } from "../lib/loadMixTrack";
import { resolveTrackFromId } from "../lib/trackApi";
import { AddMixTrack } from "../components/mix/AddMixTrack";
import { TrackStrip } from "../components/mix/TrackStrip";
import { MasterControls } from "../components/mix/MasterControls";
import { DrumStrip } from "../components/mix/DrumStrip";
import { History } from "../components/History";
import { Spinner } from "../components/ui/Spinner";

const VIDEO_ID = /^[a-zA-Z0-9_-]{11,16}$/;

export function MixPage() {
  const tracks = useMixStore((s) => s.tracks);
  const setIsPlaying = useMixStore((s) => s.setIsPlaying);
  const [searchParams] = useSearchParams();
  const urlValue = searchParams.get("v") ?? "";

  const loadedIds = new Set(tracks.map((t) => t.id));
  const trackIds = tracks.map((t) => t.id);
  const pendingIds = urlValue
    .split(",")
    .map((s) => s.trim())
    .filter((id) => VIDEO_ID.test(id) && !loadedIds.has(id));
  const loadingId = pendingIds[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    const ids = urlValue
      .split(",")
      .map((s) => s.trim())
      .filter((id) => VIDEO_ID.test(id));
    const currentIds = useMixStore.getState().tracks.map((t) => t.id);

    if (ids.length === 0) {
      if (currentIds.length > 0) {
        mixEngine.disposeAll();
        useMixStore.getState().clearTracks();
      }
      return;
    }

    const toRemove = currentIds.filter((id) => !ids.includes(id));
    for (const id of toRemove) {
      mixEngine.removeTrack(id);
      useMixStore.getState().removeTrack(id);
    }

    const present = new Set(useMixStore.getState().tracks.map((t) => t.id));
    const toAdd = ids.filter((id) => !present.has(id));
    if (toAdd.length === 0) return;

    (async () => {
      for (const id of toAdd) {
        if (cancelled) return;
        try {
          const meta = await resolveTrackFromId(id);
          if (cancelled) return;
          await loadMixTrack(meta);
        } catch (e) {
          if (cancelled) return;
          useMixStore.getState().setStatus("error", e instanceof Error ? e.message : "Unknown error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urlValue]);

  useEffect(() => {
    return () => {
      mixEngine.stopAll();
      drumEngine.stop();
      setIsPlaying(false);
    };
  }, [setIsPlaying]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <AddMixTrack />
      </div>

      <div className="max-h-36 shrink-0 overflow-hidden lg:hidden">
        <History
          scrollable
          mode="mix-add"
          excludeIds={trackIds}
          activeIds={trackIds}
          loadingId={loadingId}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:grid lg:grid-cols-[11rem_minmax(0,1fr)_14rem] lg:overflow-hidden lg:gap-4">
        <aside className="hidden min-h-0 flex-col lg:flex">
          <History
            scrollable
            mode="mix-add"
            excludeIds={trackIds}
            activeIds={trackIds}
            loadingId={loadingId}
            className="min-h-0 flex-1"
          />
        </aside>

        <div className="order-1 shrink-0 lg:col-start-3 lg:row-start-1 lg:overflow-y-auto">
          <MasterControls compact />
        </div>

        <div className="order-2 flex min-h-0 flex-1 flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:overflow-y-auto">
          {tracks.length === 0 && pendingIds.length === 0 && (
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-foreground/50">
              Add a track to get started.
            </div>
          )}

          {tracks.map((t) => (
            <TrackStrip key={t.id} track={t} />
          ))}

          {pendingIds.map((id) => (
            <div
              key={id}
              className="flex h-24 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30"
            >
              <Spinner />
            </div>
          ))}

          <DrumStrip />
        </div>
      </div>
    </div>
  );
}
