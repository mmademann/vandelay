import * as Tone from "tone";
import { EFFECTS_LIMITS, effectiveEffects, type EffectsState, useStore } from "../store";
import { createTrackCore } from "./graph";
import { applyDualReverb, disposeDualReverb, type DualReverbNodes } from "./reverbSlot";

/** Restart the live player slightly before loopEnd so wrap matches the loop region. */
export const LOOP_WRAP_EPS = 0.05;

/** Wrap playback time after the playhead passes loopEnd (loop restart only). */
export function wrapInLoopRegion(
  position: number,
  loopStart: number,
  loopEnd: number,
): number {
  const span = loopEnd - loopStart;
  if (span <= 0) return position;
  if (position >= loopStart && position < loopEnd) return position;
  if (position < loopStart) return loopStart;
  const n = ((position - loopStart) % span + span) % span;
  return loopStart + n;
}

/** Map scrub/play start into the loop region without modulo-wrapping the waveform. */
export function clampToLoopForPlayback(
  position: number,
  loopStart: number,
  loopEnd: number,
): number {
  const span = loopEnd - loopStart;
  if (span <= 0) return position;
  if (position < loopStart) return loopStart;
  if (position >= loopEnd) return Math.max(loopStart, loopEnd - 0.05);
  return position;
}

class Engine {
  private player: Tone.Player | null = null;
  private distortion: Tone.Distortion | null = null;
  private eq: Tone.EQ3 | null = null;
  private delay: Tone.FeedbackDelay | null = null;
  private reverbs: DualReverbNodes | null = null;
  private gain: Tone.Gain | null = null;
  private currentBuffer: AudioBuffer | null = null;
  private playStartedAt = 0;
  private playOffset = 0;
  private playbackRate = 1;
  private loopStart = 0;
  private loopEnd = 0;
  private playing = false;

  private clampBufferTime(position: number): number {
    const d = this.currentBuffer?.duration;
    if (d == null || !Number.isFinite(d)) return Math.max(0, position);
    return Math.max(0, Math.min(d, position));
  }

  async ensureStarted() {
    await Tone.start();
  }

  async load(buffer: AudioBuffer) {
    this.dispose();
    this.currentBuffer = buffer;
    if (Tone.getContext().state !== "running") {
      return;
    }
    await this.buildGraph(buffer);
  }

  async ensureGraph(): Promise<boolean> {
    if (this.player) return true;
    if (!this.currentBuffer) return false;
    await this.ensureStarted();
    await this.buildGraph(this.currentBuffer);
    return true;
  }

  hasGraph(): boolean {
    return this.player !== null;
  }

  private async buildGraph(buffer: AudioBuffer) {
    const destination = Tone.getDestination();
    const core = await createTrackCore(buffer, destination);
    this.player = core.player;
    this.distortion = core.distortion;
    this.eq = core.eq;
    this.delay = core.delay;
    this.reverbs = core.reverbs;
    this.gain = core.gain;
    this.syncPlayerBufferLoop(buffer.duration);
    const { effects, effectsEnabled } = useStore.getState();
    this.applyEffects(effectiveEffects(effects, effectsEnabled));
  }

  /** Keep native buffer looping off; loop region is handled in this class. */
  private syncPlayerBufferLoop(duration: number) {
    if (!this.player) return;
    this.player.loop = false;
    this.player.loopStart = 0;
    this.player.loopEnd = duration;
  }

  applyEffects(e: EffectsState) {
    if (!this.player || !this.distortion || !this.eq || !this.delay || !this.reverbs || !this.gain) return;
    const speedChanged = this.playing && e.speed !== this.playbackRate;
    if (speedChanged) {
      this.playOffset = this.computePosition();
      this.playStartedAt = Tone.now();
    }
    this.playbackRate = e.speed;
    this.player.playbackRate = playbackRateForEffects(e);
    this.eq.low.value = e.bassBoost;
    this.delay.delayTime.value = Math.min(EFFECTS_LIMITS.delayTime.max, Math.max(EFFECTS_LIMITS.delayTime.min, e.delayTime));
    this.delay.feedback.value = Math.min(EFFECTS_LIMITS.delayFeedback.max, Math.max(EFFECTS_LIMITS.delayFeedback.min, e.delayFeedback));
    this.delay.wet.value = Math.min(EFFECTS_LIMITS.delayWet.max, Math.max(EFFECTS_LIMITS.delayWet.min, e.delayWet));
    applyDualReverb(this.reverbs, e);
    this.gain.gain.value = e.gain;
    const grit = Math.min(1, Math.max(0, e.grit ?? 0));
    this.distortion.wet.value = grit;
    this.distortion.distortion = Math.pow(grit, 0.5);
  }

  setLoop(start: number, end: number) {
    const changed =
      Math.abs(this.loopStart - start) > 0.001
      || Math.abs(this.loopEnd - end) > 0.001;
    this.loopStart = start;
    this.loopEnd = end;
    if (this.currentBuffer) this.syncPlayerBufferLoop(this.currentBuffer.duration);
    if (!this.player || !this.playing || !changed) return;
    const pos = clampToLoopForPlayback(this.computePosition(), start, end);
    this.playOffset = pos;
    this.playStartedAt = Tone.now();
    this.restartPlayerAt(pos);
  }

  async play(start: number) {
    const ready = await this.ensureGraph();
    if (!ready || !this.player) return;
    const offset = clampToLoopForPlayback(
      this.clampBufferTime(start),
      this.loopStart,
      this.loopEnd,
    );
    if (this.player.state === "started") this.player.stop();
    this.playOffset = offset;
    this.playStartedAt = Tone.now();
    this.playing = true;
    this.player.start(undefined, offset);
  }

  stop() {
    if (!this.player) return;
    if (this.player.state === "started") this.player.stop();
    this.playing = false;
  }

  async seek(position: number) {
    const offset = this.clampBufferTime(position);
    this.playOffset = offset;
    this.playStartedAt = Tone.now();
    const wasPlaying = this.playing;
    const ready = await this.ensureGraph();
    if (!ready || !this.player) return;
    if (wasPlaying) this.restartPlayerAt(offset);
  }

  /** Position within the loop region from the internal clock (no player restart). */
  private computePosition(): number {
    const span = this.loopEnd - this.loopStart;
    if (span <= 0) return this.playOffset;
    if (!this.playing) {
      return this.clampBufferTime(this.playOffset);
    }
    const elapsed = (Tone.now() - this.playStartedAt) * this.playbackRate;
    const raw = this.playOffset + elapsed;
    if (raw < this.loopEnd) return raw;
    return wrapInLoopRegion(raw, this.loopStart, this.loopEnd);
  }

  /** Stop then start on the transport clock so grains/sources do not stack (volume jump). */
  private restartPlayerAt(offset: number) {
    if (!this.player || !this.playing) return;
    const t = Tone.now();
    try {
      this.player.stop(t);
    } catch {
      /* ignore */
    }
    this.player.start(t + 0.05, offset);
  }

  getPosition(): number {
    const pos = this.computePosition();
    if (!this.playing) return pos;

    const elapsed = (Tone.now() - this.playStartedAt) * this.playbackRate;
    const raw = this.playOffset + elapsed;
    if (raw >= this.loopEnd - LOOP_WRAP_EPS) {
      this.playOffset = pos;
      this.playStartedAt = Tone.now();
      this.restartPlayerAt(pos);
    }
    return pos;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getBuffer(): AudioBuffer | null {
    return this.currentBuffer;
  }

  dispose() {
    if (this.player) {
      try {
        if (this.player.state === "started") this.player.stop(0);
      } catch {
        /* ignore */
      }
      this.player.disconnect();
      this.player.dispose();
    }
    if (this.distortion) { this.distortion.disconnect(); this.distortion.dispose(); }
    if (this.eq) { this.eq.disconnect(); this.eq.dispose(); }
    if (this.delay) { this.delay.disconnect(); this.delay.dispose(); }
    if (this.reverbs) disposeDualReverb(this.reverbs);
    if (this.gain) { this.gain.disconnect(); this.gain.dispose(); }
    this.player = null;
    this.distortion = null;
    this.eq = null;
    this.delay = null;
    this.reverbs = null;
    this.gain = null;
    this.playing = false;
    this.playOffset = 0;
  }
}

function speedToDetune(speed: number): number {
  return 1200 * Math.log2(speed);
}

/** Match live Tone.Player: linked pitch = speed only; unlinked = speed × semitone offset. */
export function playbackRateForEffects(e: EffectsState): number {
  return e.linkPitch
    ? e.speed
    : e.speed * Math.pow(2, e.pitch / 12);
}

/** Wall-clock output length for a looped export (seconds). */
export function exportOutputDuration(
  loopStart: number,
  loopEnd: number,
  loopCount: number,
  effects: EffectsState,
): number {
  const rate = playbackRateForEffects(effects);
  return ((loopEnd - loopStart) / rate) * loopCount;
}

export const engine = new Engine();
export { speedToDetune };
