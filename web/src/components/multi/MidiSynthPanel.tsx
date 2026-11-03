import { useCallback, useEffect, useRef, useState } from "react";
import { Knob } from "./Knob";
import { cn } from "../../lib/cn";
import { midiOut } from "../../lib/midiOut";
import { loadPanel, matchesPort, ownedByAnother, panelStoreEpoch, savePanel, type MidiDevice, type MidiParam } from "../../lib/midiDevices";
import { DELAY_DIVISIONS } from "../../lib/loopSnap";
import { MidiStepGrid } from "./MidiStepGrid";
import {
  ACCENT_VELOCITY, NORMAL_VELOCITY, STEP_COUNT,
  emptyPattern, loadPattern, savePattern, noteFor, tonicOf, type Pattern,
} from "../../lib/midiSequencer";

/**
 * A front panel for one piece of outboard gear.
 *
 * The app holds the patch, not the synth. None of these units will give a sound back over
 * SysEx, so there is nothing to read — but every parameter is writable, so what is on
 * screen IS the sound, and it survives a reload while the hardware's own memory does not
 * come into it.
 *
 * Every knob is a straight 0-127 CC. No scaling, no curves: Roland's own chart is the only
 * mapping, and inventing a second one on top would make the number under the dial disagree
 * with the number on the wire.
 */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function MidiSynthPanel({
  device,
  playing,
  anchorBpm,
  anchorKey,
  anchorPitchShift,
  onClose,
}: {
  device: MidiDevice;
  /** Whether the rack is playing. The bassline starts and stops with it. */
  playing: boolean;
  /** The anchor's heard tempo, which the synth's own delay is timed against. */
  anchorBpm: number | undefined;
  /** The key anchor's detected key, which the bassline follows. */
  anchorKey: string | null | undefined;
  /** Semitones the anchor's playback rate moves that key by. Rarely a whole number. */
  anchorPitchShift: number;
  onClose: () => void;
}) {
  // Reads the MIDI state itself rather than taking it as props: the transport owns the
  // on/off button, but nothing useful would be gained by threading ports through the page.
  const [ports, setPorts] = useState(() => midiOut.ports());
  const [enabled, setEnabled] = useState(() => midiOut.isEnabled());
  useEffect(() => midiOut.subscribe(() => {
    setPorts(midiOut.ports());
    setEnabled(midiOut.isEnabled());
  }), []);

  const stored = useRef(loadPanel(device)).current;
  const [portId, setPortId] = useState<string | undefined>(stored.portId);
  /**
   * The synth's receive channel, or 0 for all sixteen, which is the default.
   *
   * Nobody should have to know this number. It lives in the synth's own menus, cannot be
   * read back, and a wrong one looks exactly like a working connection because clock and
   * Start carry no channel and arrive anyway. Sending to every channel of one port is
   * harmless — the box ignores the fifteen that are not its — so the picker is here only
   * for a multitimbral unit, where one port really is several instruments.
   */
  const [channel, setChannel] = useState(stored.channel);
  const [values, setValues] = useState<Record<number, number>>(() => {
    const v: Record<number, number> = {};
    for (const p of device.params) v[p.cc] = stored.values[p.cc] ?? p.initial;
    return v;
  });

  /**
   * Pick the port on its own, BY NAME ONLY.
   *
   * There used to be a fallback to "the only output there is", on the grounds that a
   * driver can call a port anything and a list of one is not a choice. With three panels
   * mounted at once it is a choice — of which synth that cable goes to — and all three
   * would have grabbed the same port and played three lines down it. If nothing matches
   * by name the panel says so and you pick.
   */
  useEffect(() => {
    const held = ports.find((p) => p.id === portId);
    // A stored port is kept — EXCEPT when it is plainly another unit's. Storage outlives
    // the rule that wrote it: the JP-08 once matched "Boutique" and so adopted the port
    // called "Boutique SH-01A", and fixing the matching rule did nothing for anyone who
    // already had that id saved. Both panels went on firing down one cable, which is why
    // the first fix changed nothing. Checked every time, not once as a migration, because
    // a port id can also be re-used by a different unit after a replug.
    if (held && !ownedByAnother(device, held.name)) return;
    const guess = ports.find((p) => matchesPort(device, p.name));
    setPortId(guess ? guess.id : undefined);
  }, [ports, portId, device]);

  const [delayBeats, setDelayBeats] = useState<number | null>(stored.delayBeats);
  const [delayMaxMs, setDelayMaxMs] = useState(stored.delayMaxMs);
  /**
   * Persist the panel — debounced, with a guaranteed write on the way out.
   *
   * `values` is a new object on every knob frame, so this used to read, parse, stringify
   * and write the whole panel store sixty times a second for the length of a drag. The
   * unmount flush is not optional: a patch saved 300ms after you stop touching it is
   * fine, a patch lost because you closed the page 200ms after the last turn is not.
   */
  const panelStateRef = useRef({ portId, channel, values, delayBeats, delayMaxMs });
  panelStateRef.current = { portId, channel, values, delayBeats, delayMaxMs };
  useEffect(() => {
    const t = window.setTimeout(() => savePanel(device.id, panelStateRef.current), 300);
    return () => window.clearTimeout(t);
  }, [device.id, portId, channel, values, delayBeats, delayMaxMs]);
  // ...unless the store was replaced underneath us. See panelStoreEpoch.
  const mountedAtEpoch = useRef(panelStoreEpoch()).current;
  useEffect(() => () => {
    if (panelStoreEpoch() !== mountedAtEpoch) return;
    savePanel(device.id, panelStateRef.current);
  }, [device.id, mountedAtEpoch]);

  /**
   * While this panel is open the synth plays OUR notes and nothing else.
   *
   * Start tells a box to run its own stored pattern, and Play All used to send it one —
   * so with the bassline switched off you heard a line you had not written and could not
   * edit. Claiming the port for as long as the panel is up is the only reading of these
   * two buttons that makes sense: play means our line, stop means silence.
   */
  useEffect(() => {
    if (!portId || !enabled) return;
    midiOut.setSequenced(portId, true);
    return () => { midiOut.setSequenced(portId, false); };
  }, [portId, enabled]);

  const live = enabled && !!portId;

  const send = useCallback((cc: number, v: number) => {
    if (portId) midiOut.sendCC(portId, channel, cc, v);
  }, [portId, channel]);

  /**
   * Push the whole panel at the synth.
   *
   * The one thing a patch needs that a knob does not: the hardware powers on with whatever
   * it was last left at, and nothing tells it otherwise until a knob moves. Without this,
   * recalling a sound means wiggling every dial.
   */
  function sendAll() {
    for (const p of device.params) send(p.cc, values[p.cc] ?? p.initial);
  }

  /**
   * Load a sound.
   *
   * Only the CCs the preset names are written, so the dials it says nothing about keep
   * what you had. Sent as well as stored, because the synth has no idea what is on screen
   * until something moves — the same reason Push all exists.
   */
  function applyPreset(preset: { name: string; values: Record<number, number> }) {
    setValues((prev) => ({ ...prev, ...preset.values }));
    for (const [cc, v] of Object.entries(preset.values)) send(Number(cc), v);
  }

  /** Knobs AND the line — a reset that leaves yesterday's pattern running is half a reset. */
  function reset() {
    const v: Record<number, number> = {};
    for (const p of device.params) v[p.cc] = p.initial;
    setValues(v);
    for (const p of device.params) send(p.cc, p.initial);
    setPattern((prev) => ({ ...emptyPattern(), root: prev.root, octave: prev.octave }));
    // Everything that claims a state has to drop it too, or Reset leaves a Sound button
    // lit on a patch that is no longer that sound and an Echo row naming a division the
    // delay knob no longer holds.
    setDelayBeats(null);
    setAutoTune(true);
  }

  /**
   * The synth's own delay, timed against the anchor instead of set by hand.
   *
   * A slot's delay is ours, so we write the time in seconds and it is exact. This one
   * lives inside the box and all we can send is 0-127 on a CC whose meaning Roland never
   * published — so a division is a fraction of `delayMaxMs`, which is a guess you trim by
   * ear. Wrong guess, every division wrong by the same ratio, one number fixes it.
   *
   * Debounced for the reason the slot delay is (invariant 32): this watches the HEARD
   * tempo, and the master dial moves that continuously while you drag it.
   */
  const delay = device.delay;
  useEffect(() => {
    if (!delay || delayBeats === null || !anchorBpm || !live) return;
    const t = window.setTimeout(() => {
      const ms = delayBeats * (60000 / anchorBpm);
      const v = Math.max(0, Math.min(127, Math.round((ms / Math.max(1, delayMaxMs)) * 127)));
      setValues((prev) => (prev[delay.timeCc] === v ? prev : { ...prev, [delay.timeCc]: v }));
      send(delay.timeCc, v);
    }, 400);
    return () => window.clearTimeout(t);
  }, [delay, delayBeats, anchorBpm, delayMaxMs, live, send]);

  /**
   * Divisions long enough to be audible and short enough for the knob to reach.
   *
   * The chosen one is always in the list even when it falls outside that window. A
   * `<select>` whose value matches no option silently displays the FIRST one instead, so
   * a tempo change that pushed the division out of range made the row read "Free" while
   * the app was still sending that division — the control lying about its own state.
   */
  const echoChoices = anchorBpm
    ? DELAY_DIVISIONS.filter((d) => {
        if (d.beats === delayBeats) return true;
        const ms = d.beats * (60000 / anchorBpm);
        return ms >= 20 && ms <= delayMaxMs;
      })
    : DELAY_DIVISIONS.filter((d) => d.beats === delayBeats);

  /* ---------------------------------------------------------------- sequencer */

  const [pattern, setPattern] = useState<Pattern>(() => loadPattern(device.id));
  const [seqOn, setSeqOn] = useState(false);
  // The bassline is one more thing in the rack: Play All starts it, Pause All stops it.
  // Making it a separate transport you had to remember was the whole confusion — the
  // button below stays, but only as a way to hear the bass on its own.
  useEffect(() => { setSeqOn(playing); }, [playing]);
  const [playingStep, setPlayingStep] = useState<number | null>(null);
  useEffect(() => { savePattern(device.id, pattern); }, [device.id, pattern]);

  // Follows the key anchor unless overridden. tonicOf, NOT rootSemitone: that one folds a
  // minor to its relative major, which is right for comparing stems and wrong here — a
  // bassline rooted on C under a track in A minor is the wrong note of the right scale.
  /**
   * The key as it SOUNDS.
   *
   * A detected key describes the file. Playback rate moves it, and at the speeds this app
   * runs at that move is large and almost never a whole semitone: 0.65x is 7.46 semitones
   * down. Rooting a bassline on the detected key put it a fifth out; rooting it on the
   * rounded heard key leaves at most a quarter-tone, which `tune` below mops up.
   */
  const detected = tonicOf(anchorKey);
  const heard = detected ? detected.semitone + anchorPitchShift : null;
  const heardRoot = heard === null ? null : ((Math.round(heard) % 12) + 12) % 12;
  const heardCents = heard === null ? 0 : Math.round((heard - Math.round(heard)) * 100);
  const following = pattern.root === null;
  const root = pattern.root ?? heardRoot ?? 0;

  /**
   * Spend the synth's master tune on the part of the shift that is not a semitone.
   *
   * Switches itself off the moment that knob is touched by hand, because two things
   * writing one control is the only way this could lie about what it is set to.
   */
  /**
   * Which sound is loaded, for the lit button.
   *
   * READ OFF THE DIALS, not remembered. A name held in state is lost on reload, on a
   * session load and on a backup import — so the panel came back showing a patch with
   * nothing lit, which reads as a preset that did not save. Matching on the values means
   * the light is simply true: it goes out by itself the moment a dial that sound owns is
   * moved, and comes back if you move it back. Same rule as the Line button.
   */
  const activeSound = device.presets?.find((p) =>
    Object.entries(p.values).every(([cc, v]) => values[Number(cc)] === v),
  )?.name ?? null;

  const [autoTune, setAutoTune] = useState(true);
  const tune = device.tune;
  const bend = device.bend;
  useEffect(() => {
    if (!autoTune || !following || !live || !portId) return;
    // No master-tune CC on this unit, so bend the whole instrument instead. Same job,
    // different message — and nothing on the panel has to know the difference.
    if (!tune && bend) {
      const t = window.setTimeout(() => {
        midiOut.sendPitchBendCents(portId, channel, heardCents, bend.semitoneRange);
      }, 400);
      return () => window.clearTimeout(t);
    }
    if (!tune) return;
    // Debounced for the reason the delay re-sync is (invariant 32): this watches the
    // anchor's playback rate, and the master dial moves that every frame you drag it.
    // Writing the tune CC per frame made the knob look like it was moving on its own.
    const t = window.setTimeout(() => {
      const v = Math.max(0, Math.min(127, Math.round(64 + (heardCents / tune.centsRange) * 63)));
      setValues((prev) => (prev[tune.cc] === v ? prev : { ...prev, [tune.cc]: v }));
      send(tune.cc, v);
    }, 400);
    return () => window.clearTimeout(t);
  }, [autoTune, tune, bend, following, live, heardCents, send, portId, channel]);

  /**
   * Hold the clock up while this synth's line should sound.
   *
   * Deliberately its OWN effect, depending on nothing but whether the line is running.
   * It used to live with the stepper below, whose deps include `pattern` — so every edit
   * released the clock and took it straight back, and taking it back resets the pulse
   * counter to zero. Clicking a Mood, a cell or a Speed restarted the line from step 1.
   * Invisible during Play All, because the transport holds the clock as well and the
   * release is then a no-op, which is why it only ever happened on the solo button.
   */
  useEffect(() => {
    if (!seqOn || !enabled || !portId) return;
    // Run the clock ourselves. Needing Play All first made this button look dead whenever
    // the rack happened to be stopped, which is most of the time you are writing a line.
    midiOut.setSequencerRunning(device.id, true);
    // Silence belongs HERE, with stopping — not with the stepper below, which re-runs on
    // every edit. There it cut the sounding note each time you clicked a cell, so writing
    // a line while listening to it stuttered on every change.
    return () => {
      midiOut.setSequencerRunning(device.id, false);
      midiOut.allNotesOff(portId);
      setPlayingStep(null);
    };
  }, [seqOn, enabled, portId, device.id]);

  useEffect(() => {
    if (!seqOn || !enabled || !portId) return;
    const pending = new Set<number>();
    midiOut.setStepper(device.id, (step, atMs, stepMs) => {
      const i = ((step % STEP_COUNT) + STEP_COUNT) % STEP_COUNT;
      // Steps are scheduled up to a lookahead ahead of being heard, so light the column
      // when it actually sounds rather than when it is queued. Kept so they can be
      // cancelled: this effect re-runs on every edit, and a lookahead's worth of
      // highlights queued by the previous run would otherwise land on top of the new one
      // and walk the marker off the column that is really sounding.
      // Dropped from the set as it fires, not just on teardown: at 12 squares a beat
      // this runs ~16 times a second, and a set that only ever grew held a quarter of a
      // million dead ids after an hour of playing.
      const id: number = window.setTimeout(() => {
        pending.delete(id);
        setPlayingStep(i);
      }, Math.max(0, atMs - performance.now()));
      pending.add(id);
      const s = pattern.steps[i];
      if (!s?.on) return;
      const next = pattern.steps[(i + 1) % STEP_COUNT];
      // A glide is one note still sounding when the next arrives — on a 303 that overlap
      // IS the portamento, so hold past the step rather than sending a parameter.
      const hold = next?.slide ? stepMs * 1.6 : stepMs * 0.5;
      midiOut.sendNote(
        portId, channel,
        noteFor(pattern, s, root),
        s.accent ? ACCENT_VELOCITY : NORMAL_VELOCITY,
        atMs, hold,
      );
    }, pattern.stepsPerBeat);
    return () => {
      midiOut.setStepper(device.id, null, pattern.stepsPerBeat);
      for (const t of pending) window.clearTimeout(t);
    };
  }, [seqOn, enabled, portId, channel, pattern, root, device.id]);

  /**
   * One note, now. The only way to tell a wrong channel from a dead cable without
   * guessing — if this is silent, nothing else on this panel can work either.
   */
  function testNote() {
    if (!portId) return;
    const note = noteFor(pattern, { on: true, degree: 1, oct: 0, accent: true, slide: false }, root);
    midiOut.sendNote(portId, channel, note, ACCENT_VELOCITY, performance.now() + 10, 400);
  }

  /**
   * The parameters split into the sections printed on the unit itself, in source order.
   *
   * Forty identical circles in one wrap is not a front panel, it is a haystack — the
   * TB-03's ten were fine loose, the other two are not. A device with no groups comes out
   * as a single unnamed row, which is exactly what it was before.
   */
  const groups: [string, MidiParam[]][] = [];
  for (const p of device.params) {
    const g = p.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(p);
    else groups.push([g, [p]]);
  }

  /** One dial or switch. A straight 0-127 CC: the chart is the only mapping, and a
   *  second one invented here would make the number under the dial disagree with the
   *  number on the wire. */
  function renderParam(p: MidiParam) {
    const v = values[p.cc] ?? p.initial;
    const set = (next: number) => {
      if (tune && p.cc === tune.cc) setAutoTune(false);
      if (delay && p.cc === delay.timeCc) setDelayBeats(null);
      setValues((prev) => ({ ...prev, [p.cc]: next }));
      send(p.cc, next);
    };
    if (p.toggle) {
      return (
        <button
          key={p.cc}
          type="button"
          onClick={() => set(v >= 64 ? 0 : 127)}
          className={cn(
            "h-[62px] w-[62px] shrink-0 rounded text-[10px] font-bold uppercase leading-tight tracking-wide transition",
            v >= 64
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "bg-muted/60 text-foreground/40 hover:text-foreground",
          )}
        >
          {p.label}
          <span className="mt-0.5 block font-medium normal-case tracking-normal opacity-70">
            {p.format ? p.format(v) : v}
          </span>
        </button>
      );
    }
    return (
      <Knob
        key={p.cc}
        label={tune && p.cc === tune.cc && autoTune && following ? `${p.label} · track` : p.label}
        value={v}
        min={0}
        max={127}
        step={1}
        defaultValue={p.initial}
        size={44}
        displayValue={p.format ? p.format(v) : String(v)}
        onChange={(next) => set(Math.round(next))}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/40 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-accent">{device.name}</span>

        <select
          value={portId ?? ""}
          onChange={(e) => setPortId(e.target.value || undefined)}
          className="min-w-0 max-w-[14rem] rounded border border-border bg-muted/40 px-2 py-1 text-xs outline-none focus:border-accent/60"
        >
          <option value="">No device</option>
          {ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <span className="text-[10px] uppercase tracking-widest text-foreground/35">Channel</span>
        <select
          value={channel}
          onChange={(e) => setChannel(Number(e.target.value))}
          title="Leave this on All unless the synth is playing several parts at once. The box ignores every channel but its own."
          className="rounded border border-border bg-muted/40 px-2 py-1 text-xs tabular-nums outline-none focus:border-accent/60"
        >
          <option value={0}>All</option>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <button type="button" onClick={testNote} disabled={!live}
          title="Send a single note. If you hear nothing, the channel above is wrong."
          className="rounded bg-muted/80 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-foreground/50 transition hover:text-foreground disabled:opacity-30">
          Test note
        </button>

        {!live && (
          <span className="text-[10px] text-foreground/35">
            {!enabled ? "Turn on ♪ Clock to send" : "Pick the MIDI output above"}
          </span>
        )}

        <span className="flex-1" />

        <button type="button" onClick={sendAll} disabled={!live}
          title="Send every value below to the synth. Do this after powering it on — it has no idea what the app is showing until something moves."
          className="rounded bg-muted/80 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-foreground/50 transition hover:text-foreground disabled:opacity-30">
          Push all
        </button>
        <button type="button" onClick={reset}
          className="rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-foreground/35 transition hover:text-foreground">
          ↺ Reset
        </button>
        <button type="button" onClick={onClose}
          className="px-1 text-sm leading-none text-foreground/30 transition hover:text-foreground/70">✕</button>
      </div>

      {/* Bassline first, knobs second: the line is what you are writing, the knobs are how
          it sounds. Collapsed until switched on, so the panel stays a tone editor for
          anyone who only wants to turn the filter. */}
      <div className="flex flex-col gap-2 rounded border border-border/30 bg-background/30 p-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => setSeqOn((v) => !v)}
            disabled={!live}
            title={live
              ? "Just the bass. Play All starts it with everything else, on every connected synth."
              : "No MIDI output — pick one above"}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wide transition disabled:opacity-30",
              seqOn ? "bg-accent/25 text-accent ring-1 ring-accent/40" : "bg-muted/70 text-foreground/50 hover:text-foreground",
            )}
          >
            {seqOn ? "■ Stop bass" : "▶ Play bass"}
          </button>

          <span className="text-[10px] uppercase tracking-widest text-foreground/35">Key</span>
          <select
            value={pattern.root ?? ""}
            onChange={(e) => setPattern((p) => ({ ...p, root: e.target.value === "" ? null : Number(e.target.value) }))}
            className="rounded border border-border bg-muted/40 px-2 py-1 text-xs outline-none focus:border-accent/60"
          >
            <option value="">
              {heardRoot === null
                ? "Follow track (not detected)"
                : `Follow track (${NOTE_NAMES[heardRoot]})`}
            </option>
            {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>

          <span className="text-[10px] uppercase tracking-widest text-foreground/35">Octave</span>
          <div className="flex gap-1">
            {[1, 2, 3].map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setPattern((p) => ({ ...p, octave: o }))}
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-bold tabular-nums transition",
                  pattern.octave === o
                    ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                    : "bg-muted/60 text-foreground/40 hover:text-foreground",
                )}
              >
                {o === 1 ? "Deep" : o === 2 ? "Bass" : "Mid"}
              </button>
            ))}
          </div>

          {(tune || bend) && following && heardRoot !== null && Math.abs(heardCents) >= 3 && (
            <button
              type="button"
              onClick={() => setAutoTune((v) => !v)}
              title={`Slowing the track lands it ${Math.abs(heardCents)} cents below ${NOTE_NAMES[heardRoot]}, which is between two notes. This bends the synth to meet it.`}
              className={cn(
                "rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition",
                autoTune
                  ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                  : "bg-muted/60 text-foreground/40 hover:text-foreground",
              )}
            >
              In tune {heardCents > 0 ? "+" : "\u2212"}{Math.abs(heardCents)}&cent;
            </button>
          )}

          {!detected && pattern.root === null && (
            <span className="text-[10px] text-amber-300/80">
              No key detected on this track — pick one above
            </span>
          )}
        </div>

        <MidiStepGrid pattern={pattern} playingStep={seqOn ? playingStep : null} onChange={setPattern} />
      </div>

      {delay && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/35">Echo</span>
          <select
            value={delayBeats ?? ""}
            onChange={(e) => setDelayBeats(e.target.value === "" ? null : Number(e.target.value))}
            disabled={!anchorBpm}
            title={anchorBpm
              ? "Times the synth's own delay to the track, and keeps it there when you move the speed"
              : "Needs a tempo anchor — there is nothing to time it against"}
            className="rounded border border-border bg-muted/40 px-2 py-1 text-xs outline-none focus:border-accent/60 disabled:opacity-40"
          >
            <option value="">Free — set by hand</option>
            {echoChoices.map((d) => (
              <option key={d.beats} value={d.beats}>
                {d.label} &nbsp;({Math.round(d.beats * (60000 / (anchorBpm || 120)))} ms)
              </option>
            ))}
          </select>

          {delayBeats !== null && (
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-foreground/35">
              Longest
              <input
                type="number"
                min={50}
                max={10000}
                step={50}
                value={delayMaxMs}
                onChange={(e) => setDelayMaxMs(Math.max(50, Math.min(10000, Number(e.target.value) || 50)))}
                title="How long this synth's delay knob goes at full, in milliseconds. Roland does not publish it, so trim this by ear once and every division lands."
                className="w-[5rem] rounded border border-border bg-muted/40 px-2 py-1 text-xs tabular-nums outline-none focus:border-accent/60"
              />
              ms
            </label>
          )}

          {delayBeats !== null && (
            <span className="text-[10px] text-foreground/30">
              If the echoes sit just off the beat, nudge Longest until they lock — it is a
              guess, and it is the only one.
            </span>
          )}
        </div>
      )}

      {device.presets && device.presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="w-16 shrink-0 text-right text-[10px] font-semibold uppercase tracking-widest text-foreground/35">
            Sound
          </span>
          {device.presets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => applyPreset(p)}
              title={`Load ${p.name}. Only the dials this sound needs move; the rest stay where you left them.`}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-bold transition",
                activeSound === p.name
                  ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                  : "bg-muted/60 text-foreground/50 hover:bg-muted hover:text-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
          <span className="text-[10px] text-foreground/30">
            Volume is the knob on the box &mdash; no MIDI reaches it.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {groups.map(([name, params], i) => (
          <div key={i} className="flex flex-wrap items-start gap-x-3 gap-y-2">
            {name && (
              <span className="w-16 shrink-0 pt-4 text-right text-[10px] font-semibold uppercase tracking-widest text-foreground/30">
                {name}
              </span>
            )}
            {params.map(renderParam)}
          </div>
        ))}
      </div>
    </div>
  );

}
