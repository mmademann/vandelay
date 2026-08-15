import * as Tone from "tone";

// Request a larger OS audio buffer and longer look-ahead to reduce CPU-overload glitches.
// Must run before any Tone nodes are created (module-level).
Tone.setContext(new Tone.Context({ latencyHint: "playback", lookAhead: 0.3, updateInterval: 0.08 }));

import { disposeDualReverb, synthesizeSpringImpulse } from "./reverbSlot";
import { createMultiEffectsChain, applyMultiEffectsChain, type MultiEffectsChain } from "./multiChain";
import type { MultiSlot, MultiMasterSettings, ThrowSettings } from "../lib/multiSettings";
import { DEFAULT_THROW_SETTINGS } from "../lib/multiSettings";

function slotPlaybackRate(slot: MultiSlot): number {
  return slot.linkPitch ? slot.speed : slot.speed * Math.pow(2, slot.pitch / 12);
}

interface RuntimeSlot extends MultiSlot {
  player: Tone.Player;
  chain: MultiEffectsChain;
  volume: Tone.Volume;
  // Spring reverb (Big Knob)
  springConvolver: ConvolverNode;
  springWet: Tone.Gain;
  // Throw parallel send
  throwSend: Tone.Gain;
  throwFilter: Tone.Filter;
  throwDelay: Tone.FeedbackDelay;
  throwReverb: Tone.Reverb;
  throwActive: boolean;
  throwTimer: ReturnType<typeof setTimeout> | null;
  // Independent playback tracking
  startedAt: number;
  startOffset: number;
  playing: boolean;
}

class MultiEngine {
  private slots = new Map<string, RuntimeSlot>();
  private master: Tone.Volume | null = null;
  private masterSettings: MultiMasterSettings = {
    gain: 0,
    loopLengthOverride: null,
    throwSettings: { ...DEFAULT_THROW_SETTINGS },
  };
  private running = false;
  private throwDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

  isRunning() { return this.running || Array.from(this.slots.values()).some((s) => s.playing); }

  getMasterLoopLength(): number | null {
    if (this.masterSettings.loopLengthOverride != null) {
      return this.masterSettings.loopLengthOverride;
    }
    let max: number | null = null;
    for (const slot of this.slots.values()) {
      const len = (slot.loopEnd - slot.loopStart) / slotPlaybackRate(slot);
      if (max === null || len > max) max = len;
    }
    return max;
  }

  async addSlot(slot: MultiSlot, buffer: AudioBuffer): Promise<void> {
    if (this.slots.has(slot.id)) return;

    if (!this.master) {
      this.master = new Tone.Volume(this.masterSettings.gain).toDestination();
    }

    const volume = new Tone.Volume(slot.gain).connect(this.master);
    const chain = await createMultiEffectsChain(volume);

    // Spring reverb (Big Knob) — taps from volume output
    const sampleRate = Tone.getContext().sampleRate;
    const springIR = synthesizeSpringImpulse(sampleRate);
    const springConvolver = Tone.getContext().rawContext.createConvolver();
    springConvolver.normalize = false;
    springConvolver.buffer = springIR;
    const springLp = Tone.getContext().rawContext.createBiquadFilter();
    springLp.type = "lowpass";
    springLp.frequency.value = 3200;
    springLp.Q.value = 0.5;
    const springWet = new Tone.Gain(0).connect(this.master);
    volume.connect(springConvolver);
    springConvolver.connect(springLp);
    springLp.connect(springWet.input);

    // Throw parallel send — gate at INPUT so echoes blast in and ring out naturally.
    // signal path: volume → throwSend (gate) → throwFilter (env sweep) → throwDelay → throwReverb → master
    const ts = this.masterSettings.throwSettings;
    const throwReverb = new Tone.Reverb({ decay: ts.reverbDecay, wet: ts.reverbWet }).connect(this.master);
    await throwReverb.generate();
    const throwDelay = new Tone.FeedbackDelay({
      delayTime: ts.delayTime,
      feedback: ts.delayFeedback,
      wet: ts.delayWet,
      maxDelay: 5,
    }).connect(throwReverb);
    const throwFilter = new Tone.Filter({
      type: "lowpass",
      frequency: ts.filterFreq,
      rolloff: -24,
      Q: ts.filterSweep * 18,
    }).connect(throwDelay);
    const throwSend = new Tone.Gain(0).connect(throwFilter);
    volume.connect(throwSend);

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);
    const bufDur = buffer.duration;

    const safeLoopStart = Math.max(0, Math.min(slot.loopStart, bufDur - 0.01));
    const safeLoopEnd = Math.min(bufDur, slot.loopEnd > 0 ? slot.loopEnd : bufDur);

    const player = new Tone.Player(toneBuffer).connect(chain.distortion);
    player.loop = true;
    player.loopStart = safeLoopStart;
    player.loopEnd = safeLoopEnd;
    player.playbackRate = slotPlaybackRate(slot);

    applyMultiEffectsChain(chain, slot.effects);
    springWet.gain.value = slot.effects.bigKnobWet ?? 0;
    const runtime: RuntimeSlot = {
      ...slot,
      loopStart: safeLoopStart,
      loopEnd: safeLoopEnd,
      player,
      chain,
      volume,
      springConvolver,
      springWet,
      throwSend,
      throwFilter,
      throwDelay,
      throwReverb,
      throwActive: false,
      throwTimer: null,
      startedAt: 0,
      startOffset: safeLoopStart,
      playing: false,
    };
    this.slots.set(slot.id, runtime);
    this.recomputeAllVolumes();

    if (this.running) {
      const t = Tone.now() + 0.05;
      player.start(t, slot.loopStart);
      runtime.startedAt = t;
      runtime.startOffset = slot.loopStart;
      runtime.playing = true;
    }
  }

  removeSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.throwTimer) clearTimeout(slot.throwTimer);
    try { slot.player.stop(); } catch { /* already stopped */ }
    slot.player.disconnect();
    slot.player.dispose();
    slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
    slot.chain.eqLo.disconnect(); slot.chain.eqLo.dispose();
    slot.chain.eqMid.disconnect(); slot.chain.eqMid.dispose();
    slot.chain.eqHi.disconnect(); slot.chain.eqHi.dispose();
    slot.chain.phaser.disconnect(); slot.chain.phaser.dispose();
    slot.chain.chorus.disconnect(); slot.chain.chorus.dispose();
    slot.chain.bass.input.disconnect(); slot.chain.bass.input.dispose();
    slot.chain.bass.bassShelf.disconnect(); slot.chain.bass.bassShelf.dispose();
    slot.chain.bass.bassSubFilter.disconnect(); slot.chain.bass.bassSubFilter.dispose();
    slot.chain.bass.bassSubDist.disconnect(); slot.chain.bass.bassSubDist.dispose();
    slot.chain.bass.bassSubGain.disconnect(); slot.chain.bass.bassSubGain.dispose();
    slot.chain.delay.dispose();
    disposeDualReverb(slot.chain.reverbs);
    slot.chain.gain.disconnect(); slot.chain.gain.dispose();
    try { slot.springConvolver.disconnect(); } catch { /* ignore */ }
    slot.springWet.disconnect(); slot.springWet.dispose();
    slot.throwReverb.disconnect(); slot.throwReverb.dispose();
    slot.throwDelay.disconnect(); slot.throwDelay.dispose();
    slot.throwFilter.disconnect(); slot.throwFilter.dispose();
    slot.throwSend.disconnect(); slot.throwSend.dispose();
    slot.volume.disconnect(); slot.volume.dispose();
    this.slots.delete(id);
    this.recomputeAllVolumes();
  }

  updateSlot(id: string, patch: Partial<MultiSlot>): void {
    const slot = this.slots.get(id);
    if (!slot) return;

    Object.assign(slot, patch);

    if (patch.pitch !== undefined || patch.speed !== undefined || patch.linkPitch !== undefined) {
      if (slot.playing) {
        const pos = this.getSlotPosition(id);
        slot.player.playbackRate = slotPlaybackRate(slot);
        slot.startOffset = pos;
        slot.startedAt = Tone.now();
      } else {
        slot.player.playbackRate = slotPlaybackRate(slot);
      }
    }
    if (patch.loopStart !== undefined || patch.loopEnd !== undefined) {
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      if (slot.playing) {
        const pos = this.getSlotPosition(id);
        slot.startOffset = pos;
        slot.startedAt = Tone.now();
      }
    }
    if (patch.gain !== undefined || patch.muted !== undefined || patch.soloed !== undefined) {
      this.recomputeAllVolumes();
      // play() skips silent slots, so a slot un-silenced mid-session has to start itself.
      // Solo changes can un-silence any slot, not just this one, so sweep them all.
      if (this.running && (patch.muted !== undefined || patch.soloed !== undefined)) {
        this.startSilencedSlots();
      }
    }
    if (patch.effects !== undefined) {
      applyMultiEffectsChain(slot.chain, slot.effects);
      slot.springWet.gain.value = slot.effects.bigKnobWet ?? 0;
    }
  }

  getSlotPosition(id: string): number {
    const slot = this.slots.get(id);
    if (!slot) return 0;
    if (!slot.playing) return slot.startOffset;
    const elapsed = Math.max(0, Tone.now() - slot.startedAt) * slotPlaybackRate(slot);
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return slot.startOffset;
    const clampedOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd, slot.startOffset));
    const offsetInLoop = clampedOffset - slot.loopStart;
    return slot.loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur;
  }

  seekSlot(id: string, time: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const clamped = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, time));
    slot.startOffset = clamped;
    if (slot.playing) {
      const now = Tone.now();
      slot.player.seek(clamped, now);
      slot.startedAt = now;
    }
  }

  isSlotPlaying(id: string): boolean {
    return this.slots.get(id)?.playing ?? false;
  }

  isThrowActive(id: string): boolean {
    return this.slots.get(id)?.throwActive ?? false;
  }

  throwSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.throwTimer) clearTimeout(slot.throwTimer);
    const ts = this.masterSettings.throwSettings;
    const now = Tone.now();
    // Gate open
    slot.throwSend.gain.cancelScheduledValues(now);
    slot.throwSend.gain.rampTo(1, 0.02);
    // Filter env: jump to peak then sweep down to resting freq
    const peakFreq = Math.min(16000, ts.filterFreq * 10);
    slot.throwFilter.frequency.cancelScheduledValues(now);
    slot.throwFilter.frequency.setValueAtTime(peakFreq, now);
    slot.throwFilter.frequency.exponentialRampToValueAtTime(ts.filterFreq, now + 0.8);
    slot.throwActive = true;
    slot.throwTimer = setTimeout(() => {
      slot.throwSend.gain.rampTo(0, 0.05);
      slot.throwActive = false;
      slot.throwTimer = null;
    }, 400);
  }

  setThrowSettings(settings: ThrowSettings): void {
    this.masterSettings = { ...this.masterSettings, throwSettings: settings };
    if (this.throwDebounceTimer) clearTimeout(this.throwDebounceTimer);
    for (const slot of this.slots.values()) {
      slot.throwDelay.delayTime.value = settings.delayTime;
      slot.throwDelay.feedback.value = settings.delayFeedback;
      slot.throwDelay.wet.value = settings.delayWet;
      slot.throwReverb.wet.value = settings.reverbWet;
      slot.throwFilter.frequency.value = settings.filterFreq;
      slot.throwFilter.Q.value = settings.filterSweep * 18;
    }
    // Debounce reverb IR regeneration (expensive)
    this.throwDebounceTimer = setTimeout(async () => {
      if (this._disposed) return;
      for (const [id, slot] of this.slots.entries()) {
        if (!this.slots.has(id)) continue;
        slot.throwReverb.decay = settings.reverbDecay;
        await slot.throwReverb.generate();
      }
      this.throwDebounceTimer = null;
    }, 300);
  }

  async playSlot(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await Tone.start();
    await Tone.getContext().resume();
    try { slot.player.stop(); } catch { /* ignore */ }
    slot.player.loopStart = slot.loopStart;
    slot.player.loopEnd = slot.loopEnd;
    slot.player.loop = true;
    slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
    const t = Tone.now() + 0.05;
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
    if (!effectiveMute) {
      slot.volume.volume.cancelScheduledValues(t);
      slot.volume.volume.setValueAtTime(-60, t);
      slot.volume.volume.linearRampToValueAtTime(slot.gain, t + 5);
    }
    slot.player.start(t, slot.startOffset);
    slot.startedAt = t;
    slot.playing = true;
  }

  stopSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.startOffset = this.getSlotPosition(id);
    const now = Tone.now();
    slot.volume.volume.cancelScheduledValues(now);
    slot.volume.volume.setValueAtTime(slot.volume.volume.value, now);
    slot.volume.volume.linearRampToValueAtTime(-60, now + 5);
    try { slot.player.stop(now + 5); } catch { /* ignore */ }
    slot.playing = false;
  }

  getSlot(id: string): MultiSlot | null {
    const slot = this.slots.get(id);
    if (!slot) return null;
    const { player: _p, chain: _c, volume: _v, springConvolver: _sc, springWet: _sw,
            throwSend: _ts, throwFilter: _tf, throwDelay: _td, throwReverb: _tr,
            throwActive: _ta, throwTimer: _tt,
            startedAt: _s, startOffset: _o, playing: _pl, ...data } = slot;
    return data;
  }

  getAllSlots(): MultiSlot[] {
    return Array.from(this.slots.values()).map(
      ({ player: _p, chain: _c, volume: _v, springConvolver: _sc, springWet: _sw,
         throwSend: _ts, throwFilter: _tf, throwDelay: _td, throwReverb: _tr,
         throwActive: _ta, throwTimer: _tt,
         startedAt: _s, startOffset: _o, playing: _pl, ...data }) => data
    );
  }

  setMasterSettings(s: MultiMasterSettings): void {
    this.masterSettings = s;
    if (this.master) {
      this.master.volume.value = s.gain;
    }
  }

  async play(): Promise<void> {
    await Tone.start();
    await Tone.getContext().resume();
    this.running = true;

    if (this.slots.size === 0) return;

    const t = Tone.now() + 0.05;
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);

    for (const slot of this.slots.values()) {
      if (slot.playing) continue;
      // Silent slots stay stopped — unmuting during playback starts them (see updateSlot).
      if (slot.muted || (anySoloed && !slot.soloed)) continue;
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      slot.player.loop = true;
      slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
      slot.player.start(t, slot.startOffset);
      slot.startedAt = t;
      slot.playing = true;
    }
  }

  stop(): void {
    for (const slot of this.slots.values()) {
      if (!slot.playing) continue;
      slot.startOffset = this.getSlotPosition(slot.id);
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.playing = false;
    }
    this.running = false;
  }

  dispose(): void {
    this._disposed = true;
    if (this.throwDebounceTimer) clearTimeout(this.throwDebounceTimer);
    this.stop();
    for (const slot of this.slots.values()) {
      if (slot.throwTimer) clearTimeout(slot.throwTimer);
      slot.player.disconnect();
      slot.player.dispose();
      slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
      slot.chain.eqLo.disconnect(); slot.chain.eqLo.dispose();
      slot.chain.eqMid.disconnect(); slot.chain.eqMid.dispose();
      slot.chain.eqHi.disconnect(); slot.chain.eqHi.dispose();
      slot.chain.phaser.disconnect(); slot.chain.phaser.dispose();
      slot.chain.chorus.disconnect(); slot.chain.chorus.dispose();
      slot.chain.bass.input.disconnect(); slot.chain.bass.input.dispose();
      slot.chain.bass.bassShelf.disconnect(); slot.chain.bass.bassShelf.dispose();
      slot.chain.bass.bassSubFilter.disconnect(); slot.chain.bass.bassSubFilter.dispose();
      slot.chain.bass.bassSubDist.disconnect(); slot.chain.bass.bassSubDist.dispose();
      slot.chain.bass.bassSubGain.disconnect(); slot.chain.bass.bassSubGain.dispose();
      slot.chain.delay.dispose();
      disposeDualReverb(slot.chain.reverbs);
      slot.chain.gain.disconnect(); slot.chain.gain.dispose();
      try { slot.springConvolver.disconnect(); } catch { /* ignore */ }
      slot.springWet.disconnect(); slot.springWet.dispose();
      slot.throwReverb.disconnect(); slot.throwReverb.dispose();
      slot.throwDelay.disconnect(); slot.throwDelay.dispose();
      slot.throwFilter.disconnect(); slot.throwFilter.dispose();
      slot.throwSend.disconnect(); slot.throwSend.dispose();
      slot.volume.disconnect(); slot.volume.dispose();
    }
    this.slots.clear();
    if (this.master) { this.master.disconnect(); this.master.dispose(); this.master = null; }
    this.running = false;
  }

  /**
   * Start any slot that is now audible but still stopped. Each resumes from its own
   * startOffset — where it was parked — rather than being seeked to match other slots.
   * Loops are independent lengths, so there is no shared position to align to.
   */
  private startSilencedSlots(): void {
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    const t = Tone.now() + 0.05;
    for (const slot of this.slots.values()) {
      if (slot.playing) continue;
      if (slot.muted || (anySoloed && !slot.soloed)) continue;
      if (slot.loopEnd - slot.loopStart <= 0) continue;
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      slot.player.loop = true;
      slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
      // Match playSlot's fade-in — recomputeAllVolumes has already jumped this to full gain.
      slot.volume.volume.cancelScheduledValues(t);
      slot.volume.volume.setValueAtTime(-60, t);
      slot.volume.volume.linearRampToValueAtTime(slot.gain, t + 5);
      slot.player.start(t, slot.startOffset);
      slot.startedAt = t;
      slot.playing = true;
    }
  }

  private recomputeAllVolumes(): void {
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    for (const slot of this.slots.values()) {
      const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
      slot.volume.volume.value = effectiveMute ? -Infinity : slot.gain;
    }
  }
}

export const multiEngine = new MultiEngine();
