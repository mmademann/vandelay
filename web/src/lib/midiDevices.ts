/**
 * Front panels for outboard gear, as CC maps.
 *
 * Every number here is read off Roland's own MIDI Implementation Chart for that model, not
 * a community list — the two disagree in places, and a wrong CC moves the wrong knob.
 *
 * None of these synths support SysEx (their charts all say `x / x`), so a patch cannot be
 * read back off the hardware. That sounds worse than it is: every parameter is *writable*,
 * so the app holds the patch and the synth follows. Dial the sound here and this is the
 * sound — which is also the point, because half these parameters are menu dives on a box
 * that size.
 */

export interface MidiParam {
  /** What the knob says. Roland's own name, shortened only where it will not fit. */
  label: string;
  cc: number;
  /** Where the knob sits before you touch it, 0-127. */
  initial: number;
  /** A two-state parameter draws as a switch rather than a dial. */
  toggle?: boolean;
  /** Shown under the knob instead of a raw 0-127 count, where a count means nothing. */
  format?: (v: number) => string;
}

export interface MidiDevice {
  id: string;
  name: string;
  /** Matched against the MIDI port name to preselect the right output. */
  portHint: string;
  /**
   * The CC for master tune, where the unit has one, and how far it bends.
   *
   * Needed because a slowed track almost never lands on a semitone — drop a stem to 0.65x
   * and it falls 7.46 semitones, so the nearest note the synth can play is half a
   * quarter-tone out. The leftover goes here. Roland's Boutique tune range is
   * 427.4-452.6Hz, which is 50 cents either side of centre.
   */
  tune?: { cc: number; centsRange: number };
  /**
   * The CC for delay time, where the unit has one, and how long the knob goes.
   *
   * `maxMs` is a GUESS, and has to be: Roland's chart publishes the CC number and says
   * nothing about what a value means in milliseconds. Every division is computed as a
   * fraction of it, so if the guess is wrong they are all wrong by the same ratio and one
   * number fixes the lot — which is why it is a field on screen rather than a constant.
   */
  delay?: { timeCc: number; maxMs: number };
  params: MidiParam[];
}

const pct = (v: number) => `${Math.round((v / 127) * 100)}%`;
const onOff = (v: number) => (v >= 64 ? "on" : "off");

/**
 * Roland TB-03 — MIDI Implementation Chart, every CC it recognises.
 *
 * Ten parameters, which is the whole front panel plus the delay. Deliberately the first
 * panel built: small enough to fit one row, and it proves the chain end to end.
 */
export const TB_03: MidiDevice = {
  id: "tb-03",
  name: "TB-03",
  portHint: "TB-03",
  tune: { cc: 104, centsRange: 50 },
  delay: { timeCc: 18, maxMs: 1000 },
  params: [
    { label: "Tuning", cc: 104, initial: 64 },
    { label: "Cutoff", cc: 74, initial: 64, format: pct },
    { label: "Resonance", cc: 71, initial: 32, format: pct },
    { label: "Env Mod", cc: 12, initial: 48, format: pct },
    { label: "Decay", cc: 75, initial: 64, format: pct },
    { label: "Accent", cc: 16, initial: 48, format: pct },
    { label: "Overdrive", cc: 17, initial: 0, format: pct },
    { label: "Delay Time", cc: 18, initial: 48, format: pct },
    { label: "D.Feedbk", cc: 19, initial: 32, format: pct },
    { label: "Slide", cc: 102, initial: 0, toggle: true, format: onOff },
  ],
};

export const MIDI_DEVICES: MidiDevice[] = [TB_03];

const KEY = "vandelay:midi:panel:v1";

export interface PanelState {
  portId?: string;
  channel: number;
  values: Record<number, number>;
  /** Beats per echo, or null for a hand-set delay time that follows nothing. */
  delayBeats: number | null;
  /** This unit's delay knob at full, in ms. Trimmed by ear; see MidiDevice.delay. */
  delayMaxMs: number;
}

type Stored = Record<string, Partial<PanelState>>;

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch { return {}; }
}

export function loadPanel(device: MidiDevice): PanelState {
  const got = read()[device.id];
  return {
    portId: got?.portId,
    channel: got?.channel ?? 0,
    values: got?.values ?? {},
    delayBeats: got?.delayBeats ?? null,
    delayMaxMs: got?.delayMaxMs ?? device.delay?.maxMs ?? 1000,
  };
}

export function savePanel(deviceId: string, state: PanelState): void {
  try {
    const all = read();
    all[deviceId] = state;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota */ }
}
