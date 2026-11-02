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

class MidiOut {
  private access: MIDIAccess | null = null;
  private enabled = false;
  private running = false;
  private bpm = 120;
  private anchored = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextPulseMs = 0;
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

  /** Rack started. Downstream sequencers run from their own bar 1. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.enabled) return;
    this.nextPulseMs = performance.now();
    this.sendNow(START);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.enabled) this.sendNow(STOP);
  }

  private tick = (): void => {
    if (!this.enabled || !this.running) return;
    const now = performance.now();
    const msPerPulse = 60000 / (this.bpm * PPQ);
    // A backgrounded tab freezes timers, and the clock would otherwise come back owing
    // thousands of pulses and fire them all at once.
    if (this.nextPulseMs < now - 500) this.nextPulseMs = now;
    const horizon = now + LOOKAHEAD_MS;
    while (this.nextPulseMs < horizon) {
      this.sendAt(CLOCK, this.nextPulseMs);
      // Read msPerPulse fresh each tick rather than each pulse: a tempo change takes effect
      // at the next tick, which is well under the time it takes to turn a dial.
      this.nextPulseMs += msPerPulse;
    }
  };

  private sendAt(byte: number, atMs: number): void {
    if (!this.access) return;
    // Every output, not a chosen one. The whole rig is meant to share this tempo, and
    // picking ports is a setting nobody would ever want set differently.
    for (const out of this.access.outputs.values()) {
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
    const ch = Math.max(0, Math.min(15, channel - 1));
    const v = Math.max(0, Math.min(127, Math.round(value)));
    try { out.send([0xb0 | ch, cc & 0x7f, v]); } catch { /* port went away */ }
  }
}

export const midiOut = new MidiOut();
