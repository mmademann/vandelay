/**
 * MIDI out — vandelay as the tempo master and front panel for outboard gear.
 *
 * The point of this is the master speed slider. Drop the rack to 0.75x and every sequencer
 * and arpeggiator downstream slows with it, at the source, with none of the artifacts that
 * come from stretching a recording. A Roland Boutique chained to this is screwed in the
 * same sense the samples are.
 *
 * Chrome only — Safari has no Web MIDI — and a secure context, which localhost satisfies.
 */

/** MIDI clock is 24 pulses per quarter note. Not negotiable; it is in the spec. */
const PPQ = 24;
const CLOCK = 0xf8;
const START = 0xfa;
const STOP = 0xfc;

/**
 * Pulses are SCHEDULED ahead, not fired by the timer that notices them.
 *
 * A JS interval is accurate to maybe a few milliseconds on a good day and much worse under
 * load, which at 24 pulses a beat is audible as a wobbling tempo. Web MIDI's send() takes a
 * timestamp, though, and the browser delivers on it — so a loose timer that runs often and
 * schedules precisely is tight where a precise timer would not be. Same trick as the Web
 * Audio metronome, for the same reason.
 */
const TICK_MS = 25;
const LOOKAHEAD_MS = 120;

type Ports = { id: string; name: string };

/**
 * Which MIDI channels a message goes out on. 0 means all sixteen.
 *
 * All sixteen is the default, and it is the right default here. A channel is a number the
 * synth has to agree with, it is buried in that synth's own menus, and there is no way to
 * read it back — so a wrong one looks exactly like a working connection, because clock
 * and Start carry no channel and arrive regardless. Sending to every channel of ONE port
 * cannot be wrong: the device ignores the fifteen that are not its own. The picker stays
 * for a multitimbral box, where it starts to matter.
 */
const ALL_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function channelsOf(channel: number): number[] {
  if (channel < 1) return ALL_CHANNELS;
  return [Math.max(0, Math.min(15, channel - 1))];
}

class MidiOut {
  private access: MIDIAccess | null = null;
  private enabled = false;
  private running = false;
  private bpm = 120;
  private anchored = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextPulseMs = 0;
  private pulse = 0;
  private pulsesPerStep = PPQ / 4;
  private onStep: ((step: number, atMs: number, stepMs: number) => void) | null = null;
  private listeners = new Set<() => void>();

  /** Told when ports appear or vanish, so every panel can re-render its list. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  isSupported(): boolean {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  }

  isEnabled(): boolean { return this.enabled; }

  ports(): Ports[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id }));
  }

  /**
   * Ask the browser for MIDI and start sending.
   *
   * Chrome shows a permission prompt the first time, so this must be called from a click.
   */
  async enable(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isSupported()) {
      return { ok: false, error: "This browser has no Web MIDI. Chrome does; Safari does not." };
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return { ok: false, error: "MIDI access was refused." };
    }
    // Plugging a synth in mid-session should not need a reload.
    this.access.onstatechange = () => this.emit();
    this.enabled = true;
    this.nextPulseMs = performance.now();
    if (!this.timer) this.timer = setInterval(this.tick, TICK_MS);
    if (this.running) this.sendNow(START);
    this.emit();
    return { ok: true };
  }

  disable(): void {
    if (this.enabled && this.running) this.sendNow(STOP);
    this.enabled = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.emit();
  }

  /**
   * The HEARD tempo of the tempo anchor, which already folds in Speed, Stretch and the
   * master dial. Sending the raw detected BPM instead would hold the gear at the track's
   * original tempo while the track itself slowed away from it.
   */
  setBpm(bpm: number | undefined): void {
    if (bpm && bpm > 20 && bpm < 400) {
      this.bpm = bpm;
      this.anchored = true;
    } else {
      // No tempo anchor, or its BPM is unreadable. Keep sending at the last good tempo
      // rather than lurching the hardware to a default, but say so — a clock running at
      // 120 while the rack plays at 73 is the kind of thing you notice an hour later.
      this.anchored = false;
    }
    this.emit();
  }

  currentBpm(): number { return this.bpm; }

  /** Whether that BPM came from a tempo anchor, or is just the last one it saw. */
  isAnchored(): boolean { return this.anchored; }

  /**
   * Two things can want the clock running, and either is enough.
   *
   * The rack is the obvious one. The other is our own step sequencer: writing a bassline
   * means hearing it on its own, and making that require Play All turns a synth panel
   * into something you can only use with a full session loaded. Whoever lets go last
   * stops the clock.
   */
  private transportOn = false;
  private seqOn = false;

  private refresh(atMs?: number): void {
    const want = this.transportOn || this.seqOn;
    if (want === this.running) return;
    this.running = want;
    if (!this.enabled) return;
    if (want) {
      // Downbeat one, at the instant the rack's own audio reaches the speakers — which is
      // NOT now. See multiEngine.transportLeadMs.
      this.nextPulseMs = atMs ?? performance.now();
      this.pulse = 0;
      this.sendAt(START, this.nextPulseMs);
    } else {
      this.sendNow(STOP);
      // A note we scheduled on with its note-off still in the future would hang forever.
      if (this.access) for (const id of this.access.outputs.keys()) this.allNotesOff(id);
    }
  }

  /**
   * Rack started. Downstream sequencers run from their own bar 1.
   *
   * `atMs` is when the rack is actually audible, which the caller knows and this does
   * not. Without it the hardware starts while the audio engine is still counting down its
   * lookahead, and everything outboard plays ahead of the track by most of a beat.
   */
  start(atMs?: number): void {
    const wasRunning = this.running;
    this.transportOn = true;
    this.refresh(atMs);
    // Already running because the panel was auditioning a line on its own, so `refresh`
    // did nothing and the pattern kept the phase it picked up when you pressed Play bass.
    // The rack is the authority on where bar 1 is; re-anchor to it.
    if (wasRunning) this.restart(atMs);
  }

  stop(): void { this.transportOn = false; this.refresh(); }

  /** Our own sequencer holds the clock up, so a bassline plays with the rack stopped. */
  setSequencerRunning(on: boolean): void { this.seqOn = on; this.refresh(); }

  isRunning(): boolean { return this.running; }

  /**
   * Back to step 1, in step with the rack.
   *
   * Rewind All drops every slot on its own downbeat; without this the pulse counter runs
   * straight through it and the bassline is left mid-pattern against a track that just
   * restarted. Start goes out too, so a device running its OWN pattern rewinds with us —
   * ports we are sequencing are excluded from transport messages anyway.
   */
  restart(atMs?: number): void {
    this.pulse = 0;
    this.nextPulseMs = atMs ?? performance.now();
    if (this.enabled && this.running) this.sendAt(START, this.nextPulseMs);
  }

  private tick = (): void => {
    if (!this.enabled || !this.running) return;
    const now = performance.now();
    const msPerPulse = 60000 / (this.bpm * PPQ);
    // A backgrounded tab freezes timers, and the clock would otherwise come back owing
    // thousands of pulses and fire them all at once.
    if (this.nextPulseMs < now - 500) { this.nextPulseMs = now; this.pulse = 0; }
    const horizon = now + LOOKAHEAD_MS;
    while (this.nextPulseMs < horizon) {
      this.sendAt(CLOCK, this.nextPulseMs);
      // Sequencer steps ride the SAME scheduled pulses as the clock, so a note cannot
      // land a hair off the beat the device is being told to keep. Anything timed by its
      // own interval would drift against this one.
      if (this.onStep && this.pulse % this.pulsesPerStep === 0) {
        this.onStep(this.pulse / this.pulsesPerStep, this.nextPulseMs, msPerPulse * this.pulsesPerStep);
      }
      this.pulse++;
      // Read msPerPulse fresh each tick rather than each pulse: a tempo change takes effect
      // at the next tick, which is well under the time it takes to turn a dial.
      this.nextPulseMs += msPerPulse;
    }
  };

  /**
   * Called once per sequencer step, with the time that step lands and how long it lasts.
   *
   * The step index counts up forever; a pattern takes it modulo its own length. That keeps
   * patterns of different lengths from needing their own counters.
   */
  setStepCallback(fn: ((step: number, atMs: number, stepMs: number) => void) | null): void {
    this.onStep = fn;
  }

  /** Steps per quarter note: 4 = sixteenths, 2 = eighths, 6 = sixteenth triplets. */
  setStepsPerBeat(n: number): void {
    this.pulsesPerStep = Math.max(1, Math.round(PPQ / Math.max(1, n)));
  }

  /**
   * One note, scheduled.
   *
   * The note-off is scheduled with it rather than chased by a timer — the whole point of
   * the lookahead is that both ends land where they were put. `overlapMs` past the step
   * makes the next note legato, which is how a 303 slides: the glide comes from one note
   * still sounding when the next arrives, not from a parameter.
   */
  sendNote(portId: string, channel: number, note: number, velocity: number, atMs: number, holdMs: number): void {
    if (!this.access || !this.enabled) return;
    const out = this.access.outputs.get(portId);
    if (!out) return;
    const n = Math.max(0, Math.min(127, Math.round(note)));
    const v = Math.max(1, Math.min(127, Math.round(velocity)));
    try {
      for (const ch of channelsOf(channel)) {
        out.send([0x90 | ch, n, v], atMs);
        out.send([0x80 | ch, n, 0], atMs + Math.max(10, holdMs));
      }
    } catch { /* port went away */ }
  }

  /** Silence a port — every note off, on every channel. Used when a pattern stops. */
  allNotesOff(portId: string): void {
    if (!this.access) return;
    const out = this.access.outputs.get(portId);
    if (!out) return;
    for (let ch = 0; ch < 16; ch++) {
      try { out.send([0xb0 | ch, 123, 0]); } catch { /* gone */ }
    }
  }

  /**
   * Ports vandelay is sequencing itself, which must NOT be sent Start.
   *
   * Start tells a device to run its OWN pattern. On a synth we are feeding notes to, that
   * means two basslines at once — ours and whatever was last written to the box. Clock
   * still goes everywhere, so the tempo stays locked either way.
   *
   * **Only Start is withheld.** Holding Stop back as well was the bug that made the rig
   * unstoppable: a port sequenced after it had already been started kept running its own
   * pattern with no message left that could reach it, and nothing in the app would
   * silence it. Stop is never the wrong thing to deliver.
   */
  private sequenced = new Set<string>();

  setSequenced(portId: string, on: boolean): void {
    if (on) {
      this.sequenced.add(portId);
      // It may already be running its own pattern from an earlier Start. Park it now,
      // because from here on it will never be sent another one.
      this.sendTo(portId, STOP);
      this.allNotesOff(portId);
    } else {
      this.sequenced.delete(portId);
    }
  }

  private sendTo(portId: string, byte: number): void {
    const out = this.access?.outputs.get(portId);
    if (!out) return;
    try { out.send([byte]); } catch { /* gone */ }
  }

  private sendAt(byte: number, atMs: number): void {
    if (!this.access) return;
    // Clock goes to every output: the whole rig shares one tempo, and picking ports for it
    // is a setting nobody would ever want set differently.
    for (const [id, out] of this.access.outputs) {
      if (byte === START && this.sequenced.has(id)) continue;
      try { out.send([byte], atMs); } catch { /* port went away mid-send */ }
    }
  }

  private sendNow(byte: number): void {
    this.sendAt(byte, performance.now());
  }

  /**
   * A parameter change to ONE device.
   *
   * Unlike clock, this cannot go to every port. The CC numbers collide across the range —
   * 74 is the filter cutoff on the TB-03 and on the SH-01A and on the JP-08 — so a
   * broadcast would move three synths at once. Each panel picks its own port.
   */
  sendCC(portId: string, channel: number, cc: number, value: number): void {
    if (!this.access || !this.enabled) return;
    const out = this.access.outputs.get(portId);
    if (!out) return;
    const v = Math.max(0, Math.min(127, Math.round(value)));
    try {
      for (const ch of channelsOf(channel)) out.send([0xb0 | ch, cc & 0x7f, v]);
    } catch { /* port went away */ }
  }
}

export const midiOut = new MidiOut();
