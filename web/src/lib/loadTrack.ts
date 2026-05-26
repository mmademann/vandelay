import { engine } from "../audio/engine";
import { effectiveEffects, useStore } from "../store";
import { loadAudioBuffer } from "./audioBufferStore";
import { putTrackMeta } from "./trackMetaCache";
import type { TrackMeta } from "./trackApi";

export { evictBuffer } from "./audioBufferStore";
export type { TrackMeta } from "./trackApi";

export async function loadSingleTrack(meta: TrackMeta): Promise<void> {
  const { setStatus, setTrack, setIsPlaying } = useStore.getState();
  engine.stop();
  setIsPlaying(false);
  setStatus("loading");
  try {
    const buffer = await loadAudioBuffer(meta.id);
    await engine.load(buffer);
    setTrack({ id: meta.id, title: meta.title, duration: meta.duration, buffer });
    const { effects, effectsEnabled, loopStart, loopEnd } = useStore.getState();
    if (engine.hasGraph()) {
      engine.setLoop(loopStart, loopEnd);
      engine.applyEffects(effectiveEffects(effects, effectsEnabled));
    }
    putTrackMeta({ id: meta.id, title: meta.title, duration: meta.duration, addedAt: Date.now() });
  } catch (e) {
    setStatus("error", e instanceof Error ? e.message : "Unknown error");
  }
}
