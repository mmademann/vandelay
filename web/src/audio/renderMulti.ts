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

/**
 * Seconds a slot is displaced from its loop start by Phase.
 *
 * Duplicated character-for-character in multiEngine.ts so export and playback cannot drift;
 * surfaceCoverage enforces that they stay identical.
 */
function phaseOffsetSec(phase: number, barSec: number, loopDur: number): number {
  if (phase <= 0 || barSec <= 0 || loopDur <= 0) return 0;
  return (((phase * barSec) % loopDur) + loopDur) % loopDur;
}

export interface RenderMultiOptions {
  slots: MultiSlot[];
  buffers: Map<string, AudioBuffer>;
  masterSettings: MultiMasterSettings;
  masterLoopLength: number;
  loopCount: number;
  /**
   * Anchor bar length per slot, in that slot's buffer seconds — the same value the UI pushes
   * to the engine via setPhaseBarSec. Phase is a playhead offset rather than part of the loop
   * bounds, so without this the export renders every slot on the downbeat while live playback
   * is displaced.
   */
  phaseBarSec?: Map<string, number>;
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
  const { slots, buffers, masterSettings, masterLoopLength, loopCount, phaseBarSec, export: exportOpts } = opts;

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
      if (!(segDur > 0)) continue;

      // Where in the loop this slot begins reading. Live playback starts here too — see
      // multiEngine.startPositionFor — but the live player has loop = true and wraps at
      // loopEnd on its own. An offline player does not: a single read from loopStart + off
      // for a full segDur runs straight past loopEnd into whatever audio follows.
      //
      // So each repeat is scheduled as two reads, off -> loopEnd then loopStart -> off,
      // which tiles to exactly the audio the live loop produces. At phase 0 the second read
      // is zero-length and this reduces to the original single-read-per-repeat schedule.
      const off = phaseOffsetSec(slot.phase ?? 0, phaseBarSec?.get(slot.id) ?? 0, span);
      const headDur = (span - off) / rate;
      const tailDur = off / rate;

      // Schedule enough repeats within each master loop pass so shorter slots loop
      // continuously (matching live engine behavior where player.loop = true).
      for (let pass = 0; pass < loopCount; pass++) {
        const passEnd = (pass + 1) * masterLoopLength;
        let when = pass * masterLoopLength;
        while (when < passEnd) {
          if (headDur > 0) {
            player.start(when, slot.loopStart + off, Math.min(headDur, passEnd - when));
            when += headDur;
            if (when >= passEnd) break;
          }
          if (tailDur > 0) {
            player.start(when, slot.loopStart, Math.min(tailDur, passEnd - when));
            when += tailDur;
          }
        }
      }
    }

    transport.start();
  }, totalDuration + tail, 2, sampleRate);

  return encodeExport(rendered.get() as AudioBuffer, exportOpts);
}
