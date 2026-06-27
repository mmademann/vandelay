import * as Tone from "tone";
import { createEffectsChain, type EffectsChain } from "./graph";
import { applyDualReverb, disposeDualReverb } from "./reverbSlot";
import { EFFECTS_LIMITS, type EffectsState } from "../store";

export type StemName = "drums" | "bass" | "vocals" | "other";
export const STEM_NAMES: StemName[] = ["drums", "bass", "vocals", "other"];

export const DUB_TECHNO_EFFECTS: EffectsState = {
  speed: 1,
  pitch: 0,
  linkPitch: true,
  reverbType: "algorithmic",
  reverbDecay: 7,
  reverbWet: 0.65,
  delayTime: 0.375,
  delayFeedback: 0.55,
  delayWet: 0.45,
  bassBoost: 4,
  gain: 1,
};

export const DRY_EFFECTS: EffectsState = {
  speed: 1,
  pitch: 0,
  linkPitch: true,
  reverbType: "algorithmic",
  reverbDecay: 0.1,
  reverbWet: 0,
  delayTime: 0,
  delayFeedback: 0,
  delayWet: 0,
  bassBoost: 0,
  gain: 1,
};

interface StemTrack {
  player: Tone.Player;
  chain: EffectsChain;
  volume: Tone.Volume;
  muted: boolean;
  soloed: boolean;
  gainDb: number;
  effects: EffectsState;
}

class DubEngine {
  private stems: Partial<Record<StemName, StemTrack>> = {};
  private master: Tone.Volume | null = null;
  private running = false;
  private loopEnabled = false;
  private loopStart = 0;
  private loopEnd = 0;

  isRunning() { return this.running; }
  isLoaded() { return STEM_NAMES.every((s) => this.stems[s] != null); }

  async load(buffers: Record<StemName, AudioBuffer>) {
    this.dispose();
    this.master = new Tone.Volume(0).toDestination();

    for (const name of STEM_NAMES) {
      const buf = buffers[name];
      const volume = new Tone.Volume(0).connect(this.master);
      const chain = await createEffectsChain(volume);

      const channels: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
      const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

      const player = new Tone.Player(toneBuffer).connect(chain.eq);
      player.loop = false;

      this.applyEffectsToChain(chain, DRY_EFFECTS);
      this.stems[name] = { player, chain, volume, muted: false, soloed: false, gainDb: 0, effects: { ...DRY_EFFECTS } };
    }
  }

  setLoop(start: number, end: number, enabled: boolean) {
    this.loopStart = start;
    this.loopEnd = end;
    this.loopEnabled = enabled;
  }

  async play(offset = 0) {
    if (!this.isLoaded()) return;
    await Tone.start();
    await Tone.getContext().resume();

    const t = Tone.now();
    const transport = Tone.getTransport();

    // Disable loop before stopping to cancel any pending loop-restart events in the scheduler
    transport.loop = false;
    transport.stop(t);
    for (const name of STEM_NAMES) {
      const s = this.stems[name];
      if (s) {
        try { s.player.stop(t); } catch { /* already stopped */ }
        s.player.unsync();
      }
    }

    if (this.loopEnabled && this.loopEnd > this.loopStart) {
      const loopDur = this.loopEnd - this.loopStart;
      const startInLoop = Math.max(0, Math.min(loopDur - 0.01, offset - this.loopStart));
      transport.loop = true;
      transport.loopStart = 0;
      transport.loopEnd = loopDur;
      transport.seconds = startInLoop;
      for (const name of STEM_NAMES) {
        this.stems[name]!.player.sync().start(0, this.loopStart);
      }
    } else {
      transport.seconds = 0;
      for (const name of STEM_NAMES) {
        this.stems[name]!.player.sync().start(0, offset);
      }
    }

    // 50ms gap (same as single engine) ensures stop clears the audio pipeline before new audio starts
    transport.start(t + 0.05);
    this.running = true;
  }

  stop() {
    for (const name of STEM_NAMES) {
      const s = this.stems[name];
      if (s) { s.player.unsync(); s.player.stop(); }
    }
    Tone.getTransport().stop();
    this.running = false;
  }

  setSpeed(rate: number) {
    for (const name of STEM_NAMES) {
      const s = this.stems[name];
      if (s) s.player.playbackRate = rate;
    }
  }

  setMute(stem: StemName, muted: boolean) {
    const s = this.stems[stem];
    if (!s) return;
    s.muted = muted;
    this.updateVolume(stem);
  }

  setSolo(stem: StemName, soloed: boolean) {
    const s = this.stems[stem];
    if (!s) return;
    s.soloed = soloed;
    // Recompute all stems: if any soloed, non-soloed stems are silenced
    for (const name of STEM_NAMES) this.updateVolume(name);
  }

  setGain(stem: StemName, db: number) {
    const s = this.stems[stem];
    if (!s) return;
    s.gainDb = db;
    this.updateVolume(stem);
  }

  private updateVolume(stem: StemName) {
    const s = this.stems[stem];
    if (!s) return;
    const anySoloed = STEM_NAMES.some((n) => this.stems[n]?.soloed);
    const effectiveMute = s.muted || (anySoloed && !s.soloed);
    s.volume.volume.value = effectiveMute ? -Infinity : s.gainDb;
  }

  setEffects(stem: StemName, effects: EffectsState) {
    const s = this.stems[stem];
    if (!s) return;
    s.effects = effects;
    this.applyEffectsToChain(s.chain, effects);
  }

  getEffects(stem: StemName): EffectsState | null {
    return this.stems[stem]?.effects ?? null;
  }

  private applyEffectsToChain(chain: EffectsChain, e: EffectsState) {
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    chain.gain.gain.value = e.gain;
    applyDualReverb(chain.reverbs, e);
    chain.eq.low.value = e.bassBoost;
    chain.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
    chain.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
    chain.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
  }

  dispose() {
    this.stop();
    for (const name of STEM_NAMES) {
      const s = this.stems[name];
      if (!s) continue;
      s.player.disconnect();
      s.player.dispose();
      s.chain.eq.disconnect(); s.chain.eq.dispose();
      s.chain.delay.disconnect(); s.chain.delay.dispose();
      disposeDualReverb(s.chain.reverbs);
      s.chain.gain.disconnect(); s.chain.gain.dispose();
      s.volume.disconnect(); s.volume.dispose();
    }
    this.stems = {};
    if (this.master) { this.master.disconnect(); this.master.dispose(); this.master = null; }
    this.running = false;
    this.loopEnabled = false;
    Tone.getTransport().loop = false;
  }
}

export const dubEngine = new DubEngine();
