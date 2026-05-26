import * as Tone from "tone";
import { createEffectsChain, type EffectsChain } from "./graph";
import { applyDualReverb, disposeDualReverb } from "./reverbSlot";
import type { DrumTrackSettings } from "../lib/mixSettings";
import { EFFECTS_LIMITS, type EffectsState } from "../store";
import { mixEngine } from "./mixEngine";

class DrumEngine {
  private core: EffectsChain | null = null;
  private hatCore: EffectsChain | null = null;
  private volume: Tone.Volume | null = null;
  private kick: Tone.MembraneSynth | null = null;
  private hat: Tone.MetalSynth | null = null;
  private kickGain: Tone.Gain | null = null;
  private hatGain: Tone.Gain | null = null;
  private sequence: Tone.Sequence | null = null;
  private currentHatVolume = 0;
  private running = false;

  private async build(settings: DrumTrackSettings) {
    this.dispose();

    this.volume = new Tone.Volume(settings.volumeDb).connect(mixEngine.getMasterNode());
    this.core = await createEffectsChain(this.volume);
    this.hatCore = await createEffectsChain(this.volume);

    this.applyEffectsToCore(settings.effects);
    this.applyHatEffectsToCore(settings.hatEffects);

    this.kickGain = new Tone.Gain(settings.kickVolume).connect(this.core.eq);
    this.kick = new Tone.MembraneSynth({
      pitchDecay: settings.kickDecay * 0.3,
      octaves: settings.kickPunch,
      envelope: { attack: 0.001, decay: settings.kickDecay, sustain: 0, release: 0.5 },
    }).connect(this.kickGain);

    this.currentHatVolume = settings.hatVolume;
    this.hatGain = new Tone.Gain(settings.hatVolume).connect(this.hatCore.eq);
    this.hat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.1, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).connect(this.hatGain);
    this.hat.frequency.value = 400;

    const kick = this.kick;
    const hat = this.hat;
    const { kickTone, kickSteps, hatSteps } = settings;

    this.sequence = new Tone.Sequence(
      (time, step) => {
        if (kickSteps[step]) kick.triggerAttackRelease(kickTone, "8n", time);
        if (hatSteps[step] && this.currentHatVolume > 0) hat.triggerAttackRelease("16n", time);
      },
      Array.from({ length: 16 }, (_, i) => i),
      "16n",
    );

    Tone.getTransport().bpm.value = settings.bpm;
  }

  async start(settings: DrumTrackSettings) {
    if (settings.pattern === "off") return;
    await Tone.start();
    await Tone.getContext().resume();
    await this.build(settings);
    this.sequence?.start(0);
    if (Tone.getTransport().state !== "started") {
      Tone.getTransport().start();
    }
    this.running = true;
  }

  stop() {
    this.sequence?.stop();
    Tone.getTransport().stop();
    this.dispose();
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  updateSteps(settings: DrumTrackSettings) {
    if (!this.running || !this.kick || !this.hat) return;
    this.sequence?.stop();
    this.sequence?.dispose();

    const kick = this.kick;
    const hat = this.hat;
    const { kickTone, kickSteps, hatSteps } = settings;

    this.sequence = new Tone.Sequence(
      (time, step) => {
        if (kickSteps[step]) kick.triggerAttackRelease(kickTone, "8n", time);
        if (hatSteps[step] && this.currentHatVolume > 0) hat.triggerAttackRelease("16n", time);
      },
      Array.from({ length: 16 }, (_, i) => i),
      "16n",
    );
    this.sequence.start(0);
  }

  private applyEffectsToCore(e: EffectsState) {
    if (!this.core) return;
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    this.core.gain.gain.value = e.gain;
    applyDualReverb(this.core.reverbs, e);
    this.core.eq.low.value = e.bassBoost;
    this.core.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
    this.core.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
    this.core.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
  }

  private applyHatEffectsToCore(e: EffectsState) {
    if (!this.hatCore) return;
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    this.hatCore.gain.gain.value = e.gain;
    applyDualReverb(this.hatCore.reverbs, e);
    this.hatCore.eq.low.value = e.bassBoost;
    this.hatCore.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
    this.hatCore.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
    this.hatCore.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
  }

  applyEffects(e: EffectsState) {
    this.applyEffectsToCore(e);
  }

  applyHatEffects(e: EffectsState) {
    this.applyHatEffectsToCore(e);
  }

  updateVolumes(kickVolume: number, hatVolume: number) {
    if (this.kickGain) this.kickGain.gain.value = kickVolume;
    if (this.hatGain) this.hatGain.gain.value = hatVolume;
    this.currentHatVolume = hatVolume;
  }

  updateVolume(volumeDb: number, muted: boolean) {
    if (this.volume) this.volume.volume.value = muted ? -Infinity : volumeDb;
  }

  updateBpm(bpm: number) {
    Tone.getTransport().bpm.value = bpm;
  }

  updateKickDecay(decay: number) {
    if (!this.kick) return;
    this.kick.envelope.decay = decay;
    this.kick.pitchDecay = decay * 0.3;
  }

  updateKickPunch(octaves: number) {
    if (!this.kick) return;
    this.kick.octaves = octaves;
  }

  dispose() {
    this.sequence?.stop();
    this.sequence?.dispose();
    this.kick?.dispose();
    this.hat?.dispose();
    this.kickGain?.disconnect();
    this.kickGain?.dispose();
    this.hatGain?.disconnect();
    this.hatGain?.dispose();
    if (this.volume) { this.volume.disconnect(); this.volume.dispose(); this.volume = null; }
    if (this.core) {
      this.core.eq.disconnect();
      this.core.eq.dispose();
      this.core.delay.disconnect();
      this.core.delay.dispose();
      disposeDualReverb(this.core.reverbs);
      this.core.gain.disconnect();
      this.core.gain.dispose();
    }
    if (this.hatCore) {
      this.hatCore.eq.disconnect();
      this.hatCore.eq.dispose();
      this.hatCore.delay.disconnect();
      this.hatCore.delay.dispose();
      disposeDualReverb(this.hatCore.reverbs);
      this.hatCore.gain.disconnect();
      this.hatCore.gain.dispose();
    }
    this.sequence = null;
    this.kick = null;
    this.hat = null;
    this.kickGain = null;
    this.hatGain = null;
    this.core = null;
    this.hatCore = null;
  }
}

export const drumEngine = new DrumEngine();
