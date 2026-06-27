import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { UrlLoader } from "../components/UrlLoader";
import { WaveformPlayer } from "../components/WaveformPlayer";
import { EffectsPanel } from "../components/EffectsPanel";
import { ExportPanel } from "../components/ExportPanel";
import { SinglePresetBar } from "../components/SinglePresetBar";
import { History } from "../components/History";
import { Spinner } from "../components/ui/Spinner";
import { useStore } from "../store";
import { engine } from "../audio/engine";
import { loadSingleTrack } from "../lib/loadTrack";
import { resolveTrackFromId } from "../lib/trackApi";

const VIDEO_ID = /^[a-zA-Z0-9_-]{11,16}$/;

export function SinglePage() {
  const track = useStore((s) => s.track);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const setIsPlaying = useStore((s) => s.setIsPlaying);
  const [searchParams] = useSearchParams();
  const urlId = searchParams.get("v") ?? "";
  const loading = status === "loading" && !track;

  useEffect(() => {
    return () => {
      engine.stop();
      setIsPlaying(false);
    };
  }, [setIsPlaying]);

  useEffect(() => {
    let cancelled = false;
    const id = VIDEO_ID.test(urlId) ? urlId : "";
    const currentId = useStore.getState().track?.id ?? "";
    if (id === currentId) return;

    if (!id) {
      engine.stop();
      setIsPlaying(false);
      engine.dispose();
      useStore.getState().clearTrack();
      return;
    }

    engine.stop();
    setIsPlaying(false);

    (async () => {
      try {
        const meta = await resolveTrackFromId(id);
        if (cancelled) return;
        await loadSingleTrack(meta);
      } catch (e) {
        if (cancelled) return;
        useStore.getState().setStatus("error", e instanceof Error ? e.message : "Unknown error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urlId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <UrlLoader />
      </div>

      {status === "error" && error && (
        <div className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="max-h-36 shrink-0 overflow-hidden lg:hidden">
        <History scrollable />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:grid lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_minmax(14rem,18rem)] lg:overflow-hidden lg:gap-4">
        <aside className="hidden min-h-0 flex-col lg:flex">
          <History scrollable className="min-h-0 flex-1" />
        </aside>

        {track && (
          <>
            <div className="flex min-h-0 flex-col gap-3 lg:overflow-hidden">
              <div className="shrink-0">
                <WaveformPlayer />
              </div>
              <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
                <EffectsPanel layout="grid" />
              </div>
            </div>

            <div className="flex min-h-0 flex-col gap-3 lg:overflow-hidden">
              <div className="shrink-0">
                <ExportPanel />
              </div>
              <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
                <SinglePresetBar compact />
              </div>
            </div>
          </>
        )}

        {!track && !loading && (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-foreground/50 lg:col-span-2">
            Load a track to get started.
          </div>
        )}

        {loading && (
          <div className="flex flex-1 items-center justify-center rounded-md border border-border bg-muted/30 py-12 lg:col-span-2">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}
