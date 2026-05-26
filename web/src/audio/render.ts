import * as Tone from "tone";
import type { EffectsState } from "../store";
import { exportOutputDuration, playbackRateForEffects } from "./engine";
import { encodeExport } from "./encodeExport";
import type { ExportEncodeOptions } from "./exportOptions";
import { createOfflineEqChain, ensureImpulseLoaded, reverbExportTailSec } from "./reverbSlot";

interface RenderOptions {
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
  loopCount: number;
  effects: EffectsState;
  export: ExportEncodeOptions;
}

export async function renderLoop(opts: RenderOptions): Promise<Blob> {
  const { buffer, loopStart, loopEnd, loopCount, effects, export: exportOpts } = opts;
  await ensureImpulseLoaded();
  const rate = playbackRateForEffects(effects);
  const span = loopEnd - loopStart;
  const segmentDuration = span / rate;
  const totalDuration = exportOutputDuration(loopStart, loopEnd, loopCount, effects);
  const tail = reverbExportTailSec(effects);
  const sampleRate = buffer.sampleRate;

  const rendered = await Tone.Offline(async ({ transport }) => {
    const gain = new Tone.Gain(1).toDestination();
    const eq = await createOfflineEqChain(effects, gain);

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c));
    }
    const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

    const player = new Tone.Player(toneBuffer).connect(eq);
    player.loop = false;
    player.playbackRate = rate;

    for (let i = 0; i < loopCount; i++) {
      player.start(i * segmentDuration, loopStart, span);
    }

    transport.start();
  }, totalDuration + tail, 2, sampleRate);

  return encodeExport(rendered.get() as AudioBuffer, exportOpts);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
