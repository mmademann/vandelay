import * as Tone from "tone";
import type { MultiSlot, MultiMasterSettings } from "../lib/multiSettings";
import { encodeExport } from "./encodeExport";
import { reverbExportTailSec } from "./reverbSlot";
import { createOfflineMultiEqChain } from "./multiChain";
import type { ExportEncodeOptions } from "./exportOptions";

function slotPlaybackRate(slot: MultiSlot, masterSpeed = 1): number {
  const base = slot.linkPitch ? slot.speed : slot.speed * Math.pow(2, slot.pitch / 12);
  return slot.bypassMasterSpeed ? base : base * masterSpeed;
}

export interface RenderMultiOptions {
  slots: MultiSlot[];
  buffers: Map<string, AudioBuffer>;
  masterSettings: MultiMasterSettings;
  masterLoopLength: number;
  loopCount: number;
  export: ExportEncodeOptions;
}

function effectiveMute(slot: MultiSlot, anySoloed: boolean): boolean {
  return slot.muted || (anySoloed && !slot.soloed);
}

export function canExportMulti(opts: Pick<RenderMultiOptions, "slots" | "buffers" | "masterLoopLength">): boolean {
  if (opts.masterLoopLength <= 0) return false;
  const anySoloed = opts.slots.some((s) => s.soloed);
  return opts.slots.some(
    (s) => opts.buffers.has(s.id) && !effectiveMute(s, anySoloed),
  );
}

export async function renderMulti(opts: RenderMultiOptions): Promise<Blob> {
  const { slots, buffers, masterSettings, masterLoopLength, loopCount, export: exportOpts } = opts;

  const anySoloed = slots.some((s) => s.soloed);
  const activeSlots = slots.filter(
    (s) => buffers.has(s.id) && !effectiveMute(s, anySoloed),
  );

  if (activeSlots.length === 0) throw new Error("No active slots to render");
  if (masterLoopLength <= 0) throw new Error("Master loop length must be greater than zero");

  const totalDuration = masterLoopLength * loopCount;

  // Include Big Knob spring decay (~3s) if any slot uses it
  const hasBigKnob = activeSlots.some((s) => (s.effects.bigKnobWet ?? 0) > 0);
  const tail = Math.min(
    Math.max(
      hasBigKnob ? 3 : 0,
      ...activeSlots.map((s) => reverbExportTailSec(s.effects)),
    ),
    8,
  );

  const sampleRate = Math.max(
    ...activeSlots.map((s) => buffers.get(s.id)!.sampleRate),
    44100,
  );

  const rendered = await Tone.Offline(async ({ transport }) => {
    const master = new Tone.Volume(masterSettings.gain).toDestination();

    for (const slot of activeSlots) {
      const src = buffers.get(slot.id)!;
      const rate = slotPlaybackRate(slot, masterSettings.masterSpeed ?? 1);

      const volume = new Tone.Volume(slot.gain).connect(master);
      const eq = await createOfflineMultiEqChain(slot.effects, volume);

      const channels: Float32Array[] = [];
      for (let c = 0; c < src.numberOfChannels; c++) channels.push(src.getChannelData(c));
      const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

      const player = new Tone.Player(toneBuffer).connect(eq);
      player.loop = false;
      player.playbackRate = rate;

      const span = slot.loopEnd - slot.loopStart;
      const segDur = span / rate; // real-time duration of one play of this slot's loop region
      // Schedule enough repeats within each master loop pass so shorter slots loop
      // continuously (matching live engine behavior where player.loop = true).
      const repeatsPerMaster = Math.ceil(masterLoopLength / segDur);
      for (let pass = 0; pass < loopCount; pass++) {
        for (let r = 0; r < repeatsPerMaster; r++) {
          const when = pass * masterLoopLength + r * segDur;
          // Don't schedule beyond this pass's end
          if (when >= (pass + 1) * masterLoopLength) break;
          const remaining = (pass + 1) * masterLoopLength - when;
          player.start(when, slot.loopStart, Math.min(segDur, remaining));
        }
      }
    }

    transport.start();
  }, totalDuration + tail, 2, sampleRate);

  return encodeExport(rendered.get() as AudioBuffer, exportOpts);
}
