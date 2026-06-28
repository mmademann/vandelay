import * as Tone from "tone";
import type { CollabSlot, CollabMasterSettings } from "../lib/collabSettings";
import { encodeExport } from "./encodeExport";
import { reverbExportTailSec } from "./reverbSlot";
import { createOfflineCollabEqChain } from "./collabChain";
import type { ExportEncodeOptions } from "./exportOptions";

function slotPlaybackRate(slot: CollabSlot): number {
  return slot.linkPitch ? slot.speed : slot.speed * Math.pow(2, slot.pitch / 12);
}

export interface RenderCollabOptions {
  slots: CollabSlot[];
  buffers: Map<string, AudioBuffer>;
  masterSettings: CollabMasterSettings;
  masterLoopLength: number;
  loopCount: number;
  export: ExportEncodeOptions;
}

function effectiveMute(slot: CollabSlot, anySoloed: boolean): boolean {
  return slot.muted || (anySoloed && !slot.soloed);
}

export function canExportCollab(opts: Pick<RenderCollabOptions, "slots" | "buffers" | "masterLoopLength">): boolean {
  if (opts.masterLoopLength <= 0) return false;
  const anySoloed = opts.slots.some((s) => s.soloed);
  return opts.slots.some(
    (s) => opts.buffers.has(s.id) && !effectiveMute(s, anySoloed),
  );
}

export async function renderCollab(opts: RenderCollabOptions): Promise<Blob> {
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
      const rate = slotPlaybackRate(slot);

      const volume = new Tone.Volume(slot.gain).connect(master);
      const eq = await createOfflineCollabEqChain(slot.effects, volume);

      const channels: Float32Array[] = [];
      for (let c = 0; c < src.numberOfChannels; c++) channels.push(src.getChannelData(c));
      const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

      const player = new Tone.Player(toneBuffer).connect(eq);
      player.loop = false;
      player.playbackRate = rate;

      const span = slot.loopEnd - slot.loopStart;
      const segmentDuration = span / rate;

      for (let i = 0; i < loopCount; i++) {
        player.start(i * segmentDuration, slot.loopStart, span);
      }
    }

    transport.start();
  }, totalDuration + tail, 2, sampleRate);

  return encodeExport(rendered.get() as AudioBuffer, exportOpts);
}
