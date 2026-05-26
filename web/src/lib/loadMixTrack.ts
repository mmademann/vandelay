import { mixEngine } from "../audio/mixEngine";
import { useMixStore } from "../mixStore";
import { loadAudioBuffer } from "./audioBufferStore";
import { putTrackMeta } from "./trackMetaCache";
import type { TrackMeta } from "./trackApi";

export type { TrackMeta } from "./trackApi";

export async function loadMixTrack(meta: TrackMeta): Promise<void> {
  const { tracks, addTrack, setStatus } = useMixStore.getState();
  if (tracks.some((t) => t.id === meta.id)) return;

  setStatus("loading");
  try {
    const buffer = await loadAudioBuffer(meta.id);
    await mixEngine.addTrack(meta.id, buffer);
    addTrack({ id: meta.id, title: meta.title, duration: meta.duration, buffer });
    putTrackMeta({ id: meta.id, title: meta.title, duration: meta.duration, addedAt: Date.now() });
    setStatus("ready");
  } catch (e) {
    setStatus("error", e instanceof Error ? e.message : "Unknown error");
  }
}
