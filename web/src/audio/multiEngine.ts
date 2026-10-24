import * as Tone from "tone";

// Request a larger OS audio buffer and longer look-ahead to reduce CPU-overload glitches.
// Must run before any Tone nodes are created (module-level).
Tone.setContext(new Tone.Context({ latencyHint: "playback", lookAhead: 0.3, updateInterval: 0.08 }));

import { disposeDualReverb, synthesizeSpringImpulse } from "./reverbSlot";
import { createMultiEffectsChain, applyMultiEffectsChain, type MultiEffectsChain } from "./multiChain";
import type { MultiSlot, MultiMasterSettings, ThrowSettings } from "../lib/multiSettings";
import { DEFAULT_THROW_SETTINGS } from "../lib/multiSettings";

/**
 * Ceiling on the master bus, in dB.
 *
 * Duplicated in renderMulti.ts, like every other number the two share — an export that
 * limits at a different point from playback is not the same recording (invariant 2).
 */
export const MASTER_CEILING_DB = -0.5;

function slotPlaybackRate(slot: MultiSlot, masterSpeed = 1): number {
  const base = slot.linkPitch ? slot.speed : slot.speed * Math.pow(2, slot.pitch / 12);
  // Scaling every slot by the same factor shifts them all by the same interval, so the
  // intervals between slots — the key matching — survive a master speed change untouched.
  return slot.bypassMasterSpeed ? base : base * masterSpeed;
}

/**
 * Seconds a slot is displaced from its loop start by Phase.
 *
 * Duplicated character-for-character in renderMulti.ts so export and playback cannot drift;
 * surfaceCoverage enforces that they stay identical.
 */
function phaseOffsetSec(phase: number, barSec: number, loopDur: number): number {
  if (phase <= 0 || barSec <= 0 || loopDur <= 0) return 0;
  return (((phase * barSec) % loopDur) + loopDur) % loopDur;
}

interface RuntimeSlot extends MultiSlot {
  /** Anchor bar length in this slot's buffer seconds — set by the UI, used for Phase. */
  phaseBarSec?: number;
  /** Whether the spring send is currently wired to master — see MultiEngine.setSend. */
  springLive?: boolean;
  /** Same, for the throw send's reverb tail. */
  throwLive?: boolean;
  /** Pending disconnect of that tail, once the echoes have rung out. */
  throwTailTimer?: ReturnType<typeof setTimeout> | null;
  /** Percussive hit times in buffer seconds, ascending — see setHits. */
  hits?: number[];
  /** Tone time an armed throw will fire at, or 0. The UI reads it to light the button. */
  throwArmedAt?: number;
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
  /** Tone time the current fade ends; volume writes before this would cancel the ramp. */
  fadeUntil: number;
  /** dB the in-flight fade is heading toward, so a redundant reschedule can be skipped. */
  fadeTarget: number;
  /** Bumped on each seek so stopped slots know to repaint their playhead. */
  seekNonce: number;
  startOffset: number;
  playing: boolean;
}

class MultiEngine {
  private slots = new Map<string, RuntimeSlot>();
  private master: Tone.Volume | null = null;
  private masterLimiter: Tone.Limiter | null = null;
  private masterSettings: MultiMasterSettings = {
    gain: 0,
    loopLengthOverride: null,
    masterSpeed: 1,
    throwSettings: { ...DEFAULT_THROW_SETTINGS },
  };
  private running = false;
  private throwDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

  isRunning() { return this.running || Array.from(this.slots.values()).some((s) => s.playing); }

  /** Seconds for a slot to ramp in on play and out on stop. */
  private static readonly FADE_SEC = 10;
  /** Bottom of the gain knob — at or below this a slot is silenced outright. */
  static readonly GAIN_FLOOR_DB = -60;
  private static readonly FADE_STEPS = 60;
  /**
   * Longest a throw will wait for a hit before firing anyway.
   *
   * A sparse stem — one hit per bar at half time — must not swallow the gesture: past this
   * the throw behaves the way it always did and fires immediately.
   */
  private static readonly THROW_MAX_WAIT_SEC = 1.2;

  /**
   * Ramp a slot's volume so the change is spread evenly across the full duration.
   *
   * Amplitude and loudness are not proportional — amplitude 0.5 is only about -6 dB, already
   * subjectively most of the way up. A linear amplitude ramp therefore sounds finished early on
   * the way in, while sounding correct on the way out. Raising progress to a power biases the
   * curve so the audible change is spread evenly in both directions.
   */
  private static rampVolume(
    slot: RuntimeSlot,
    targetDb: number,
    startTime: number,
    seconds: number,
    fromSilence = true,
  ): void {
    const param = slot.volume.volume;
    param.cancelScheduledValues(startTime);
    // A floored target means silence, so ramp amplitude to a true 0 rather than -60 dB's 0.1%.
    const targetAmp = targetDb <= MultiEngine.GAIN_FLOOR_DB ? 0 : Tone.dbToGain(targetDb);
    const startAmp = fromSilence ? 0 : Tone.dbToGain(param.value);
    const rising = targetAmp > startAmp;
    param.setValueAtTime(fromSilence ? -60 : param.value, startTime);
    for (let i = 1; i <= MultiEngine.FADE_STEPS; i++) {
      const p = i / MultiEngine.FADE_STEPS;
      // Rising: hold low early so the top of the range gets real time. Falling: linear already
      // spends its length audibly, so leave it be.
      const shaped = rising ? Math.pow(p, 3) : p;
      const amp = startAmp + (targetAmp - startAmp) * shaped;
      // Floor at -60 dB — dbToGain(0) is -Infinity, which poisons the automation curve.
      const db = amp <= 0.001 ? -60 : Tone.gainToDb(amp);
      param.linearRampToValueAtTime(db, startTime + seconds * p);
    }
    slot.fadeUntil = startTime + seconds;
    slot.fadeTarget = targetDb;
  }

  /** Master output node — null until the first slot is added. Used by the recorder to tap output. */
  getMasterNode(): Tone.Volume | null { return this.master; }

  /**
   * The last node before the speakers — what a recording must tap.
   *
   * Tapping the master Volume instead records PRE-limiter, so a loud take would clip in the
   * file while playback in the room stayed clean, and nothing on screen would say why.
   */
  getRecordTap(): Tone.ToneAudioNode | null { return this.masterLimiter; }

  /** Fade length in seconds, so the UI can label it without keeping its own copy. */
  fadeSeconds(): number { return MultiEngine.FADE_SEC; }

  getMasterLoopLength(): number | null {
    if (this.masterSettings.loopLengthOverride != null) {
      return this.masterSettings.loopLengthOverride;
    }
    let max: number | null = null;
    for (const slot of this.slots.values()) {
      const len = (slot.loopEnd - slot.loopStart) / slotPlaybackRate(slot, this.masterSettings.masterSpeed);
      if (max === null || len > max) max = len;
    }
    return max;
  }

  async addSlot(slot: MultiSlot, buffer: AudioBuffer): Promise<void> {
    if (this.slots.has(slot.id)) return;

    if (!this.master) {
      // Brick wall between the mix and the speakers. Five stems summing, plus Grit's +9dB
      // net at full, will push past 0dBFS on their own; without this that arrives as hard
      // digital clipping in the room AND in every take. It is not a sound and has no knob —
      // at ordinary levels nothing touches it.
      this.masterLimiter = new Tone.Limiter(MASTER_CEILING_DB).toDestination();
      this.master = new Tone.Volume(this.masterSettings.gain).connect(this.masterLimiter);
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
    // Idle until thrown. A Tone.Reverb is a convolver, so leaving one connected per slot
    // costs full convolution for a send most slots never use.
    throwReverb.disconnect(this.master);
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

    // chain.drive, not chain.distortion: the grit drive sits in front of the shaper, so it
    // is now the chain's input node.
    const player = new Tone.Player(toneBuffer).connect(chain.drive);
    player.loop = true;
    player.loopStart = safeLoopStart;
    player.loopEnd = safeLoopEnd;
    player.playbackRate = slotPlaybackRate(slot, this.masterSettings.masterSpeed);

    applyMultiEffectsChain(chain, slot.effects);
    const springOn = (slot.effects.bigKnobWet ?? 0) > 0;
    springWet.gain.value = slot.effects.bigKnobWet ?? 0;
    // Built connected, so drop it straight back out when the knob is at zero.
    if (!springOn) springWet.disconnect(this.master);
    const runtime: RuntimeSlot = {
      ...slot,
      springLive: springOn,
      throwLive: false,
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
      fadeUntil: 0,
      fadeTarget: 0,
      seekNonce: 0,
      startOffset: safeLoopStart,
      playing: false,
    };
    this.slots.set(slot.id, runtime);
    this.recomputeAllVolumes();

    if (this.running) {
      const t = Tone.now() + 0.05;
      // Join the rack where it already is, not at the top of this slot's loop. Starting at
      // loopStart put a stem added mid-session on its own downbeat, wherever that happened
      // to fall against everything else, and only Rewind All recovered it. playSlot and
      // startSilencedSlots were both fixed to do this; addSlot was the third join path and
      // was missed. Falls back to loopStart when nothing else is playing. Invariant 26.
      const at = this.matchingLoopPosition(runtime) ?? slot.loopStart;
      player.start(t, at);
      runtime.startedAt = t;
      runtime.startOffset = at;
      runtime.playing = true;
    }
  }

  /**
   * Replace a slot's audio with a time-stretched copy.
   *
   * Stretching changes the buffer's timebase, so every value expressed in buffer seconds
   * has to move with it. Loop bounds are scaled by the same factor, and a playing slot is
   * re-anchored at its equivalent position — without that, getSlotPosition keeps deriving
   * position from a startedAt that belongs to the old timebase and the playhead drifts
   * outside the loop brackets.
   *
   * `ratio` is the new buffer's length relative to the one currently loaded.
   */
  swapBuffer(id: string, buffer: AudioBuffer, ratio: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;

    // Where the slot is right now, in the OLD timebase, before anything changes.
    const wasPlaying = slot.playing;
    const oldPos = wasPlaying ? this.getSlotPosition(id) : slot.startOffset;

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

    const dur = buffer.duration;
    const newStart = Math.max(0, Math.min(slot.loopStart * ratio, dur - 0.01));
    const newEnd = Math.min(dur, Math.max(newStart + 0.01, slot.loopEnd * ratio));
    const newPos = Math.max(newStart, Math.min(newEnd, oldPos * ratio));

    // Stop before swapping: a running player holding the old buffer will keep emitting.
    if (wasPlaying) slot.player.stop();

    slot.player.buffer = toneBuffer;
    slot.player.loopStart = newStart;
    slot.player.loopEnd = newEnd;
    slot.loopStart = newStart;
    slot.loopEnd = newEnd;
    slot.startOffset = newPos;
    slot.seekNonce++;

    if (wasPlaying) {
      // Restart in the FUTURE, from where the slot will be by then — not from where it was
      // when the position was read. `newPos` was sampled at "now"; starting it 50ms later
      // from that same offset drops the slot 50ms behind the rest of the rack on every
      // buffer swap (a sweet spot, a re-lock, auto re-lock). At 84bpm that is 7% of a beat,
      // which on drums is an audible flam. Advance by the lead time in FILE seconds, so the
      // playback rate has to be folded in, and wrap so a swap near the loop end stays inside.
      const lead = 0.05;
      const t = Tone.now() + lead;
      const rate = slot.player.playbackRate as number;
      const advanced = this.wrapIntoLoop(slot, newPos + lead * (Number.isFinite(rate) ? rate : 1));
      slot.player.start(t, advanced);
      slot.startOffset = advanced;
      slot.startedAt = t;
      slot.playing = true;
    } else {
      slot.startedAt = 0;
    }
  }

  /** Loop bounds after a swap rescaled them, so React state can follow the engine. */
  getLoopStart(id: string): number { return this.slots.get(id)?.loopStart ?? 0; }
  getLoopEnd(id: string): number { return this.slots.get(id)?.loopEnd ?? 0; }

  /**
   * The buffer the slot is actually playing, which after a stretch is not the one React
   * state holds until the next render. Callers that need to measure the live audio — loop
   * quantizing right after a stretch — must use this rather than the entry's copy.
   */
  getBuffer(id: string): AudioBuffer | null {
    const b = this.slots.get(id)?.player.buffer;
    return b?.get() ?? null;
  }

  removeSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.throwTimer) clearTimeout(slot.throwTimer);
    if (slot.throwTailTimer) clearTimeout(slot.throwTailTimer);
    try { slot.player.stop(); } catch { /* already stopped */ }
    slot.player.disconnect();
    slot.player.dispose();
    slot.chain.drive.disconnect(); slot.chain.drive.dispose();
    slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
    slot.chain.makeup.disconnect(); slot.chain.makeup.dispose();
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
    slot.chain.reverbBypass.disconnect(); slot.chain.reverbBypass.dispose();
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

  /**
   * Slide this slot's playback earlier or later by `seconds`, without touching its loop.
   *
   * This is what makes Phase audible. Moving loop bounds alone does not shift anything:
   * updateSlot deliberately preserves the playhead when bounds change, so the audio keeps
   * reading from wherever it already was and only the region differs on the next wrap.
   * A phase offset has to move the read position itself — the equivalent of sliding the
   * audio inside a fixed clip, so this slot's material arrives against the anchor at a
   * different point in the bar.
   */
  nudgeSlot(id: string, seconds: number): void {
    const slot = this.slots.get(id);
    if (!slot || !Number.isFinite(seconds) || seconds === 0) return;
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return;

    const cur = slot.playing ? this.getSlotPosition(id) : slot.startOffset;
    // Positive modulo so a backwards nudge wraps to the end of the loop rather than
    // landing before its start.
    const rel = (((cur - slot.loopStart + seconds) % loopDur) + loopDur) % loopDur;
    const next = slot.loopStart + rel;

    slot.startOffset = next;
    slot.seekNonce++;
    if (slot.playing) {
      const now = Tone.now();
      slot.player.seek(next, now);
      slot.startedAt = now;
    }
  }

  /**
   * Write slot properties, and decide what happens to the playhead in ONE place.
   *
   * Loop bounds and the playhead are separate quantities, so every caller that moved bounds
   * had to remember whether to move the read position with them — Move carries it, Snap and
   * quantize do not, and quantize additionally has to fold a playhead the new loop no longer
   * contains. That was three call sites each remembering a different rule, and the one that
   * forgot (quantize, mid-playback) left slots running past their own loop.
   *
   * Now the rule is an argument. `carryPlayhead` slides the read position with the region,
   * which is what Move means; without it the position stays put, which is what Snap and
   * quantize mean. Either way the playhead is folded back inside the loop before returning,
   * because a player parked outside its loop region plays to the end of the buffer instead
   * of wrapping — that guarantee belongs here rather than at each call site.
   */
  updateSlot(id: string, patch: Partial<MultiSlot>, opts?: { carryPlayhead?: boolean; fadeSec?: number }): void {
    const slot = this.slots.get(id);
    if (!slot) return;

    const boundsMoved = patch.loopStart !== undefined || patch.loopEnd !== undefined;
    const startDelta = boundsMoved && patch.loopStart !== undefined
      ? patch.loopStart - slot.loopStart
      : 0;
    // Read the position against the OLD bounds. getSlotPosition folds into whatever loop the
    // slot currently has, so once the new bounds are assigned it can never report a position
    // outside them — which is why an earlier "fold the stranded playhead back in" check after
    // the assignment was dead code that could not fire. The comparison has to happen here.
    const posBefore = boundsMoved ? this.getSlotPosition(id) : 0;

    Object.assign(slot, patch);

    if (patch.pitch !== undefined || patch.speed !== undefined || patch.linkPitch !== undefined) {
      if (slot.playing) {
        const pos = this.getSlotPosition(id);
        slot.player.playbackRate = slotPlaybackRate(slot, this.masterSettings.masterSpeed);
        slot.startOffset = pos;
        slot.startedAt = Tone.now();
      } else {
        slot.player.playbackRate = slotPlaybackRate(slot, this.masterSettings.masterSpeed);
      }
    }
    if (boundsMoved) {
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      if (slot.playing) {
        const pos = this.getSlotPosition(id);
        slot.startOffset = pos;
        slot.startedAt = Tone.now();
      }
      // Sliding the region without the playhead strands it behind — a large Move would put
      // it outside the loop entirely, which is why Move used to follow every bounds write
      // with its own nudge.
      if (opts?.carryPlayhead && startDelta !== 0) this.nudgeSlot(id, startDelta);
      // Whichever rule applied: if the slot was sitting outside its new loop — quantize can
      // shorten one past the playhead — fold it back in. Web Audio plays such a source to the
      // end of the buffer before it wraps, so it goes quiet and rejoins in the wrong place.
      // Folding by the loop duration preserves the position within the bar, because a
      // quantized loop is a whole number of bars.
      else this.reseatInLoop(id, posBefore);
    }
    if (patch.gain !== undefined || patch.muted !== undefined || patch.soloed !== undefined) {
      // A fade is only meaningful for mute/solo. Ramping a gain-knob drag would smear every
      // frame of the drag into a 10s ramp and the knob would feel disconnected from the sound.
      const fadeSec = patch.muted !== undefined || patch.soloed !== undefined ? opts?.fadeSec : undefined;
      this.recomputeAllVolumes(fadeSec);
      // play() skips silent slots, so a slot un-silenced mid-session has to start itself.
      // Solo changes can un-silence any slot, not just this one, so sweep them all.
      if (this.running && (patch.muted !== undefined || patch.soloed !== undefined)) {
        this.startSilencedSlots();
      }
    }
    if (patch.effects !== undefined) {
      applyMultiEffectsChain(slot.chain, slot.effects);
      const wet = slot.effects.bigKnobWet ?? 0;
      slot.springWet.gain.value = wet;
      if (this.master) {
        slot.springLive = MultiEngine.setSend(slot.springWet, this.master, wet > 0, slot.springLive ?? true);
      }
    }
  }

  getSlotPosition(id: string): number {
    const slot = this.slots.get(id);
    if (!slot) return 0;
    if (!slot.playing) return slot.startOffset;
    const elapsed = Math.max(0, Tone.now() - slot.startedAt) * slotPlaybackRate(slot, this.masterSettings.masterSpeed);
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return slot.startOffset;
    const clampedOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd, slot.startOffset));
    const offsetInLoop = clampedOffset - slot.loopStart;
    return slot.loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur;
  }

  /**
   * Keep a parallel send out of the render graph while it is silent.
   *
   * Web Audio processes every node reachable from the destination, so a convolver at 0% wet
   * costs exactly as much as one at 100%. Each slot carries a 3-second spring impulse and a
   * throw reverb it may never use; five slots was enough to blow the audio thread's budget
   * and the whole rack went silent while the transport kept running.
   *
   * The gain is already 0 either side of this, so connecting and disconnecting is inaudible.
   */
  private static setSend(
    node: Tone.ToneAudioNode,
    output: Tone.ToneAudioNode,
    live: boolean,
    was: boolean,
  ): boolean {
    if (live === was) return was;
    if (live) node.connect(output);
    else node.disconnect(output);
    return live;
  }

  /**
   * Seconds this slot is displaced from its loop start by Phase.
   *
   * Phase is a playhead offset, so unlike loop bounds it is not implicit in the slot's
   * geometry — every path that returns a slot to its start has to add it back, or the
   * displacement silently disappears the first time you press rewind.
   *
   * `phaseBarSec` is the anchor's bar length in this slot's own buffer seconds, pushed down
   * from the UI whenever the grid changes; the engine has no view of the tempo grid itself.
   */
  private phaseOffsetFor(slot: RuntimeSlot): number {
    return phaseOffsetSec(slot.phase ?? 0, slot.phaseBarSec ?? 0, slot.loopEnd - slot.loopStart);
  }

  /** Where a slot should sit when returned to the top of its loop, phase included. */
  startPositionFor(id: string): number {
    const slot = this.slots.get(id);
    if (!slot) return 0;
    return slot.loopStart + this.phaseOffsetFor(slot);
  }

  /** The UI owns the tempo grid, so it tells the engine how long a bar is for this slot. */
  setPhaseBarSec(id: string, barSec: number): void {
    const slot = this.slots.get(id);
    if (slot) slot.phaseBarSec = barSec;
  }

  /**
   * Bar length the UI last pushed down for this slot.
   *
   * The offline render needs it to reproduce the phase offset: loop bounds are un-phased,
   * so without the bar length an export plays every slot on the downbeat while live
   * playback is displaced.
   */
  getPhaseBarSec(id: string): number {
    return this.slots.get(id)?.phaseBarSec ?? 0;
  }

  /**
   * Return every slot to its loop start on one shared timestamp.
   *
   * Distinct from calling seekSlot per slot, which is what this replaced: each of those
   * calls reads Tone.now() separately, so the slots restart microseconds apart and the
   * downbeats smear. Re-syncing is the whole reason to press rewind, so it has to be one
   * instant for all of them.
   */
  rewindAll(): void {
    const now = Tone.now();
    for (const slot of this.slots.values()) {
      const target = slot.loopStart + this.phaseOffsetFor(slot);
      slot.startOffset = target;
      slot.seekNonce++;
      if (slot.playing) {
        slot.player.seek(target, now);
        slot.startedAt = now;
      }
    }
  }

  seekSlot(id: string, time: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const clamped = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, time));
    slot.startOffset = clamped;
    slot.seekNonce++;
    if (slot.playing) {
      const now = Tone.now();
      slot.player.seek(clamped, now);
      slot.startedAt = now;
    }
  }

  /** Increments on every seek. A stopped slot has no repaint loop, so the UI polls this to redraw. */
  getSeekNonce(id: string): number {
    return this.slots.get(id)?.seekNonce ?? 0;
  }

  isSlotPlaying(id: string): boolean {
    return this.slots.get(id)?.playing ?? false;
  }

  isThrowActive(id: string): boolean {
    return this.slots.get(id)?.throwActive ?? false;
  }

  /**
   * Percussive hit times for a slot, in buffer seconds. Supplied by the UI, which owns the
   * analysis; the engine only needs to know when the next one arrives.
   */
  setHits(id: string, hits: number[]): void {
    const slot = this.slots.get(id);
    if (slot) slot.hits = hits;
  }

  /** Tone time an armed throw is waiting for, or 0. Lets the UI show the button as armed. */
  throwArmedAt(id: string): number {
    return this.slots.get(id)?.throwArmedAt ?? 0;
  }

  /**
   * Seconds until this slot's next percussive hit, or null when there is nothing to wait for.
   *
   * Three time domains in four lines, so: `hits` and the playhead are in BUFFER seconds,
   * and the gap between them has to be divided by the playback rate to become the wall-clock
   * wait the scheduler needs. Getting that wrong is wrong by exactly the rate.
   */
  private secondsToNextHit(slot: RuntimeSlot): number | null {
    if (!slot.playing || !slot.hits || slot.hits.length === 0) return null;
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return null;
    const pos = this.getSlotPosition(slot.id);
    // Only hits inside the loop can arrive; anything outside it is never played.
    const inLoop = slot.hits.filter((t) => t >= slot.loopStart && t < slot.loopEnd);
    if (inLoop.length === 0) return null;
    const next = inLoop.find((t) => t > pos);
    // Past the last one, the next is the first after the loop wraps.
    const aheadFile = next !== undefined ? next - pos : loopDur - (pos - inLoop[0]);
    const rate = slotPlaybackRate(slot, this.masterSettings.masterSpeed);
    if (!(rate > 0)) return null;
    return aheadFile / rate;
  }

  throwSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.throwTimer) clearTimeout(slot.throwTimer);
    if (slot.throwTailTimer) { clearTimeout(slot.throwTailTimer); slot.throwTailTimer = null; }
    const ts = this.masterSettings.throwSettings;
    // Wait for the hit rather than firing on the click. A throw is supposed to catch the
    // snare; fired the instant a finger lands it catches whatever was sounding, which is
    // almost never that. Capped so a stem with sparse hits cannot swallow the gesture — past
    // that it just fires, which is the old behaviour.
    const wait = this.secondsToNextHit(slot);
    const lead = wait !== null && wait <= MultiEngine.THROW_MAX_WAIT_SEC ? wait : 0;
    const now = Tone.now() + lead;
    slot.throwArmedAt = lead > 0 ? now : 0;
    // Wire the tail back in before opening the gate.
    if (this.master) {
      slot.throwLive = MultiEngine.setSend(slot.throwReverb, this.master, true, slot.throwLive ?? false);
    }
    // Gate open
    slot.throwSend.gain.cancelScheduledValues(now);
    // rampTo with an explicit start time, not "now" — the whole point is that the gate opens
    // at the hit, not when the button was pressed.
    slot.throwSend.gain.rampTo(1, 0.02, now);
    // Filter env: jump to peak then sweep down to resting freq
    const peakFreq = Math.min(16000, ts.filterFreq * 10);
    slot.throwFilter.frequency.cancelScheduledValues(now);
    slot.throwFilter.frequency.setValueAtTime(peakFreq, now);
    slot.throwFilter.frequency.exponentialRampToValueAtTime(ts.filterFreq, now + 0.8);
    // The gate stays open for a fixed 400ms FROM THE HIT, so the wait is added on top.
    slot.throwActive = true;
    slot.throwTimer = setTimeout(() => {
      slot.throwSend.gain.rampTo(0, 0.05);
      slot.throwActive = false;
      slot.throwArmedAt = 0;
      slot.throwTimer = null;
      // Let the echoes and the reverb ring out before dropping the branch, or the throw is
      // cut off at the moment it is supposed to be trailing away. Feedback repeats first,
      // then the reverb decay, plus a margin.
      const tailSec = ts.delayTime * 8 + ts.reverbDecay + 1;
      slot.throwTailTimer = setTimeout(() => {
        slot.throwTailTimer = null;
        if (!slot.throwActive && this.master) {
          slot.throwLive = MultiEngine.setSend(slot.throwReverb, this.master, false, slot.throwLive ?? true);
        }
      }, tailSec * 1000);
    }, (lead + 0.4) * 1000);
  }

  setThrowSettings(settings: ThrowSettings): void {
    const prevDecay = this.masterSettings.throwSettings.reverbDecay;
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
    // Only the decay changes the impulse. Regenerating on every throw setting meant dragging
    // the throw delay or wet knob rebuilt one convolution impulse per slot — five of them on
    // a full rack — for a value the impulse does not depend on. Debounced as well, because
    // dragging the decay knob itself still fires per frame.
    if (settings.reverbDecay === prevDecay) return;
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

  async playSlot(id: string, instant = false): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await Tone.start();
    await Tone.getContext().resume();
    try { slot.player.stop(); } catch { /* ignore */ }
    slot.player.loopStart = slot.loopStart;
    slot.player.loopEnd = slot.loopEnd;
    slot.player.loop = true;
    // Join the rack in phase rather than resuming from wherever this slot was parked.
    // Starting a single slot mid-session otherwise puts it off the shared downbeat with
    // nothing in the UI to say so, and only Play All or Rewind All would recover it.
    const peer = this.matchingLoopPosition(slot);
    slot.startOffset =
      peer ?? Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
    const t = Tone.now() + 0.05;
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
    if (!effectiveMute) {
      if (instant) {
        // Cancel any in-flight fade before jumping, or the ramp keeps writing over this.
        slot.volume.volume.cancelScheduledValues(t);
        slot.volume.volume.setValueAtTime(
          slot.gain <= MultiEngine.GAIN_FLOOR_DB ? -Infinity : slot.gain,
          t,
        );
        slot.fadeUntil = 0;
        slot.fadeTarget = slot.gain;
      } else {
        // Ramp in amplitude, not dB. A linear dB ramp from -60 sits near-silent for most of its
        // length then rushes the last stretch, which reads as an abrupt start rather than a fade.
        MultiEngine.rampVolume(slot, slot.gain, t, MultiEngine.FADE_SEC);
      }
    }
    slot.player.start(t, slot.startOffset);
    slot.startedAt = t;
    slot.playing = true;
  }

  stopSlot(id: string, instant = false): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.startOffset = this.getSlotPosition(id);
    const now = Tone.now();
    if (instant) {
      // Cancel the ramp before stopping, or a pending fade keeps writing to the param
      // after the player is gone.
      slot.volume.volume.cancelScheduledValues(now);
      slot.fadeUntil = 0;
      slot.fadeTarget = slot.gain;
      try { slot.player.stop(now); } catch { /* ignore */ }
    } else {
      MultiEngine.rampVolume(slot, -60, now, MultiEngine.FADE_SEC, false);
      try { slot.player.stop(now + MultiEngine.FADE_SEC); } catch { /* ignore */ }
    }
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
    const prevSpeed = this.masterSettings.masterSpeed;
    const speedChanged = s.masterSpeed !== prevSpeed;
    // Positions must be read at the OLD rate — getSlotPosition scales elapsed time by the
    // current rate, so sampling after the swap reinterprets past time and the playhead jumps.
    const frozen = speedChanged
      ? new Map(
          Array.from(this.slots.values())
            .filter((slot) => slot.playing && !slot.bypassMasterSpeed)
            .map((slot) => [slot.id, this.getSlotPosition(slot.id)]),
        )
      : null;

    this.masterSettings = s;
    if (this.master) {
      this.master.volume.value = s.gain;
    }
    if (speedChanged) this.applyMasterSpeed(frozen!);
  }

  /**
   * Re-rate every non-bypassed slot. Position must be re-anchored first: getSlotPosition
   * derives position from (now - startedAt) * rate, so changing rate without resetting the
   * anchor reinterprets all previously-elapsed time at the new rate and the playhead jumps.
   */
  private applyMasterSpeed(frozen: Map<string, number>): void {
    const now = Tone.now();
    for (const slot of this.slots.values()) {
      if (slot.bypassMasterSpeed) continue;
      const pos = frozen.get(slot.id);
      if (slot.playing && pos !== undefined) {
        // Resume from where it actually was, with the clock restarted at the new rate.
        slot.startOffset = pos;
        slot.startedAt = now;
      }
      // Player.playbackRate is a plain setter, not a ramping Param, so this is a step
      // change. Fine for dial drags; the re-anchor above is what keeps it from glitching.
      slot.player.playbackRate = slotPlaybackRate(slot, this.masterSettings.masterSpeed);
    }
  }

  /**
   * Start playback.
   *
   * `fromLoopStart` re-anchors every audible slot to its loop start at one shared instant,
   * which is what puts them on a common downbeat. It only makes musical sense once the
   * loops are whole bars at a single tempo — otherwise it just resets phase on loops that
   * will drift apart again anyway — so callers gate it on a tempo anchor being set.
   * Without it, each slot resumes from where it was parked and already-playing slots are
   * left alone.
   */
  async play(instant = false, fromLoopStart = false): Promise<void> {
    await Tone.start();
    await Tone.getContext().resume();
    this.running = true;

    if (this.slots.size === 0) return;

    const t = Tone.now() + 0.05;
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);

    for (const slot of this.slots.values()) {
      if (slot.playing && !fromLoopStart) continue;
      // Phase included: re-anchoring to a bare loopStart would put every slot at relative
      // position 0 and silently discard the displacement.
      if (fromLoopStart) slot.startOffset = slot.loopStart + this.phaseOffsetFor(slot);
      // Muted and non-soloed slots still start, just silently. Running them keeps them on
      // the same grid as everything else, so unmuting or soloing drops them straight in on
      // the beat instead of starting wherever they happened to be parked. Costs a voice and
      // an effects chain per hidden slot, which is the deliberate trade.
      const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
      try { slot.player.stop(); } catch { /* ignore */ }
      slot.player.loopStart = slot.loopStart;
      slot.player.loopEnd = slot.loopEnd;
      slot.player.loop = true;
      slot.startOffset = Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
      if (effectiveMute) {
        // Hard to silence, never ramped — a fade-in here would be audible, which is exactly
        // what mute is meant to prevent.
        slot.volume.volume.cancelScheduledValues(t);
        slot.volume.volume.setValueAtTime(-Infinity, t);
        slot.fadeUntil = 0;
        slot.fadeTarget = -Infinity;
      } else if (instant) {
        slot.volume.volume.cancelScheduledValues(t);
        slot.volume.volume.setValueAtTime(
          slot.gain <= MultiEngine.GAIN_FLOOR_DB ? -Infinity : slot.gain,
          t,
        );
        slot.fadeUntil = 0;
        slot.fadeTarget = slot.gain;
      } else {
        MultiEngine.rampVolume(slot, slot.gain, t, MultiEngine.FADE_SEC);
      }
      slot.player.start(t, slot.startOffset);
      slot.startedAt = t;
      slot.playing = true;
    }
  }

  stop(fade = false): void {
    const now = Tone.now();
    for (const slot of this.slots.values()) {
      if (!slot.playing) continue;
      slot.startOffset = this.getSlotPosition(slot.id);
      if (fade) {
        MultiEngine.rampVolume(slot, -60, now, MultiEngine.FADE_SEC, false);
        try { slot.player.stop(now + MultiEngine.FADE_SEC); } catch { /* ignore */ }
      } else {
        try { slot.player.stop(); } catch { /* ignore */ }
      }
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
      if (slot.throwTailTimer) clearTimeout(slot.throwTailTimer);
      slot.player.disconnect();
      slot.player.dispose();
      slot.chain.drive.disconnect(); slot.chain.drive.dispose();
    slot.chain.distortion.disconnect(); slot.chain.distortion.dispose();
    slot.chain.makeup.disconnect(); slot.chain.makeup.dispose();
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
      slot.chain.reverbBypass.disconnect(); slot.chain.reverbBypass.dispose();
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
    if (this.masterLimiter) { this.masterLimiter.disconnect(); this.masterLimiter.dispose(); this.masterLimiter = null; }
    this.running = false;
  }

  /**
   * Where `slot` should start to be in phase with the rest of the rack.
   *
   * Uses another playing slot's progress through its own loop, scaled into this slot's loop
   * length. Exact when the loops are the same musical length — which is what Match Tempos
   * guarantees — and a reasonable approximation otherwise. Null when nothing else is
   * playing, in which case there is no phase to join.
   */
  private matchingLoopPosition(slot: RuntimeSlot): number | null {
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return null;
    for (const [id, other] of this.slots) {
      if (other === slot || !other.playing) continue;
      const otherDur = other.loopEnd - other.loopStart;
      if (otherDur <= 0) continue;
      const pos = this.getSlotPosition(id);
      // Un-phase the peer before reading its progress. The peer is whichever slot happens
      // to be first in the map and may carry its own displacement; without subtracting it
      // every slot joining afterwards inherits that peer's phase as if it were the
      // downbeat, and the rack quietly rotates as a whole.
      const rel = pos - other.loopStart - this.phaseOffsetFor(other);

      // Match the peer's position in BARS, not its fraction of its own loop. The two are
      // the same only when both loops are the same length: a peer 30% through a 4-bar loop
      // is 1.2 bars in, while 30% of a 6-bar loop is 1.8 bars — the joining slot lands 0.6
      // of a bar off the beat, and nothing in the UI says so. Bar lengths come from the UI
      // via setPhaseBarSec (the per-slot grid), so this is the same bar Phase and quantize
      // use. Without them — no tempo anchor, nothing detected — fall back to the fraction,
      // which is still better than starting at the top.
      const otherBar = other.phaseBarSec ?? 0;
      const ownBar = slot.phaseBarSec ?? 0;
      let unphased: number;
      if (otherBar > 0 && ownBar > 0) {
        const barsIn = rel / otherBar;
        const ownLoopBars = loopDur / ownBar;
        // Fold into this slot's own loop length in bars, so a short loop joining a long one
        // lands at the matching point of the bar rather than past its own end.
        const wrapped = ownLoopBars > 0 ? (((barsIn % ownLoopBars) + ownLoopBars) % ownLoopBars) : 0;
        unphased = slot.loopStart + wrapped * ownBar;
      } else {
        const frac = (((rel / otherDur) % 1) + 1) % 1;
        unphased = slot.loopStart + frac * loopDur;
      }
      // Then add this slot's own phase. Phase is a displacement from the shared downbeat, so
      // every path that re-anchors a slot has to re-apply it — joining a running rack
      // included, which is how the per-slot Play button and unmute both reach here.
      return this.wrapIntoLoop(slot, unphased + this.phaseOffsetFor(slot));
    }
    return null;
  }

  /**
   * After a bounds change, fold a running playhead back inside the loop.
   *
   * `updateSlot` writes the player's loop points and deliberately leaves the playhead where
   * it is — a Move must not jump the audio. But quantize can shorten a loop past the current
   * position, and a player whose position sits outside its loop region plays on to the end
   * of the buffer before it ever wraps. Wrapping by whole loop durations is safe for the
   * grid: post-quantize a loop is a whole number of bars, so folding by it preserves the
   * slot's position within the bar exactly.
   *
   * No-op when the playhead is already inside, so Move and Snap stay silent.
   */
  reseatInLoop(id: string, posBefore: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const dur = slot.loopEnd - slot.loopStart;
    if (dur <= 0) return;
    if (posBefore >= slot.loopStart && posBefore < slot.loopEnd) return;
    const wrapped = this.wrapIntoLoop(slot, posBefore);
    slot.startOffset = wrapped;
    slot.seekNonce++;
    // A stopped slot only needs its parked offset corrected; seeking a stopped player throws.
    if (!slot.playing) return;
    const now = Tone.now();
    slot.player.seek(wrapped, now);
    slot.startedAt = now;
  }

  /** Fold an absolute position back inside a slot's loop. */
  private wrapIntoLoop(slot: RuntimeSlot, pos: number): number {
    const loopDur = slot.loopEnd - slot.loopStart;
    if (loopDur <= 0) return slot.loopStart;
    return slot.loopStart + ((((pos - slot.loopStart) % loopDur) + loopDur) % loopDur);
  }

  /**
   * Start any slot that is now audible but still stopped — unmuting into a running rack.
   *
   * It joins at `matchingLoopPosition`, NOT at its own parked `startOffset`. Resuming from
   * where it was parked is what this used to do, and it dropped the slot off the shared
   * downbeat with nothing in the UI to say so; only Play All or Rewind All recovered it.
   * See invariant 26.
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
      // Land on a peer's current loop position rather than this slot's parked offset, so a
      // slot that missed the group start still joins in phase. Falls back to its own offset
      // when nothing else is running.
      const peer = this.matchingLoopPosition(slot);
      slot.startOffset = peer ?? Math.max(slot.loopStart, Math.min(slot.loopEnd - 0.01, slot.startOffset));
      // Match playSlot's fade-in — recomputeAllVolumes has already jumped this to full gain.
      MultiEngine.rampVolume(slot, slot.gain, t, MultiEngine.FADE_SEC);
      slot.player.start(t, slot.startOffset);
      slot.startedAt = t;
      slot.playing = true;
    }
  }

  private recomputeAllVolumes(fadeSec?: number): void {
    const anySoloed = Array.from(this.slots.values()).some((s) => s.soloed);
    const now = Tone.now();
    for (const slot of this.slots.values()) {
      // A slot fading out is on its way to a scheduled player.stop(). Retargeting its ramp would
      // swell it back up while the player is still running, and it would never stop.
      if (!slot.playing && now < slot.fadeUntil) continue;
      const effectiveMute = slot.muted || (anySoloed && !slot.soloed);
      const targetDb = effectiveMute ? -60 : slot.gain;
      if (now < slot.fadeUntil) {
        // A fade is in flight. Leave it alone unless its destination actually changed —
        // rescheduling an identical ramp restarts it, which is audible as a second fade.
        if (Math.abs(targetDb - slot.fadeTarget) < 0.01) continue;
        const remaining = slot.fadeUntil - now;
        MultiEngine.rampVolume(slot, targetDb, now, remaining, false);
        continue;
      }
      if (fadeSec && fadeSec > 0) {
        // Ramp rather than jump. The player keeps running throughout — a faded mute is a
        // level change, not a stop, so the slot stays on the grid and un-mutes back in phase.
        const cur = slot.volume.volume.value;
        const silentNow = !Number.isFinite(cur) || cur <= MultiEngine.GAIN_FLOOR_DB;
        MultiEngine.rampVolume(slot, targetDb, now, fadeSec, silentNow);
        continue;
      }
      // Writing .value cancels scheduled automation, so only do it once no fade is pending.
      // At the bottom of the knob's range, go to true silence rather than -60 dB's 0.1%.
      slot.volume.volume.value =
        effectiveMute || slot.gain <= MultiEngine.GAIN_FLOOR_DB ? -Infinity : slot.gain;
    }
  }
}

export const multiEngine = new MultiEngine();
