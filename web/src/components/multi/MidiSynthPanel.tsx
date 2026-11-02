import { useCallback, useEffect, useRef, useState } from "react";
import { Knob } from "./Knob";
import { cn } from "../../lib/cn";
import { midiOut } from "../../lib/midiOut";
import { loadPanel, savePanel, type MidiDevice } from "../../lib/midiDevices";
import { MidiStepGrid } from "./MidiStepGrid";
import {
  ACCENT_VELOCITY, NORMAL_VELOCITY, STEP_COUNT,
  loadPattern, savePattern, noteFor, tonicOf, type Pattern,
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
  anchorKey,
  onClose,
}: {
  device: MidiDevice;
  /** The key anchor's detected key, which the bassline follows. */
  anchorKey: string | null | undefined;
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

  const stored = useRef(loadPanel(device.id)).current;
  const [portId, setPortId] = useState<string | undefined>(stored.portId);
  const [values, setValues] = useState<Record<number, number>>(() => {
    const v: Record<number, number> = {};
    for (const p of device.params) v[p.cc] = stored.values[p.cc] ?? p.initial;
    return v;
  });

  // Pick the obvious port on its own. With one synth per USB cable the names are
  // unambiguous, and making you choose from a list of one is a chore, not a choice.
  useEffect(() => {
    if (portId && ports.some((p) => p.id === portId)) return;
    const guess = ports.find((p) => p.name.toLowerCase().includes(device.portHint.toLowerCase()));
    if (guess) setPortId(guess.id);
  }, [ports, portId, device.portHint]);

  useEffect(() => { savePanel(device.id, portId, values); }, [device.id, portId, values]);

  const send = useCallback((cc: number, v: number) => {
    if (portId) midiOut.sendCC(portId, 1, cc, v);
  }, [portId]);

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

  function reset() {
    const v: Record<number, number> = {};
    for (const p of device.params) v[p.cc] = p.initial;
    setValues(v);
    for (const p of device.params) send(p.cc, p.initial);
  }

  /* ---------------------------------------------------------------- sequencer */

  const [pattern, setPattern] = useState<Pattern>(() => loadPattern(device.id));
  const [seqOn, setSeqOn] = useState(false);
  const [playingStep, setPlayingStep] = useState<number | null>(null);
  useEffect(() => { savePattern(device.id, pattern); }, [device.id, pattern]);

  // Follows the key anchor unless overridden. tonicOf, NOT rootSemitone: that one folds a
  // minor to its relative major, which is right for comparing stems and wrong here — a
  // bassline rooted on C under a track in A minor is the wrong note of the right scale.
  const detected = tonicOf(anchorKey);
  const root = pattern.root ?? detected?.semitone ?? 0;

  useEffect(() => {
    if (!seqOn || !enabled || !portId) return;
    midiOut.setStepsPerBeat(pattern.stepsPerBeat);
    // Clock keeps going; Start does not, so the synth's own pattern stays parked instead
    // of playing underneath this one.
    midiOut.setSequenced(portId, true);
    midiOut.setStepCallback((step, atMs, stepMs) => {
      const i = ((step % STEP_COUNT) + STEP_COUNT) % STEP_COUNT;
      // Steps are scheduled up to a lookahead ahead of being heard, so light the column
      // when it actually sounds rather than when it is queued.
      window.setTimeout(() => setPlayingStep(i), Math.max(0, atMs - performance.now()));
      const s = pattern.steps[i];
      if (!s?.on) return;
      const next = pattern.steps[(i + 1) % STEP_COUNT];
      // A glide is one note still sounding when the next arrives — on a 303 that overlap
      // IS the portamento, so hold past the step rather than sending a parameter.
      const hold = next?.slide ? stepMs * 1.6 : stepMs * 0.5;
      midiOut.sendNote(
        portId, 1,
        noteFor(pattern, s, root),
        s.accent ? ACCENT_VELOCITY : NORMAL_VELOCITY,
        atMs, hold,
      );
    });
    return () => {
      midiOut.setStepCallback(null);
      midiOut.setSequenced(portId, false);
      midiOut.allNotesOff(portId);
      setPlayingStep(null);
    };
  }, [seqOn, enabled, portId, pattern, root]);

  const live = enabled && !!portId;

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
              ? "Play a bassline from here instead of whatever is stored on the synth"
              : "Needs MIDI on and a device picked"}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wide transition disabled:opacity-30",
              seqOn ? "bg-accent/25 text-accent ring-1 ring-accent/40" : "bg-muted/70 text-foreground/50 hover:text-foreground",
            )}
          >
            {seqOn ? "■ Bassline on" : "▶ Bassline"}
          </button>

          <span className="text-[10px] uppercase tracking-widest text-foreground/35">Key</span>
          <select
            value={pattern.root ?? ""}
            onChange={(e) => setPattern((p) => ({ ...p, root: e.target.value === "" ? null : Number(e.target.value) }))}
            className="rounded border border-border bg-muted/40 px-2 py-1 text-xs outline-none focus:border-accent/60"
          >
            <option value="">
              {detected ? `Follow track (${NOTE_NAMES[detected.semitone]})` : "Follow track (not detected)"}
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

          {!detected && pattern.root === null && (
            <span className="text-[10px] text-amber-300/80">
              No key detected on this track — pick one above
            </span>
          )}
        </div>

        <MidiStepGrid pattern={pattern} playingStep={seqOn ? playingStep : null} onChange={setPattern} />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-2">
        {device.params.map((p) => {
          const v = values[p.cc] ?? p.initial;
          const set = (next: number) => {
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
              label={p.label}
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
        })}
      </div>
    </div>
  );
}
