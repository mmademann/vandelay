import { useCallback, useEffect, useRef, useState } from "react";
import { Knob } from "./Knob";
import { cn } from "../../lib/cn";
import { midiOut } from "../../lib/midiOut";
import { loadPanel, savePanel, type MidiDevice } from "../../lib/midiDevices";

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
export function MidiSynthPanel({ device, onClose }: { device: MidiDevice; onClose: () => void }) {
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
