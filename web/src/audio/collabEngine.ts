import * as Tone from "tone";
import { createEffectsChain, type EffectsChain } from "./graph";
import { applyDualReverb, disposeDualReverb } from "./reverbSlot";
import { EFFECTS_LIMITS } from "../store";
import type { CollabSlot, CollabMasterSettings } from "../lib/collabSettings";

function slotPlaybackRate(slot: CollabSlot): number {
  return slot.linkPitch ? slot.speed : slot.speed * Math.pow(2, slot.pitch / 12);
}

interface RuntimeSlot extends CollabSlot {
  player: Tone.Player;
  chain: EffectsChain;
  volume: Tone.Volume;
  // Independent playback tracking
  startedAt: number;   // AudioContext.currentTime when player.start() was scheduled
  startOffset: number; // track position (seconds) where playback began
  playing: boolean;
}

class CollabEngine {
  private slots = new Map<string, RuntimeSlot>();
  private master: Tone.Volume | null = null;
  private masterSettings: CollabMasterSettings = { gain: 0, loopLengthOverride: null };
  private running = false;

  isRunning() { return this.running || Array.from(this.slots.values()).some((s) => s.playing); }

  getMasterLoopLength(): number | null {
    if (this.masterSettings.loopLengthOverride != null) {
      return this.masterSettings.loopLengthOverride;
    }
    // Derive from longest slot loop
    let max: number | null = null;
    for (const slot of this.slots.values()) {
      const len = (slot.loopEnd - slot.loopStart) / slotPlaybackRate(slot);
      if (max === null || len > max) max = len;
    }
    return max;
  }

  async addSlot(slot: CollabSlot, buffer: AudioBuffer): Promise<void> {
    if (this.slots.has(slot.id)) return;

    if (!this.master) {
      this.master = new Tone.Volume(this.masterSettings.gain).toDestination();
    }

    const volume = new Tone.Volume(slot.gain).connect(this.master);
    const chain = await createEffectsChain(volume);

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

    const player = new Tone.Player(toneBuffer).connect(chain.distortion);
    player.loop = true;
    player.loopStart = slot.loopStart;
    player.loopEnd = slot.loopEnd;
    player.playbackRate = slotPlaybackRate(slot);

    this.applyEffectsToChain(chain, slot.effects);

    const runtime: RuntimeSlot = {
      ...slot,
      player,
      chain,
      volume,
      startedAt: 0,
      startOffset: slot.loopStart,
      playing: false,
    };
    this.slots.set(slot.id, runtime);
    this.recomputeAllVolumes();

    // Auto-join if already playing
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
    try { slot.player.stop(); } catch { /* already stopped */ }
    slot.player.disconnect();
    slot.player.dispose();
    slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
    slot.chain.eq.disconnect(); slot.chain.eq.dispose();
    slot.chain.delay.disconnect(); slot.chain.delay.dispose();
    disposeDualReverb(slot.chain.reverbs);
    slot.chain.gain.disconnect(); slot.chain.gain.dispose();
    slot.volume.disconnect(); slot.volume.dispose();
    this.slots.delete(id);
    this.recomputeAllVolumes();
  }

  updateSlot(id: string, patch: Partial<CollabSlot>): void {
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
    }
    if (patch.effects !== undefined) {
      this.applyEffectsToChain(slot.chain, slot.effects);
    }
  }

  /** Get current playback position (seconds within track) for one slot. */
  getSlotPosition(id: string): number {
    const slot = this.slots.get(id);
    if (!slot) return 0;
    if (!slot.playing) return slot.startOffset;
    const elapsed = Math.max(0, Tone.now() - slot.startedAt) * slotPlaybackRate(slot);
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return slot.startOffset;
    // Clamp startOffset into loop region before computing offset-within-loop
    const clampedOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd, slot.startOffset));
    const offsetInLoop = clampedOffset - slot.loopStart;
    // Use positive modulo to handle any floating point weirdness
    return slot.loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur;
  }

  /** Seek one slot to a specific track position without affecting others. */
  seekSlot(id: string, time: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    // Clamp within loop region so position tracking stays valid
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

  async playSlot(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await Tone.start();
    await Tone.getContext().resume();
    // Stop first to ensure clean state (Tone.js v15 requires stop before restart)
    try { slot.player.stop(); } catch { /* ignore */ }
    slot.player.loopStart = slot.loopStart;
    slot.player.loopEnd = slot.loopEnd;
    slot.player.loop = true;
    // Clamp startOffset into loop region in case loop bounds shifted while paused
    slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
    const t = Tone.now() + 0.05;
    slot.player.start(t, slot.startOffset);
    slot.startedAt = t;
    slot.playing = true;
  }

  stopSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.startOffset = this.getSlotPosition(id);
    try { slot.player.stop(); } catch { /* ignore */ }
    slot.playing = false;
  }

  getSlot(id: string): CollabSlot | null {
    const slot = this.slots.get(id);
    if (!slot) return null;
    const { player: _p, chain: _c, volume: _v, startedAt: _s, startOffset: _o, playing: _pl, ...data } = slot;
    return data;
  }

  getAllSlots(): CollabSlot[] {
    return Array.from(this.slots.values()).map(({ player: _p, chain: _c, volume: _v, startedAt: _s, startOffset: _o, playing: _pl, ...data }) => data);
  }

  setMasterSettings(s: CollabMasterSettings): void {
    this.masterSettings = s;
    if (this.master) {
      this.master.volume.value = s.gain;
    }
  }

  async play(): Promise<void> {
    if (this.slots.size === 0) return;
    await Tone.start();
    await Tone.getContext().resume();

    const t = Tone.now() + 0.05;

    // Only start slots that aren't already playing
    for (const slot of this.slots.values()) {
      if (slot.playing) continue;
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      slot.player.loop = true;
      slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
      slot.player.start(t, slot.startOffset);
      slot.startedAt = t;
      slot.playing = true;
    }

    this.running = true;
  }

  stop(): void {
    // Only pause slots that are currently playing
    for (const slot of this.slots.values()) {
      if (!slot.playing) continue;
      slot.startOffset = this.getSlotPosition(slot.id);
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.playing = false;
    }
    this.running = false;
  }

  dispose(): void {
    this.stop();
    for (const slot of this.slots.values()) {
      slot.player.disconnect();
      slot.player.dispose();
      slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
      slot.chain.eq.disconnect(); slot.chain.eq.dispose();
      slot.chain.delay.disconnect(); slot.chain.delay.dispose();
      disposeDualReverb(slot.chain.reverbs);
      slot.chain.gain.disconnect(); slot.chain.gain.dispose();
      slot.volume.disconnect(); slot.volume.dispose();
    }
    this.slots.clear();
    if (this.master) { this.master.disconnect(); this.master.dispose(); this.master = null; }
    this.running = false;
  }

  private recomputeAllVolumes(): void {
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    for (const slot of this.slots.values()) {
      const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
      slot.volume.volume.value = effectiveMute ? -Infinity : slot.gain;
    }
  }

  private applyEffectsToChain(chain: EffectsChain, e: CollabSlot["effects"]): void {
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    chain.gain.gain.value = e.gain;
    applyDualReverb(chain.reverbs, e);
    chain.eq.low.value = e.bassBoost;
    chain.delay.delayTime.value = clamp(e.delayTime, EFFECTS_LIMITS.delayTime.min, EFFECTS_LIMITS.delayTime.max);
    chain.delay.feedback.value = clamp(e.delayFeedback, EFFECTS_LIMITS.delayFeedback.min, EFFECTS_LIMITS.delayFeedback.max);
    chain.delay.wet.value = clamp(e.delayWet, EFFECTS_LIMITS.delayWet.min, EFFECTS_LIMITS.delayWet.max);
    const grit = clamp(e.grit ?? 0, 0, 1);
    chain.distortion.wet.value = grit;
    chain.distortion.distortion = Math.pow(grit, 0.5); // curve for more punch at lower values
  }
}

export const collabEngine = new CollabEngine();
