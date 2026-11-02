import { cn } from "../../lib/cn";
import { STARTERS, STEP_COUNT, SCALES, type Pattern, type ScaleName } from "../../lib/midiSequencer";

/**
 * A bassline grid you can use without knowing anything about the synth.
 *
 * Two rules make that true. **Every cell is in key** — the rows are scale degrees, not
 * notes, so there is no wrong button to press and the whole line re-pitches itself when
 * the key anchor changes. And **it never starts empty**: a blank grid is only useful to
 * someone who already knows the idiom, which is the thing this is supposed to spare you.
 *
 * The words are the plain ones. "Louder" and "Glide", not accent and slide — those are
 * 303 vocabulary, and the point is not to have to learn it.
 */

/** Rows, high to low: the octave above, then the seven degrees of the scale. */
const ROWS = [
  { degree: 1, oct: 1, label: "high" },
  { degree: 7, oct: 0, label: "" },
  { degree: 6, oct: 0, label: "" },
  { degree: 5, oct: 0, label: "" },
  { degree: 4, oct: 0, label: "" },
  { degree: 3, oct: 0, label: "" },
  { degree: 2, oct: 0, label: "" },
  { degree: 1, oct: 0, label: "low" },
];

const SCALE_LABEL: Record<ScaleName, string> = {
  minor: "Dark",
  phrygian: "Darker",
  major: "Bright",
};

export function MidiStepGrid({
  pattern,
  playingStep,
  onChange,
}: {
  pattern: Pattern;
  /** Which step is sounding right now, or null when stopped. */
  playingStep: number | null;
  onChange: (p: Pattern) => void;
}) {
  const setStep = (i: number, patch: Partial<Pattern["steps"][number]>) => {
    const steps = pattern.steps.map((s, j) => (j === i ? { ...s, ...patch } : s));
    onChange({ ...pattern, steps });
  };

  /** Clicking the cell a note already sits on clears it; anywhere else moves it there. */
  const toggleCell = (i: number, degree: number, oct: number) => {
    const s = pattern.steps[i];
    if (s.on && s.degree === degree && s.oct === oct) setStep(i, { on: false });
    else setStep(i, { on: true, degree, oct });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/35">Line</span>
        {STARTERS.map((st) => (
          <button
            key={st.name}
            type="button"
            onClick={() => onChange({ ...st.pattern, root: pattern.root, octave: pattern.octave })}
            className="rounded bg-muted/60 px-2 py-1 text-[11px] font-bold text-foreground/50 transition hover:bg-muted hover:text-foreground"
          >
            {st.name}
          </button>
        ))}

        <span className="ml-2 text-[10px] font-semibold uppercase tracking-widest text-foreground/35">Mood</span>
        {(Object.keys(SCALES) as ScaleName[]).map((sc) => (
          <button
            key={sc}
            type="button"
            onClick={() => onChange({ ...pattern, scale: sc })}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-bold transition",
              pattern.scale === sc
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-muted/60 text-foreground/40 hover:text-foreground",
            )}
          >
            {SCALE_LABEL[sc]}
          </button>
        ))}

        <span className="ml-2 text-[10px] font-semibold uppercase tracking-widest text-foreground/35">Speed</span>
        {[
          { n: 2, label: "Slow" },
          { n: 4, label: "Normal" },
          { n: 8, label: "Fast" },
        ].map((o) => (
          <button
            key={o.n}
            type="button"
            onClick={() => onChange({ ...pattern, stepsPerBeat: o.n })}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-bold transition",
              pattern.stepsPerBeat === o.n
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-muted/60 text-foreground/40 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* The grid. Rows are pitch, high at the top, and every one of them is in key. */}
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-full flex-col gap-[2px]">
          {ROWS.map((row) => (
            <div key={`${row.degree}-${row.oct}`} className="flex items-center gap-[2px]">
              <span className="w-7 shrink-0 text-right text-[8px] uppercase tracking-wide text-foreground/25">
                {row.label}
              </span>
              {pattern.steps.map((s, i) => {
                const lit = s.on && s.degree === row.degree && s.oct === row.oct;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleCell(i, row.degree, row.oct)}
                    title={`Step ${i + 1}`}
                    className={cn(
                      "h-[18px] min-w-[18px] flex-1 rounded-[2px] transition",
                      lit
                        ? s.accent ? "bg-accent" : "bg-accent/55"
                        : i % 4 === 0 ? "bg-muted/70 hover:bg-muted" : "bg-muted/35 hover:bg-muted/60",
                      playingStep === i && "ring-1 ring-foreground/40",
                    )}
                  />
                );
              })}
            </div>
          ))}

          {/* Per-step switches, under the column they belong to. */}
          {([
            ["accent", "Louder"],
            ["slide", "Glide"],
          ] as const).map(([field, label]) => (
            <div key={field} className="mt-[3px] flex items-center gap-[2px]">
              <span className="w-7 shrink-0 text-right text-[8px] uppercase tracking-wide text-foreground/25">
                {label}
              </span>
              {pattern.steps.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setStep(i, { [field]: !s[field] } as Partial<Pattern["steps"][number]>)}
                  title={`${label} on step ${i + 1}`}
                  className={cn(
                    "h-[12px] min-w-[18px] flex-1 rounded-[2px] transition",
                    s[field] ? "bg-amber-400/70" : i % 4 === 0 ? "bg-muted/60 hover:bg-muted" : "bg-muted/25 hover:bg-muted/50",
                  )}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <p className="text-[10px] leading-snug text-foreground/30">
        Click a square to place a note, click it again to clear it. Higher row, higher note —
        every one is in your track&rsquo;s key, so there is nothing wrong you can press.
        <span className="text-amber-400/70"> Louder</span> hits harder;
        <span className="text-amber-400/70"> Glide</span> slurs into the note from the one before.
      </p>
    </div>
  );
}

export { STEP_COUNT };
