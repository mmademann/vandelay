import * as Tone from "tone";
import {
  createDualReverb,
  wireDelayToReverbs,
  type DualReverbNodes,
} from "./reverbSlot";

export interface EffectsChain {
  distortion: Tone.Distortion;
  eq: Tone.EQ3;
  delay: Tone.FeedbackDelay;
  reverbs: DualReverbNodes;
  gain: Tone.Gain;
}

export interface TrackCore extends EffectsChain {
  player: Tone.Player;
}

export async function createEffectsChain(output: Tone.ToneAudioNode): Promise<EffectsChain> {
  const gain = new Tone.Gain(1).connect(output);
  const reverbs = await createDualReverb(gain);
  const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0 });
  wireDelayToReverbs(delay, reverbs);
  const eq = new Tone.EQ3({ low: 0, mid: 0, high: 0 }).connect(delay);
  // Distortion before EQ; wet=0 means bypassed at rest
  const distortion = new Tone.Distortion({ distortion: 0.5, wet: 0 }).connect(eq);
  return { distortion, eq, delay, reverbs, gain };
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
