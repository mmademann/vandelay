import * as Tone from "tone";
import { EFFECTS_LIMITS, type EffectsState, resolveReverbType } from "../store";

export interface DualReverbNodes {
  algorithmic: Tone.Reverb;
  algorithmicOut: Tone.Gain;
  convInput: Tone.Gain;
  convolver: ConvolverNode;
  convDry: Tone.Gain;
  convWet: Tone.Gain;
}

let impulseBuffer: AudioBuffer | null = null;
let impulsePromise: Promise<AudioBuffer> | null = null;

/** Soft, dark IR for slowed+reverb-style Hall (used when `/ir/hall.wav` is absent). */
export function synthesizeHallImpulse(sampleRate: number): AudioBuffer {
  const durationSec = 4.5;
  const length = Math.floor(sampleRate * durationSec);
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  left[0] = 0.75;
  right[0] = 0.7;

  let lpL = 0;
  let lpR = 0;
  for (let i = 1; i < length; i++) {
    const t = i / length;
    const env = Math.exp(-2.8 * t) * (1 - Math.exp(-8 * t));
    const nL = (Math.random() * 2 - 1) * env;
    const nR = (Math.random() * 2 - 1) * env;
    lpL = lpL * 0.94 + nL * 0.06;
    lpR = lpR * 0.93 + nR * 0.07;
    left[i] = lpL * 0.12;
    right[i] = lpR * 0.12;
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const gain = 0.85 / (peak || 1);
  for (let i = 0; i < length; i++) {
    left[i] *= gain;
    right[i] *= gain;
  }
  return buffer;
}

export async function getImpulseResponse(): Promise<AudioBuffer> {
  if (impulseBuffer) return impulseBuffer;
  if (!impulsePromise) {
    impulsePromise = (async () => {
      const sampleRate = Tone.getContext().sampleRate;
      try {
        const res = await fetch("/ir/hall.wav");
        if (res.ok) {
          const ab = await res.arrayBuffer();
          const ctx = Tone.getContext().rawContext as AudioContext;
          impulseBuffer = await ctx.decodeAudioData(ab.slice(0));
          return impulseBuffer;
        }
      } catch {
        /* use synthetic IR */
      }
      impulseBuffer = synthesizeHallImpulse(sampleRate);
      return impulseBuffer;
    })();
  }
  return impulsePromise;
}

export async function createDualReverb(output: Tone.ToneAudioNode): Promise<DualReverbNodes> {
  const algorithmicOut = new Tone.Gain(1).connect(output);
  const algorithmic = new Tone.Reverb({ decay: 3, wet: 0 }).connect(algorithmicOut);
  await algorithmic.generate();

  const convWet = new Tone.Gain(0).connect(output);
  const convDry = new Tone.Gain(0).connect(output);
  const convInput = new Tone.Gain(1);
  const convolver = Tone.getContext().createConvolver();
  convolver.normalize = true;
  convInput.connect(convolver);
  convolver.connect(convWet.input);

  const ir = await getImpulseResponse();
  convolver.buffer = ir;

  return { algorithmic, algorithmicOut, convInput, convolver, convDry, convWet };
}

export function wireDelayToReverbs(delay: Tone.FeedbackDelay, reverbs: DualReverbNodes): void {
  delay.connect(reverbs.algorithmic);
  delay.connect(reverbs.convInput);
  delay.connect(reverbs.convDry);
}

export function applyDualReverb(reverbs: DualReverbNodes, e: EffectsState): void {
  const wet = Math.min(
    EFFECTS_LIMITS.reverbWet.max,
    Math.max(EFFECTS_LIMITS.reverbWet.min, e.reverbWet),
  );
  if (resolveReverbType(e) === "convolution") {
    reverbs.algorithmic.wet.value = 0;
    reverbs.algorithmicOut.gain.value = 0;
    reverbs.convDry.gain.value = 1 - wet;
    reverbs.convWet.gain.value = wet;
  } else {
    reverbs.algorithmic.decay = Math.max(EFFECTS_LIMITS.reverbDecay.engineMin, e.reverbDecay);
    reverbs.algorithmic.wet.value = wet;
    reverbs.algorithmicOut.gain.value = 1;
    reverbs.convDry.gain.value = 0;
    reverbs.convWet.gain.value = 0;
  }
}

export function reverbExportTailSec(e: EffectsState): number {
  const cap = 8;
  if (resolveReverbType(e) === "convolution") {
    return Math.min(impulseBuffer?.duration ?? 3.5, cap);
  }
  return Math.min(e.reverbDecay, cap);
}

export async function ensureImpulseLoaded(): Promise<void> {
  await getImpulseResponse();
}

export async function createOfflineEqChain(
  effects: EffectsState,
  output: Tone.ToneAudioNode,
): Promise<Tone.Distortion> {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const gain = new Tone.Gain(effects.gain).connect(output);
  const reverbs = await createDualReverb(gain);
  applyDualReverb(reverbs, effects);
  const delay = new Tone.FeedbackDelay({
    delayTime: clamp(effects.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max),
    feedback: clamp(effects.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max),
    wet: clamp(effects.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max),
    maxDelay: 4,
  });
  wireDelayToReverbs(delay, reverbs);
  const bassShelf = new Tone.Filter({ type: "lowshelf", frequency: 200, gain: effects.bassBoost }).connect(delay);
  const bassSubFilter = new Tone.Filter({ type: "lowpass", frequency: 120, rolloff: -24 });
  const bassSubDist = new Tone.Distortion({ distortion: 0.3, wet: 1 });
  const bassSubGain = new Tone.Gain(Math.max(0, effects.bassBoost) / 20 * 0.4);
  bassSubFilter.connect(bassSubDist);
  bassSubDist.connect(bassSubGain);
  bassSubGain.connect(delay);
  const bassInput = new Tone.Gain(1);
  bassInput.connect(bassShelf);
  bassInput.connect(bassSubFilter);
  const grit = clamp(effects.grit ?? 0, 0, 1);
  return new Tone.Distortion({ distortion: Math.pow(grit, 0.5), wet: grit }).connect(bassInput);
}

export function disposeDualReverb(reverbs: DualReverbNodes): void {
  reverbs.algorithmic.disconnect();
  reverbs.algorithmic.dispose();
  reverbs.algorithmicOut.disconnect();
  reverbs.algorithmicOut.dispose();
  reverbs.convInput.disconnect();
  reverbs.convInput.dispose();
  try {
    reverbs.convolver.disconnect();
  } catch {
    /* ignore */
  }
  reverbs.convDry.disconnect();
  reverbs.convDry.dispose();
  reverbs.convWet.disconnect();
  reverbs.convWet.dispose();
}
