import * as Tone from "tone";
import { EFFECTS_LIMITS, type EffectsState } from "../store";
import {
  createDualReverb,
  applyDualReverb,
  synthesizeSpringImpulse,
  type DualReverbNodes,
} from "./reverbSlot";
import { applyBassBoost, createBassChain, type BassChain } from "./graph";
import { TapeDelay } from "./tapeDelay";

export interface CollabEffectsChain {
  distortion: Tone.Distortion;
  eqLo: Tone.Filter;
  eqMid: Tone.Filter;
  eqHi: Tone.Filter;
  phaser: Tone.Phaser;
  chorus: Tone.Chorus;
  bass: BassChain;
  delay: TapeDelay;
  reverbs: DualReverbNodes;
  gain: Tone.Gain;
}

export async function createCollabEffectsChain(output: Tone.ToneAudioNode): Promise<CollabEffectsChain> {
  const gain = new Tone.Gain(1).connect(output);
  const reverbs = await createDualReverb(gain);
  const delay = new TapeDelay(reverbs.algorithmic, { delayTime: 0.25, feedback: 0.3, wet: 0 });
  // Also wire delay wet signal to convolution reverb + convDry (mirrors wireDelayToReverbs)
  delay.connect(reverbs.convInput);
  delay.connect(reverbs.convDry);
  const bass = await createBassChain(delay.input);
  const chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 }).connect(bass.input);
  chorus.start();
  const phaser = new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: 0 }).connect(chorus);
  const eqHi = new Tone.Filter({ type: "highshelf", frequency: 6000, gain: 0 }).connect(phaser);
  const eqMid = new Tone.Filter({ type: "peaking", frequency: 1000, Q: 1.0, gain: 0 }).connect(eqHi);
  const eqLo = new Tone.Filter({ type: "lowshelf", frequency: 100, gain: 0 }).connect(eqMid);
  const distortion = new Tone.Distortion({ distortion: 0.5, wet: 0 }).connect(eqLo);
  return { distortion, eqLo, eqMid, eqHi, phaser, chorus, bass, delay, reverbs, gain };
}

export async function createOfflineCollabEqChain(
  effects: EffectsState,
  output: Tone.ToneAudioNode,
): Promise<Tone.Distortion> {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const gain = new Tone.Gain(effects.gain).connect(output);
  const reverbs = await createDualReverb(gain);

  // Apply reverb settings (mirrors applyDualReverb but inline to avoid import cycle)
  const wet = clamp(effects.reverbWet, EFFECTS_LIMITS.reverbWet.min, EFFECTS_LIMITS.reverbWet.max);
  reverbs.algorithmic.decay = Math.max(EFFECTS_LIMITS.reverbDecay.engineMin, effects.reverbDecay);
  reverbs.algorithmic.wet.value = wet;
  reverbs.algorithmicOut.gain.value = 1;
  reverbs.convDry.gain.value = 0;
  reverbs.convWet.gain.value = 0;

  // Spring reverb (Big Knob) — parallel from gain to output
  const bigWet = clamp(effects.bigKnobWet ?? 0, 0, 1);
  if (bigWet > 0) {
    const sampleRate = Tone.getContext().sampleRate;
    const springIR = synthesizeSpringImpulse(sampleRate);
    const springConvolver = Tone.getContext().rawContext.createConvolver();
    springConvolver.normalize = false;
    springConvolver.buffer = springIR;
    const springLp = Tone.getContext().rawContext.createBiquadFilter();
    springLp.type = "lowpass";
    springLp.frequency.value = 3200;
    springLp.Q.value = 0.5;
    const springWet = new Tone.Gain(bigWet).connect(output);
    gain.connect(springConvolver);
    springConvolver.connect(springLp);
    springLp.connect(springWet.input);
  }

  // TapeDelay (Space Echo) — LFO runs natively in Tone.Offline so wow bakes in
  const delay = new TapeDelay(reverbs.algorithmic, {
    delayTime: clamp(effects.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max),
    feedback: clamp(effects.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max),
    wet: clamp(effects.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max),
  });
  delay.connect(reverbs.convInput);
  delay.connect(reverbs.convDry);
  delay.setWow(clamp(effects.spaceEchoWow ?? 0, 0, 1));

  const bassShelf = new Tone.Filter({ type: "lowshelf", frequency: 200, gain: effects.bassBoost }).connect(delay.input);
  const bassSubFilter = new Tone.Filter({ type: "lowpass", frequency: 120, rolloff: -24 });
  const bassSubDist = new Tone.Distortion({ distortion: 0.3, wet: 1 });
  const bassSubGain = new Tone.Gain(Math.max(0, effects.bassBoost) / 20 * 0.4);
  bassSubFilter.connect(bassSubDist);
  bassSubDist.connect(bassSubGain);
  bassSubGain.connect(delay.input);
  const bassInput = new Tone.Gain(1);
  bassInput.connect(bassShelf);
  bassInput.connect(bassSubFilter);

  const chorusOff = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: clamp(effects.chorusWet ?? 0, 0, 1) }).connect(bassInput);
  chorusOff.start();
  const phaserOff = new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: clamp(effects.phaserWet ?? 0, 0, 1) }).connect(chorusOff);
  const eqHiOff = new Tone.Filter({ type: "highshelf", frequency: 6000, gain: clamp(effects.eqHigh ?? 0, EFFECTS_LIMITS.eqHigh.min, EFFECTS_LIMITS.eqHigh.max) }).connect(phaserOff);
  const eqMidOff = new Tone.Filter({ type: "peaking", frequency: 1000, Q: 1.0, gain: clamp(effects.eqMid ?? 0, EFFECTS_LIMITS.eqMid.min, EFFECTS_LIMITS.eqMid.max) }).connect(eqHiOff);
  const eqLoOff = new Tone.Filter({ type: "lowshelf", frequency: 100, gain: clamp(effects.eqLow ?? 0, EFFECTS_LIMITS.eqLow.min, EFFECTS_LIMITS.eqLow.max) }).connect(eqMidOff);

  const grit = clamp(effects.grit ?? 0, 0, 1);
  return new Tone.Distortion({ distortion: Math.pow(grit, 0.5), wet: grit }).connect(eqLoOff);
}

export function applyCollabEffectsChain(chain: CollabEffectsChain, e: EffectsState): void {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  chain.gain.gain.value = e.gain;
  applyDualReverb(chain.reverbs, e);
  chain.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
  chain.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
  chain.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
  chain.delay.setWow(clamp(e.spaceEchoWow ?? 0, 0, 1));
  chain.eqLo.gain.value = clamp(e.eqLow ?? 0, EFFECTS_LIMITS.eqLow.min, EFFECTS_LIMITS.eqLow.max);
  chain.eqMid.gain.value = clamp(e.eqMid ?? 0, EFFECTS_LIMITS.eqMid.min, EFFECTS_LIMITS.eqMid.max);
  chain.eqHi.gain.value = clamp(e.eqHigh ?? 0, EFFECTS_LIMITS.eqHigh.min, EFFECTS_LIMITS.eqHigh.max);
  chain.phaser.wet.value = clamp(e.phaserWet ?? 0, 0, 1);
  chain.chorus.wet.value = clamp(e.chorusWet ?? 0, 0, 1);
  applyBassBoost(chain.bass, e.bassBoost);
  const grit = clamp(e.grit ?? 0, 0, 1);
  chain.distortion.wet.value = grit;
  chain.distortion.distortion = Math.pow(grit, 0.5);
}
