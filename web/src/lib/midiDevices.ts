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

type Stored = Record<string, { portId?: string; values?: Record<number, number> }>;

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch { return {}; }
}

export function loadPanel(deviceId: string): { portId?: string; values: Record<number, number> } {
  const got = read()[deviceId];
  return { portId: got?.portId, values: got?.values ?? {} };
}

export function savePanel(deviceId: string, portId: string | undefined, values: Record<number, number>): void {
  try {
    const all = read();
    all[deviceId] = { portId, values };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota */ }
}
