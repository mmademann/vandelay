import * as Tone from "tone";
import type { EffectsState } from "../store";
import { EFFECTS_LIMITS } from "../store";
import { appliedAudioEffects, type AudioTrackSettings } from "../lib/mixSettings";
import {
  clampToLoopForPlayback,
  LOOP_WRAP_EPS,
  playbackRateForEffects,
  wrapInLoopRegion,
} from "./engine";
import { createTrackCore } from "./graph";
import { applyDualReverb, disposeDualReverb, type DualReverbNodes } from "./reverbSlot";

export interface PlayAllOptions {
  getConfig?: (id: string) => { settings: AudioTrackSettings; paused: boolean } | null;
}

interface TrackNodes {
  player: Tone.Player;
  eq: Tone.EQ3;
  delay: Tone.FeedbackDelay;
  reverbs: DualReverbNodes;
  gain: Tone.Gain;
  volume: Tone.Volume;
  pauseGain: Tone.Gain;
  loopStart: number;
  loopEnd: number;
  startedAt: number;
  startedOffset: number;
  playbackRate: number;
}

interface PendingTrack {
  buffer: AudioBuffer;
}

class MixEngine {
  private master: Tone.Gain | null = null;
  private tracks = new Map<string, TrackNodes>();
  private pending = new Map<string, PendingTrack>();
  private playing = false;

  async ensureStarted() {
    await Tone.start();
  }

  private getMaster(): Tone.Gain {
    if (!this.master) this.master = new Tone.Gain(1).toDestination();
    return this.master;
  }

  setMasterGain(value: number) {
    this.getMaster().gain.value = value;
  }

  getMasterNode(): Tone.Gain {
    return this.getMaster();
  }

  async addTrack(id: string, buffer: AudioBuffer): Promise<void> {
    this.removeTrack(id);
    if (Tone.getContext().state !== "running") {
      this.pending.set(id, { buffer });
      return;
    }
    await this.buildTrack(id, buffer);
  }

  private async buildTrack(id: string, buffer: AudioBuffer): Promise<void> {
    const master = this.getMaster();
    const pauseGain = new Tone.Gain(1).connect(master);
    const volume = new Tone.Volume(0).connect(pauseGain);
    const { player, eq, delay, reverbs, gain } = await createTrackCore(buffer, volume);
    player.loop = false;
    player.loopStart = 0;
    player.loopEnd = buffer.duration;

    this.tracks.set(id, {
      player,
      eq,
      delay,
      reverbs,
      gain,
      volume,
      pauseGain,
      loopStart: 0,
      loopEnd: buffer.duration,
      startedAt: 0,
      startedOffset: 0,
      playbackRate: 1,
    });

    if (this.playing) {
      const t = this.tracks.get(id)!;
      t.startedAt = Tone.now();
      t.startedOffset = t.loopStart;
      player.start(undefined, t.loopStart);
    }
  }

  removeTrack(id: string): void {
    this.pending.delete(id);
    const t = this.tracks.get(id);
    if (!t) return;
    try {
      if (t.player.state === "started") t.player.stop(0);
    } catch {
      /* ignore */
    }
    t.player.disconnect();
    t.player.dispose();
    t.eq.disconnect(); t.eq.dispose();
    t.delay.disconnect(); t.delay.dispose();
    disposeDualReverb(t.reverbs);
    t.gain.disconnect(); t.gain.dispose();
    t.volume.disconnect(); t.volume.dispose();
    t.pauseGain.disconnect(); t.pauseGain.dispose();
    this.tracks.delete(id);
  }

  setPaused(id: string, paused: boolean): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.pauseGain.gain.value = paused ? 0 : 1;
  }

  seek(id: string, position: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const offset = clampToLoopForPlayback(position, t.loopStart, t.loopEnd);
    t.startedOffset = offset;
    t.startedAt = Tone.now();
    if (this.playing && t.player.state === "started") {
      this.restartPlayerAt(t, offset);
    }
  }

  applyEffects(id: string, e: EffectsState, volumeDb: number, muted: boolean): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const newRate = playbackRateForEffects(e);
    if (this.playing && t.playbackRate !== newRate) {
      t.startedOffset = this.computePosition(t);
      t.startedAt = Tone.now();
      if (t.player.state === "started") {
        this.restartPlayerAt(t, t.startedOffset);
      }
    }
    t.playbackRate = newRate;
    t.player.playbackRate = newRate;
    t.eq.low.value = e.bassBoost;
    t.delay.delayTime.value = Math.min(EFFECTS_LIMITS.delayTime.max, Math.max(EFFECTS_LIMITS.delayTime.min, e.delayTime));
    t.delay.feedback.value = Math.min(EFFECTS_LIMITS.delayFeedback.max, Math.max(EFFECTS_LIMITS.delayFeedback.min, e.delayFeedback));
    t.delay.wet.value = Math.min(EFFECTS_LIMITS.delayWet.max, Math.max(EFFECTS_LIMITS.delayWet.min, e.delayWet));
    applyDualReverb(t.reverbs, e);
    t.gain.gain.value = e.gain;
    t.volume.volume.value = muted ? -Infinity : volumeDb;
  }

  private computePosition(t: TrackNodes): number {
    const span = t.loopEnd - t.loopStart;
    if (span <= 0) return t.startedOffset;
    if (!this.playing) return t.startedOffset;
    const elapsed = (Tone.now() - t.startedAt) * t.playbackRate;
    const raw = t.startedOffset + elapsed;
    if (raw < t.loopEnd) return raw;
    return wrapInLoopRegion(raw, t.loopStart, t.loopEnd);
  }

  private restartPlayerAt(t: TrackNodes, offset: number) {
    if (!this.playing) return;
    const time = Tone.now();
    try {
      if (t.player.state === "started") t.player.stop(time);
    } catch {
      /* ignore */
    }
    t.player.start(time + 0.05, offset);
  }

  getPosition(id: string): number {
    const t = this.tracks.get(id);
    if (!t) return 0;
    const pos = this.computePosition(t);
    if (!this.playing) return pos;

    const elapsed = (Tone.now() - t.startedAt) * t.playbackRate;
    const raw = t.startedOffset + elapsed;
    if (raw >= t.loopEnd - LOOP_WRAP_EPS) {
      t.startedOffset = pos;
      t.startedAt = Tone.now();
      this.restartPlayerAt(t, pos);
    }
    return pos;
  }

  setLoop(id: string, start: number, end: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const changed =
      Math.abs(t.loopStart - start) > 0.001
      || Math.abs(t.loopEnd - end) > 0.001;
    t.loopStart = start;
    t.loopEnd = end;
    const buf = t.player.buffer;
    const duration = buf?.loaded ? buf.duration : end;
    t.player.loop = false;
    t.player.loopStart = 0;
    t.player.loopEnd = duration;
    if (!this.playing || !changed) return;
    const pos = clampToLoopForPlayback(this.computePosition(t), start, end);
    t.startedOffset = pos;
    t.startedAt = Tone.now();
    if (t.player.state === "started") {
      this.restartPlayerAt(t, pos);
    }
  }

  async playAll(opts: PlayAllOptions = {}): Promise<void> {
    if (this.playing) return;
    const drainedIds: string[] = [];
    if (this.pending.size > 0) {
      await this.ensureStarted();
      for (const [id, p] of [...this.pending.entries()]) {
        this.pending.delete(id);
        await this.buildTrack(id, p.buffer);
        drainedIds.push(id);
      }
    }
    if (opts.getConfig) {
      for (const id of drainedIds) {
        const cfg = opts.getConfig(id);
        if (!cfg) continue;
        this.setLoop(id, cfg.settings.loopStart, cfg.settings.loopEnd);
        this.applyEffects(id, appliedAudioEffects(cfg.settings), cfg.settings.volumeDb, cfg.settings.muted);
        this.setPaused(id, cfg.paused);
      }
      for (const id of this.tracks.keys()) {
        if (drainedIds.includes(id)) continue;
        const cfg = opts.getConfig(id);
        if (!cfg) continue;
        this.setLoop(id, cfg.settings.loopStart, cfg.settings.loopEnd);
        this.applyEffects(id, appliedAudioEffects(cfg.settings), cfg.settings.volumeDb, cfg.settings.muted);
        this.setPaused(id, cfg.paused);
      }
    }
    const now = Tone.now();
    for (const t of this.tracks.values()) {
      if (t.player.state === "started") continue;
      t.startedAt = now;
      t.startedOffset = t.loopStart;
      t.player.start(undefined, t.loopStart);
    }
    this.playing = true;
  }

  stopAll(): void {
    for (const t of this.tracks.values()) {
      try {
        if (t.player.state === "started") t.player.stop(0);
      } catch {
        /* ignore */
      }
    }
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  hasTrack(id: string): boolean {
    return this.tracks.has(id);
  }

  trackIds(): string[] {
    return [...this.tracks.keys()];
  }

  disposeAll(): void {
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
    this.master?.disconnect();
    this.master?.dispose();
    this.master = null;
    this.playing = false;
  }
}

export const mixEngine = new MixEngine();
