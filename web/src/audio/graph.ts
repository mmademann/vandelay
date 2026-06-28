import * as Tone from "tone";
import {
  createDualReverb,
  wireDelayToReverbs,
  type DualReverbNodes,
} from "./reverbSlot";

export interface BassChain {
  /** Input node — connect audio here; internally splits to shelf and sub path */
  input: Tone.Gain;
  bassShelf: Tone.Filter;
  bassSubFilter: Tone.Filter;
  bassSubDist: Tone.Distortion;
  bassSubGain: Tone.Gain;
}

export interface EffectsChain {
  distortion: Tone.Distortion;
  bass: BassChain;
  delay: Tone.FeedbackDelay;
  reverbs: DualReverbNodes;
  gain: Tone.Gain;
}

export interface TrackCore extends EffectsChain {
  player: Tone.Player;
}

/**
 * Low-shelf EQ + parallel sub-harmonic enhancer.
 * Negative db = shelf cut only. Positive db = shelf boost + sub saturation mixed in.
 */
export function applyBassBoost(bass: BassChain, db: number): void {
  bass.bassShelf.gain.value = db;
  bass.bassSubGain.gain.value = Math.max(0, db) / 20 * 0.4;
}

/**
 * Creates a bass processing node:
 *   input ──► bassShelf (low-shelf EQ) ──► output
 *         └──► bassSubFilter (LPF 120Hz) ──► bassSubDist ──► bassSubGain ──► output
 */
export async function createBassChain(output: Tone.ToneAudioNode): Promise<BassChain> {
  const bassShelf = new Tone.Filter({ type: "lowshelf", frequency: 200, gain: 0 }).connect(output);
  const bassSubFilter = new Tone.Filter({ type: "lowpass", frequency: 120, rolloff: -24 });
  const bassSubDist = new Tone.Distortion({ distortion: 0.3, wet: 1 });
  const bassSubGain = new Tone.Gain(0);
  bassSubFilter.connect(bassSubDist);
  bassSubDist.connect(bassSubGain);
  bassSubGain.connect(output);
  const input = new Tone.Gain(1);
  input.connect(bassShelf);
  input.connect(bassSubFilter);
  return { input, bassShelf, bassSubFilter, bassSubDist, bassSubGain };
}

export async function createEffectsChain(output: Tone.ToneAudioNode): Promise<EffectsChain> {
  const gain = new Tone.Gain(1).connect(output);
  const reverbs = await createDualReverb(gain);
  const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0, maxDelay: 4 });
  wireDelayToReverbs(delay, reverbs);
  const bass = await createBassChain(delay);
  const distortion = new Tone.Distortion({ distortion: 0.5, wet: 0 }).connect(bass.input);
  return { distortion, bass, delay, reverbs, gain };
}

export async function createTrackCore(
  buffer: AudioBuffer,
  output: Tone.ToneAudioNode,
): Promise<TrackCore> {
  const chain = await createEffectsChain(output);

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

  const player = new Tone.Player(toneBuffer).connect(chain.distortion);
  player.loop = false;
  player.loopStart = 0;
  player.loopEnd = buffer.duration;

  return { player, ...chain };
}
