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

/**
 * Grit drive, in dB at the top of the knob, and how much of it is given back afterwards.
 *
 * The knob used to only widen the clipping curve, which saturates around 60% and then stops
 * getting nastier. Dirt comes from how hard the signal hits the shaper, so Grit now also
 * drives it. Makeup is deliberately partial: the shaper bounds its own output, so handing
 * back the full 18dB would make the slot quieter the dirtier it got.
 *
 * Tuned by ear — this is the pair to move if the top of the knob is too much or too little.
 */
const GRIT_DRIVE_DB = 18;
const GRIT_MAKEUP_DB = 9;

export interface MultiEffectsChain {
  /** Pre-distortion boost — the chain's input node, so the player connects HERE. */
  drive: Tone.Gain;
  distortion: Tone.Distortion;
  /** Gives back part of the drive so Grit changes character more than loudness. */
  makeup: Tone.Gain;
  eqLo: Tone.Filter;
  eqMid: Tone.Filter;
  eqHi: Tone.Filter;
  phaser: Tone.Phaser;
  chorus: Tone.Chorus;
  /** Sweepable resonant lowpass, pre-delay so the echoes inherit the sweep. */
  filter: Tone.Filter;
  bass: BassChain;
  delay: TapeDelay;
  reverbs: DualReverbNodes;
  gain: Tone.Gain;
  /**
   * Dry path around the reverb, so the reverb can be removed from the graph when unused.
   *
   * Web Audio renders every node reachable from the destination, so a reverb at 0% wet costs
   * exactly as much as one at 100% — a 10s decay is the single most expensive node in the
   * chain, and five slots of it is what silenced the rack. It cannot simply be disconnected:
   * `Tone.Reverb` at wet 0 passes the dry signal, so that branch is also the slot's only path
   * to the master. This carries the dry signal instead while the reverb is out.
   */
  reverbBypass: Tone.Gain;
  /** Whether the reverb branch is currently wired in. */
  reverbLive: boolean;
}

export async function createMultiEffectsChain(output: Tone.ToneAudioNode): Promise<MultiEffectsChain> {
  const gain = new Tone.Gain(1).connect(output);
  const reverbs = await createDualReverb(gain);
  const delay = new TapeDelay(reverbs.algorithmic, { delayTime: 0.25, feedback: 0.3, wet: 0 });
  // Also wire delay wet signal to convolution reverb + convDry (mirrors wireDelayToReverbs)
  delay.connect(reverbs.convInput);
  delay.connect(reverbs.convDry);
  // Silent until the reverb is bypassed; see MultiEffectsChain.reverbBypass.
  const reverbBypass = new Tone.Gain(0).connect(gain);
  delay.connect(reverbBypass);
  const bass = await createBassChain(delay.input);
  // Pre-delay, for the same reason the EQ is: an echo of a filtered signal is the dub sound,
  // and filtering the delay's output instead would dull the repeats uniformly rather than
  // letting them carry the sweep that was played into them.
  const filter = new Tone.Filter({ type: "lowpass", frequency: 20000, Q: 0.5 }).connect(bass.input);
  const chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 }).connect(filter);
  chorus.start();
  const phaser = new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: 0 }).connect(chorus);
  const eqHi = new Tone.Filter({ type: "highshelf", frequency: 6000, gain: 0 }).connect(phaser);
  const eqMid = new Tone.Filter({ type: "peaking", frequency: 1000, Q: 1.0, gain: 0 }).connect(eqHi);
  const eqLo = new Tone.Filter({ type: "lowshelf", frequency: 100, gain: 0 }).connect(eqMid);
  const makeup = new Tone.Gain(1).connect(eqLo);
  const distortion = new Tone.Distortion({ distortion: 0.5, wet: 0 }).connect(makeup);
  // Input of the whole chain. Invariant 12 put the distortion first so grit hits the raw
  // stem; the drive sits in front of it for the same reason.
  const drive = new Tone.Gain(1).connect(distortion);
  return { drive, distortion, makeup, eqLo, eqMid, eqHi, phaser, chorus, filter, bass, delay, reverbs, gain, reverbBypass, reverbLive: true };
}

/** Returns the chain's INPUT node — the grit drive, which feeds the shaper. */
export async function createOfflineMultiEqChain(
  effects: EffectsState,
  output: Tone.ToneAudioNode,
): Promise<Tone.ToneAudioNode> {
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

  const filterOff = new Tone.Filter({
    type: "lowpass",
    frequency: clamp(effects.sweepFreq ?? EFFECTS_LIMITS.sweepFreq.max, EFFECTS_LIMITS.sweepFreq.min, EFFECTS_LIMITS.sweepFreq.max),
    Q: clamp(effects.sweepRes ?? EFFECTS_LIMITS.sweepRes.min, EFFECTS_LIMITS.sweepRes.min, EFFECTS_LIMITS.sweepRes.max),
  }).connect(bassInput);
  const chorusOff = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: clamp(effects.chorusWet ?? 0, 0, 1) }).connect(filterOff);
  chorusOff.start();
  const phaserOff = new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: clamp(effects.phaserWet ?? 0, 0, 1) }).connect(chorusOff);
  const eqHiOff = new Tone.Filter({ type: "highshelf", frequency: 6000, gain: clamp(effects.eqHigh ?? 0, EFFECTS_LIMITS.eqHigh.min, EFFECTS_LIMITS.eqHigh.max) }).connect(phaserOff);
  const eqMidOff = new Tone.Filter({ type: "peaking", frequency: 1000, Q: 1.0, gain: clamp(effects.eqMid ?? 0, EFFECTS_LIMITS.eqMid.min, EFFECTS_LIMITS.eqMid.max) }).connect(eqHiOff);
  const eqLoOff = new Tone.Filter({ type: "lowshelf", frequency: 100, gain: clamp(effects.eqLow ?? 0, EFFECTS_LIMITS.eqLow.min, EFFECTS_LIMITS.eqLow.max) }).connect(eqMidOff);

  const grit = clamp(effects.grit ?? 0, 0, 1);
  const makeupOff = new Tone.Gain(Tone.dbToGain(-GRIT_MAKEUP_DB * grit)).connect(eqLoOff);
  const distOff = new Tone.Distortion({ distortion: Math.pow(grit, 0.5), wet: grit }).connect(makeupOff);
  // Returned as the chain input, so the offline player feeds the drive exactly like live.
  return new Tone.Gain(Tone.dbToGain(GRIT_DRIVE_DB * grit)).connect(distOff);
}

export function applyMultiEffectsChain(chain: MultiEffectsChain, e: EffectsState): void {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  chain.gain.gain.value = e.gain;
  applyDualReverb(chain.reverbs, e);

  // Swap the reverb for a plain dry path when it is contributing nothing. Both sides carry
  // the same signal at unity, so the crossover is silent; what changes is that an unused
  // convolver stops being rendered. Any tail still ringing is cut at the moment of switching,
  // which is why this only triggers at exactly 0 — the point where there is no tail.
  const reverbNeeded = e.reverbWet > 0;
  if (reverbNeeded !== chain.reverbLive) {
    if (reverbNeeded) {
      chain.reverbBypass.gain.value = 0;
      chain.reverbs.algorithmicOut.connect(chain.gain);
      chain.reverbs.convWet.connect(chain.gain);
      chain.reverbs.convDry.connect(chain.gain);
    } else {
      chain.reverbBypass.gain.value = 1;
      chain.reverbs.algorithmicOut.disconnect(chain.gain);
      chain.reverbs.convWet.disconnect(chain.gain);
      chain.reverbs.convDry.disconnect(chain.gain);
    }
    chain.reverbLive = reverbNeeded;
  }
  chain.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
  chain.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
  chain.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
  chain.delay.setWow(clamp(e.spaceEchoWow ?? 0, 0, 1));
  chain.eqLo.gain.value = clamp(e.eqLow ?? 0, EFFECTS_LIMITS.eqLow.min, EFFECTS_LIMITS.eqLow.max);
  chain.eqMid.gain.value = clamp(e.eqMid ?? 0, EFFECTS_LIMITS.eqMid.min, EFFECTS_LIMITS.eqMid.max);
  chain.eqHi.gain.value = clamp(e.eqHigh ?? 0, EFFECTS_LIMITS.eqHigh.min, EFFECTS_LIMITS.eqHigh.max);
  chain.filter.frequency.value = clamp(e.sweepFreq ?? EFFECTS_LIMITS.sweepFreq.max, EFFECTS_LIMITS.sweepFreq.min, EFFECTS_LIMITS.sweepFreq.max);
  chain.filter.Q.value = clamp(e.sweepRes ?? EFFECTS_LIMITS.sweepRes.min, EFFECTS_LIMITS.sweepRes.min, EFFECTS_LIMITS.sweepRes.max);
  chain.phaser.wet.value = clamp(e.phaserWet ?? 0, 0, 1);
  chain.chorus.wet.value = clamp(e.chorusWet ?? 0, 0, 1);
  applyBassBoost(chain.bass, e.bassBoost);
  const grit = clamp(e.grit ?? 0, 0, 1);
  chain.distortion.wet.value = grit;
  chain.distortion.distortion = Math.pow(grit, 0.5);
  // Both are unity at grit 0, so a clean slot passes through untouched.
  chain.drive.gain.value = Tone.dbToGain(GRIT_DRIVE_DB * grit);
  chain.makeup.gain.value = Tone.dbToGain(-GRIT_MAKEUP_DB * grit);
}
