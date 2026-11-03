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
 *
 * What is deliberately NOT here: modulation (CC 1), expression (CC 11) and hold (CC 64).
 * Every chart lists them and no chart is wrong to — they are just not part of a patch.
 * They are what a player does while the patch sits still, and a dial that sends them would
 * be a wheel you cannot let go of.
 */

export interface MidiParam {
  /** What the knob says. Roland's own name, shortened only where it will not fit. */
  label: string;
  cc: number;
  /** Where the knob sits before you touch it, 0-127. */
  initial: number;
  /**
   * A two-state parameter draws as a switch rather than a dial.
   *
   * It reports **on** when the CC is high and **off** when it is low — not which of the
   * synth's two positions Roland calls which. The charts publish the number and never the
   * mapping, so a switch that said "-24dB" would be a guess wearing a fact's clothes.
   */
  toggle?: boolean;
  /** Shown under the knob instead of a raw 0-127 count, where a count means nothing. */
  format?: (v: number) => string;
  /**
   * Section heading this parameter sits under, following the unit's own front panel.
   *
   * Optional, because the TB-03 is ten dials and a heading over each would be noise. The
   * other two are forty-odd, and forty identical circles in one row is not a front panel,
   * it is a haystack.
   */
  group?: string;
}

/**
 * A named sound, as the CCs it differs from silence-on-arrival in.
 *
 * Sparse on purpose: a preset lists only what makes the sound, so anything it leaves out
 * keeps whatever the panel already has. The master tune is never in one — it belongs to
 * the key-following correction, and a preset that reset it would detune the synth against
 * the track every time you picked a sound.
 *
 * These exist because the factory initials are a test tone, not a sound: VCA envelope with
 * zero sustain and a short decay is a blip, which is what every note sounded like.
 */
export interface SynthPreset {
  name: string;
  values: Record<number, number>;
}

export interface MidiDevice {
  id: string;
  name: string;
  /**
   * Model names to match against a MIDI port. Specific, never generic.
   *
   * A list because one driver may spell it more than one way, but every entry here has
   * to name THIS unit and nothing else.
   */
  portHints: string[];
  /**
   * Weaker names, used only when no device matched a port by model.
   *
   * The first-gen Boutiques can enumerate as plain "Boutique", because they share a
   * driver and a USB descriptor — so that word has to be available and must never win.
   * It was in `portHints` for an hour and it cost: the SH-01A's port is called
   * "Boutique SH-01A", the JP-08 matched it too, and with every panel mounted BOTH
   * sequencers fired down the one cable. Two lines at two different divisions on one
   * synth, so changing either Speed changed nothing you could hear.
   */
  portFallbackHints?: string[];
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
  /**
   * How far this unit bends at full, in semitones — the fallback tune control.
   *
   * Only set it where there is no `tune`. Pitch bend moves the whole instrument, which is
   * all master tune does, so a unit whose tuning MIDI cannot reach can still be pulled
   * onto a slowed track's pitch. See `midiOut.sendPitchBendCents` for why the number is a
   * guess and why a wrong one is survivable.
   */
  bend?: { semitoneRange: number };
  presets?: SynthPreset[];
  params: MidiParam[];
}

const pct = (v: number) => `${Math.round((v / 127) * 100)}%`;
const onOff = (v: number) => (v >= 64 ? "on" : "off");

function hasHint(hints: string[] | undefined, portName: string): boolean {
  const n = portName.toLowerCase();
  return (hints ?? []).some((h) => n.includes(h.toLowerCase()));
}

/**
 * Does this MIDI port belong to this device?
 *
 * Used by the panel's auto-pick, the transport's connected dot and the auto-open, which
 * must all agree. A model hint always wins; a fallback hint only counts when no device
 * claimed the port by model, so a generic name can never steal a port from the unit
 * whose model is written on it.
 */
export function matchesPort(device: MidiDevice, portName: string): boolean {
  if (hasHint(device.portHints, portName)) return true;
  if (!hasHint(device.portFallbackHints, portName)) return false;
  return !ownedByAnother(device, portName);
}

/** Does some OTHER device have this port's model name written on it? */
export function ownedByAnother(device: MidiDevice, portName: string): boolean {
  return MIDI_DEVICES.some((d) => d.id !== device.id && hasHint(d.portHints, portName));
}


/**
 * Roland TB-03 — MIDI Implementation Chart, every CC it recognises.
 *
 * Ten parameters, which is the whole front panel plus the delay. Deliberately the first
 * panel built: small enough to fit one row, and it proves the chain end to end.
 */
export const TB_03: MidiDevice = {
  id: "tb-03",
  name: "TB-03",
  portHints: ["TB-03"],
  tune: { cc: 104, centsRange: 50 },
  delay: { timeCc: 18, maxMs: 1000 },
  presets: [
    // cutoff 74 · res 71 · env 12 · decay 75 · accent 16 · drive 17
    { name: "Acid", values: { 74: 48, 71: 105, 12: 95, 75: 40, 16: 80, 17: 30 } },
    { name: "Sub", values: { 74: 24, 71: 10, 12: 20, 75: 90, 16: 40, 17: 0 } },
    { name: "Squelch", values: { 74: 70, 71: 120, 12: 110, 75: 25, 16: 100, 17: 60 } },
    { name: "Rolling", values: { 74: 40, 71: 80, 12: 64, 75: 64, 16: 55, 17: 15 } },
    { name: "Dub", values: { 74: 30, 71: 48, 12: 40, 75: 100, 16: 30, 17: 10, 18: 96, 19: 90 } },
    { name: "Screech", values: { 74: 96, 71: 127, 12: 120, 75: 20, 16: 110, 17: 90 } },
    { name: "Clean", values: { 74: 56, 71: 20, 12: 40, 75: 70, 16: 30, 17: 0 } },
  ],
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

/**
 * Roland SH-01A — `SH-01A MIDI Implementation Chart`, Aug 2017, Version 1.00.
 *
 * An SH-101, so one oscillator, one filter, one envelope and a sub. Forty-one parameters,
 * grouped the way the hardware is laid out left to right, because that is the only order
 * anyone who has looked at the box already knows.
 *
 * **No delay.** The unit has no effects at all, so there is no `delay` here and the Echo
 * row does not draw. Do not add one by borrowing the TB-03's CC 18: on this chart 18 is
 * VCO BEND DEPTH, and it would detune the synth every time the tempo moved.
 *
 * `centsRange` on the tune is **unverified**. CC 76 is the front-panel TUNE knob and the
 * manual gives no range for it, only for the separate Master Tune setting (430-450Hz).
 * 50 is the Boutique figure and the same one the TB-03 uses. If auto-tune overshoots,
 * this is the number that is wrong — switch `In tune` off and the dial is yours.
 */
export const SH_01A: MidiDevice = {
  id: "sh-01a",
  name: "SH-01A",
  portHints: ["SH-01A"],
  tune: { cc: 76, centsRange: 50 },
  /**
   * Sounds, not settings. The thing that made every note a blip is VCA ENV with Sustain
   * at 0 and a short Decay — correct for a plucked bass, useless for anything held — so
   * each of these says what its envelope is for. CC 76 (tune) is never touched; the
   * key-following correction owns it.
   *
   * Level lives on the hardware's own VOLUME knob and no CC reaches it, so if a sound is
   * quiet, that dial is the only cure.
   */
  presets: [
    // saw 20 · pulse 19 · pw 15 · pwm src 16 · sub 21 · sub type 22 · noise 23
    // cutoff 74 · res 71 · env depth 24 · key follow 26 · A 73 · D 75 · S 30 · R 72
    // vca env 28 · lfo rate 3 · lfo wave 12 · porta 65 · porta time 5
    {
      name: "Acid",
      values: { 20: 127, 19: 0, 21: 90, 22: 0, 23: 0, 74: 46, 71: 108, 24: 100,
                26: 40, 73: 0, 75: 42, 30: 0, 72: 18, 28: 127, 65: 0 },
    },
    {
      // Cutoff has to stay high enough to pass something you can hear on a small speaker.
      // At 32 this was all fundamental and inaudible anywhere but a sub — it read as a
      // dead preset. The envelope opens the filter per note so each one has an edge.
      name: "Deep Sub",
      values: { 20: 70, 19: 0, 21: 127, 22: 0, 23: 0, 74: 60, 71: 22, 24: 48,
                26: 10, 73: 0, 75: 80, 30: 110, 72: 30, 28: 127, 65: 0 },
    },
    {
      name: "Stab",
      values: { 20: 127, 19: 95, 15: 72, 16: 0, 21: 40, 23: 0, 74: 62, 71: 78,
                24: 72, 26: 30, 73: 0, 75: 30, 30: 0, 72: 12, 28: 127, 65: 0 },
    },
    {
      name: "Rolling",
      values: { 20: 115, 19: 0, 21: 95, 23: 0, 74: 60, 71: 62, 24: 78,
                26: 35, 73: 0, 75: 58, 30: 80, 72: 24, 28: 127, 65: 0 },
    },
    {
      name: "Hoover",
      values: { 20: 127, 19: 112, 15: 64, 16: 64, 3: 42, 12: 0, 21: 0, 23: 0,
                74: 96, 71: 88, 24: 48, 26: 20, 73: 4, 75: 70, 30: 104, 72: 44, 28: 127, 65: 0 },
    },
    {
      // A slow attack is wrong under a sequencer, whatever it is called. Steps here are
      // around 90ms and the attack was most of a second, so the envelope never left the
      // floor and the preset made no sound at all. The long tail does the work instead:
      // fast attack, full sustain, long release, so the notes run into each other.
      name: "Drone",
      values: { 20: 100, 19: 0, 21: 75, 23: 12, 74: 86, 71: 24, 24: 30,
                26: 10, 73: 6, 75: 90, 30: 127, 72: 92, 28: 127, 65: 0 },
    },
    {
      name: "Pluck",
      values: { 20: 90, 19: 70, 15: 40, 16: 0, 21: 30, 23: 0, 74: 74, 71: 66,
                24: 90, 26: 50, 73: 0, 75: 22, 30: 0, 72: 10, 28: 127, 65: 0 },
    },
    {
      // The LFO on the filter rather than the pitch, which is the one modulation that
      // never sounds out of tune however far you push it.
      name: "Wobble",
      values: { 20: 127, 19: 0, 21: 80, 23: 0, 3: 30, 12: 0, 25: 96,
                74: 54, 71: 74, 24: 40, 26: 20, 73: 0, 75: 72, 30: 100, 72: 40, 28: 127, 65: 0 },
    },
    {
      name: "Glide Lead",
      values: { 20: 127, 19: 60, 15: 56, 16: 0, 21: 0, 23: 0, 74: 92, 71: 70,
                24: 44, 26: 64, 73: 2, 75: 66, 30: 110, 72: 48, 28: 127, 65: 127, 5: 40 },
    },
    {
      name: "Noise Hat",
      values: { 20: 0, 19: 0, 21: 0, 23: 127, 78: 0, 74: 110, 71: 40, 24: 60,
                26: 0, 73: 0, 75: 16, 30: 0, 72: 8, 28: 127, 65: 0 },
    },
  ],
  params: [
    { group: "LFO", label: "Rate", cc: 3, initial: 64, format: pct },
    { group: "LFO", label: "Wave", cc: 12, initial: 0 },
    { group: "LFO", label: "Mode", cc: 79, initial: 0 },

    { group: "VCO", label: "Tune", cc: 76, initial: 64 },
    { group: "VCO", label: "Range", cc: 14, initial: 64 },
    { group: "VCO", label: "Transpose", cc: 77, initial: 64 },
    { group: "VCO", label: "Mod Depth", cc: 13, initial: 0, format: pct },
    { group: "VCO", label: "Mod Sens", cc: 17, initial: 0, format: pct },
    { group: "VCO", label: "Pulse Width", cc: 15, initial: 64, format: pct },
    { group: "VCO", label: "PWM Source", cc: 16, initial: 0 },
    { group: "VCO", label: "Bend Depth", cc: 18, initial: 64, format: pct },

    { group: "Mixer", label: "Saw", cc: 20, initial: 127, format: pct },
    { group: "Mixer", label: "Pulse", cc: 19, initial: 0, format: pct },
    { group: "Mixer", label: "Sub", cc: 21, initial: 0, format: pct },
    { group: "Mixer", label: "Sub Type", cc: 22, initial: 0 },
    { group: "Mixer", label: "Noise", cc: 23, initial: 0, format: pct },
    { group: "Mixer", label: "Noise Mode", cc: 78, initial: 0 },

    { group: "VCF", label: "Cutoff", cc: 74, initial: 90, format: pct },
    { group: "VCF", label: "Resonance", cc: 71, initial: 20, format: pct },
    { group: "VCF", label: "Env Depth", cc: 24, initial: 48, format: pct },
    { group: "VCF", label: "Mod Depth", cc: 25, initial: 0, format: pct },
    { group: "VCF", label: "Key Follow", cc: 26, initial: 0, format: pct },
    { group: "VCF", label: "Bend Depth", cc: 27, initial: 0, format: pct },

    { group: "Env", label: "Attack", cc: 73, initial: 0, format: pct },
    { group: "Env", label: "Decay", cc: 75, initial: 56, format: pct },
    { group: "Env", label: "Sustain", cc: 30, initial: 0, format: pct },
    { group: "Env", label: "Release", cc: 72, initial: 24, format: pct },

    { group: "VCA", label: "Env", cc: 28, initial: 127, toggle: true, format: onOff },
    { group: "VCA", label: "Env Mode", cc: 29, initial: 0 },

    { group: "Play", label: "Portamento", cc: 65, initial: 0, toggle: true, format: onOff },
    { group: "Play", label: "Porta Time", cc: 5, initial: 0, format: pct },
    { group: "Play", label: "Porta Mode", cc: 31, initial: 0 },
    { group: "Play", label: "Assign Mode", cc: 80, initial: 0 },

    { group: "Chord", label: "Voice 2", cc: 81, initial: 0, toggle: true, format: onOff },
    { group: "Chord", label: "Shift 2", cc: 85, initial: 64 },
    { group: "Chord", label: "Voice 3", cc: 82, initial: 0, toggle: true, format: onOff },
    { group: "Chord", label: "Shift 3", cc: 86, initial: 64 },
    { group: "Chord", label: "Voice 4", cc: 83, initial: 0, toggle: true, format: onOff },
    { group: "Chord", label: "Shift 4", cc: 87, initial: 64 },
  ],
};

/**
 * Roland JP-08 — `JP-08 MIDI Implementation Chart`, Aug 2016, Version 1.01.
 *
 * Two things about this one that the other two do not have.
 *
 * **It has no master tune over MIDI.** The chart lists no CC for it; Master Tune is a
 * button combination on the unit and only reaches 433-448Hz. So there is no `tune` field
 * and the `In tune` button does not appear on this panel — the bassline rounds to the
 * nearest semitone and the leftover cents stay uncorrected. CC 23 is VCO-2 TUNE and is
 * NOT a substitute: it detunes the second oscillator against the first, so using it to
 * chase the track's pitch would beat the synth against itself instead of moving it.
 *
 * **It is two parts, and the Lower one listens one channel higher.** Roland's footnote:
 * every starred CC is received on the specified channel for Upper and on that channel + 1
 * for Lower (channel 16 wraps to 1). Sending on all sixteen channels, which is the
 * default, therefore moves both parts together — which is what you want from one row of
 * knobs. Pin the channel only if you want to edit the two halves apart.
 *
 * The CC numbers here are from the normal chart, not the second one headed
 * `JP-08 (Control Mode)`. That mode is transmit-only — it is the unit driving Roland's
 * JUPITER-8 plugin — and its numbers are completely different. Reading the wrong page of
 * the same PDF would move the wrong knob on every dial here.
 */
export const JP_08: MidiDevice = {
  id: "jp-08",
  name: "JP-08",
  portHints: ["JP-08"],
  portFallbackHints: ["Boutique"],
  delay: { timeCc: 82, maxMs: 1000 },
  // No master-tune CC, so the cents correction rides pitch bend instead. 2 semitones is
  // the Jupiter-8's own default bend range and the MIDI convention; leave the Bend Range
  // dial where it starts and this stays true.
  bend: { semitoneRange: 2 },
  /**
   * Four voices, so these lean on what the TB-03 and SH-01A cannot do. ENV-2 is the
   * amplitude envelope on a Jupiter-8 and ENV-1 the filter one, which is the opposite of
   * what the numbering suggests and the single easiest thing to get backwards here.
   */
  presets: [
    // vco1 range 19 / wave 20 · vco2 range 22 / wave 24 / tune 23 · mix 25 · hpf 26
    // cutoff 74 · res 71 · vcf env 28 · env sel 29 · slope 27 · vca 35
    // env1 A47 D52 S53 R54 · env2 A73 D75 S56 R72 · delay 82/83/91
    {
      name: "Warm Pad",
      values: { 19: 64, 20: 64, 22: 64, 24: 64, 23: 68, 25: 64, 26: 0,
                74: 70, 71: 18, 28: 30, 27: 127, 35: 100,
                47: 60, 52: 70, 53: 90, 54: 100, 73: 70, 75: 80, 56: 118, 72: 110,
                82: 60, 83: 48, 91: 44 },
    },
    {
      name: "Brass",
      values: { 19: 64, 20: 64, 22: 64, 24: 64, 23: 70, 25: 64, 26: 10,
                74: 62, 71: 40, 28: 78, 27: 127, 35: 108,
                47: 10, 52: 48, 53: 70, 54: 40, 73: 8, 75: 60, 56: 104, 72: 44,
                82: 48, 83: 30, 91: 24 },
    },
    {
      name: "Poly Bass",
      values: { 19: 32, 20: 64, 22: 32, 24: 64, 23: 64, 25: 70, 26: 0,
                74: 44, 71: 56, 28: 70, 27: 127, 35: 112,
                47: 0, 52: 44, 53: 20, 54: 20, 73: 0, 75: 64, 56: 88, 72: 26,
                82: 40, 83: 24, 91: 0 },
    },
    {
      name: "Strings",
      values: { 19: 64, 20: 64, 22: 96, 24: 64, 23: 72, 25: 64, 26: 24,
                74: 78, 71: 12, 28: 22, 27: 127, 35: 96,
                47: 76, 52: 80, 53: 100, 54: 110, 73: 84, 75: 90, 56: 122, 72: 118,
                82: 72, 83: 56, 91: 52 },
    },
    {
      name: "Stab",
      values: { 19: 64, 20: 64, 22: 64, 24: 96, 23: 66, 25: 64, 26: 16,
                74: 58, 71: 72, 28: 86, 27: 127, 35: 110,
                47: 0, 52: 32, 53: 0, 54: 18, 73: 0, 75: 34, 56: 0, 72: 20,
                82: 44, 83: 40, 91: 36 },
    },
    {
      // Flat envelopes both ends, filter wide open: the sound is the oscillators, which
      // is what an organ is.
      name: "Organ",
      values: { 19: 32, 20: 96, 22: 64, 24: 96, 23: 64, 25: 64, 26: 20,
                74: 104, 71: 8, 28: 0, 27: 0, 35: 104,
                47: 0, 52: 64, 53: 127, 54: 10, 73: 0, 75: 64, 56: 127, 72: 12,
                82: 36, 83: 20, 91: 20 },
    },
    {
      // The filter envelope doing all the work on a held chord — slow open, slow close.
      name: "Sweep",
      values: { 19: 64, 20: 64, 22: 64, 24: 64, 23: 74, 25: 64, 26: 0,
                74: 36, 71: 92, 28: 118, 27: 127, 35: 100,
                47: 90, 52: 110, 53: 60, 54: 110, 73: 50, 75: 80, 56: 120, 72: 110,
                82: 80, 83: 64, 91: 56 },
    },
    {
      name: "Sub Poly",
      values: { 19: 16, 20: 64, 22: 16, 24: 64, 23: 64, 25: 54, 26: 0,
                74: 50, 71: 24, 28: 40, 27: 127, 35: 118,
                47: 0, 52: 60, 53: 60, 54: 30, 73: 0, 75: 70, 56: 110, 72: 36,
                82: 32, 83: 16, 91: 0 },
    },
  ],
  params: [
    { group: "LFO", label: "Rate", cc: 3, initial: 64, format: pct },
    { group: "LFO", label: "Delay Time", cc: 9, initial: 0, format: pct },
    { group: "LFO", label: "Wave", cc: 12, initial: 0 },

    { group: "VCO Mod", label: "LFO Mod", cc: 13, initial: 0, format: pct },
    { group: "VCO Mod", label: "Env Mod", cc: 14, initial: 0, format: pct },
    { group: "VCO Mod", label: "Freq Mod", cc: 15, initial: 0, format: pct },
    { group: "VCO Mod", label: "PWM", cc: 16, initial: 0, format: pct },
    { group: "VCO Mod", label: "PWM Sel", cc: 17, initial: 0 },

    { group: "VCO-1", label: "Range", cc: 19, initial: 64 },
    { group: "VCO-1", label: "Wave", cc: 20, initial: 64 },
    { group: "VCO-1", label: "Cross Mod", cc: 18, initial: 0, format: pct },

    { group: "VCO-2", label: "Range", cc: 22, initial: 64 },
    { group: "VCO-2", label: "Wave", cc: 24, initial: 64 },
    { group: "VCO-2", label: "Tune", cc: 23, initial: 64 },
    { group: "VCO-2", label: "Sync", cc: 21, initial: 0, toggle: true, format: onOff },

    { group: "Mixer", label: "Source Mix", cc: 25, initial: 64, format: pct },
    { group: "Mixer", label: "HPF", cc: 26, initial: 0, format: pct },

    { group: "VCF", label: "Cutoff", cc: 74, initial: 90, format: pct },
    { group: "VCF", label: "Resonance", cc: 71, initial: 20, format: pct },
    { group: "VCF", label: "Env Mod", cc: 28, initial: 48, format: pct },
    { group: "VCF", label: "Env Sel", cc: 29, initial: 0, toggle: true, format: onOff },
    { group: "VCF", label: "LFO Mod", cc: 30, initial: 0, format: pct },
    { group: "VCF", label: "Key Follow", cc: 31, initial: 0, format: pct },
    { group: "VCF", label: "Slope", cc: 27, initial: 0, toggle: true, format: onOff },

    { group: "Env-1", label: "Attack", cc: 47, initial: 0, format: pct },
    { group: "Env-1", label: "Decay", cc: 52, initial: 56, format: pct },
    { group: "Env-1", label: "Sustain", cc: 53, initial: 0, format: pct },
    { group: "Env-1", label: "Release", cc: 54, initial: 24, format: pct },
    { group: "Env-1", label: "Polarity", cc: 55, initial: 0, toggle: true, format: onOff },

    { group: "Env-2", label: "Attack", cc: 73, initial: 0, format: pct },
    { group: "Env-2", label: "Decay", cc: 75, initial: 56, format: pct },
    { group: "Env-2", label: "Sustain", cc: 56, initial: 90, format: pct },
    { group: "Env-2", label: "Release", cc: 72, initial: 30, format: pct },
    { group: "Env-2", label: "Key Follow", cc: 57, initial: 0, format: pct },

    { group: "VCA", label: "Level", cc: 35, initial: 100, format: pct },
    { group: "VCA", label: "LFO Mod", cc: 46, initial: 0, format: pct },

    { group: "Delay", label: "Time", cc: 82, initial: 48, format: pct },
    { group: "Delay", label: "Feedback", cc: 83, initial: 32, format: pct },
    { group: "Delay", label: "Level", cc: 91, initial: 32, format: pct },

    { group: "Play", label: "Portamento", cc: 65, initial: 0, toggle: true, format: onOff },
    { group: "Play", label: "Porta Time", cc: 5, initial: 0, format: pct },
    { group: "Play", label: "Assign Mode", cc: 86, initial: 0 },
    { group: "Play", label: "Bend Range", cc: 87, initial: 64 },
    { group: "Play", label: "Dual", cc: 80, initial: 0, toggle: true, format: onOff },
    { group: "Play", label: "Part", cc: 81, initial: 0, toggle: true, format: onOff },
  ],
};

export const MIDI_DEVICES: MidiDevice[] = [TB_03, SH_01A, JP_08];

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

/**
 * There is deliberately no "armed" flag here.
 *
 * One was added and removed the same hour. Every panel is mounted all the time now, so
 * the old gate — "is this panel open" — stopped meaning anything, and a persisted switch
 * looked like the replacement. It is not: a synth that sits silent through Play All reads
 * as a broken app, and worse, the switch had already written `false` into storage before
 * its default was reconsidered, so flipping the default fixed nothing for the one person
 * using it. **Play All plays every connected synth.** To silence one, clear its line.
 */

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

/** Every panel, for the state backup. Raw, because a backup is not a reader of fields. */
export function readAllPanels(): Record<string, Partial<PanelState>> { return read(); }

/**
 * Bumped whenever the whole store is replaced from outside — a session load or an import.
 *
 * A panel flushes its patch to storage when it unmounts, and those two paths replace the
 * store and then remount the panels. The old panel's flush therefore ran AFTER the
 * restore and wrote its stale patch straight back over it, so loading a session appeared
 * to restore everything except the synths. A panel records this number when it mounts and
 * skips its parting write if it has moved.
 */
let panelStoreGeneration = 0;
export function panelStoreEpoch(): number { return panelStoreGeneration; }

export function writeAllPanels(all: Record<string, Partial<PanelState>>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota */ }
  panelStoreGeneration++;
}

export function savePanel(deviceId: string, state: PanelState): void {
  try {
    const all = read();
    all[deviceId] = state;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota */ }
}
