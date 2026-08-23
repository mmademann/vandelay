# Handoff — multi page tempo / phase / loop work

Uncommitted on `main`. ~2150 insertions across 11 files, nothing committed. `multi-state.json`
is the user's live session data, not code — **do not review or commit it** without asking.

## First thing to do

```bash
cd web && npm test        # expect 145/145 + 506/506
npx tsc --noEmit          # expect ONLY src/main.tsx(1,1) unused-React — pre-existing
npx vite build            # should succeed
node ../.claude/skills/run/drive.mjs --shots /tmp/shots   # expect errorCount 0
```

The last one launches the app in headless Chromium and drives the multi page. **`npm test`
never executes the app**; that driver is the only check that does. See `.claude/skills/run/`.

## Read this before trusting anything below

This diff is the work of three sessions. **Each one found bugs the previous one had shipped
green**, including bugs introduced by the fixes themselves. Two of mine, specifically:

- I proposed snapping the *stretch ratio* to musical values. That is wrong — the stretch is
  what holds the slot on the anchor's tempo, so snapping it desyncs. Caught before shipping.
- I defaulted `tempoRelation` to `1`, which collapsed "auto" and "explicitly the anchor's
  tempo" into one stored value and **suppressed the octave fold for every slot**. A ratio
  that should have folded to 93% shipped as 186%. The user caught it by ear; no test did.

So: treat the reasoning in this document as a map, not a perimeter, and re-derive anything
load-bearing. When a test and the user disagree, **the user is right** — that has now
resolved that way three times.

## What the feature set is

**Time stretch + tempo matching.** Slots stretch to the tempo anchor's *heard* tempo without
changing pitch, so tempo matching and key matching coexist. `Match Tempos` stretches, then
quantizes every loop to whole bars of a **per-slot** grid.

**Tempo relation** (`slot.tempoRelation`) — the slot's tempo as a multiple of the anchor's,
chosen from a per-slot dropdown: `4× slower` · `2× slower` · `¾ speed` · `Anchor tempo` ·
`1⅓ speed` · `2× faster` · `4× faster`. Exists because beat detection routinely lands on the
wrong multiple; this is the ÷2/×2 button every DJ tool ships.

Each row reads `<name> · <resulting bpm> · <stretch>% stretch` plus tags: `recommended`
(the least-stretch row, i.e. what the app picks unaided) and `off-grid` (polymetric — see
below). A `heavy stretch` tag was tried and cut as noise. **There is no separate
"Auto" row.** One was tried and was rightly called confusing: it duplicated whichever row was
selected, and the word named the mechanism rather than anything the reader is choosing
between. Selecting the `recommended` row *clears* the stored pin; selecting any other pins
it. Either way the audio matches what the row says.

The unaided choice (`autoTempoRelation`) is byte-identical to the octave fold it replaced —
`2^round(log2(raw))` — so it only ever returns powers of two and can never land on an
off-grid row.

**Phase** — a pure playhead offset. Shifts *when* a slot lands against the anchor; does not
touch loop bounds. **Move** — slides the loop *region* by ¼ bar, length unchanged.

**Delay** snaps to musical divisions off the anchor's heard tempo and re-derives (debounced
400ms) when the tempo moves. **Re-lock** re-stretches only drifted slots; `auto re-lock`
does it 600ms after the anchor settles.

Also: master speed dial, solo persistence, `rewindAll` on one timestamp, muted slots run
silently so they rejoin in phase, `worker: { format: "es" }` in `vite.config.ts` (production
builds were broken without it).

## The three time domains — read before changing anything

Nearly every bug here was one of these being confused. They differ by exactly the
playback-rate factor, so a mistake is subtle and passes per-function tests.

| Domain | Used by | Prop |
| --- | --- | --- |
| **File** (buffer seconds) | Snap, quantize, Phase, Move | `rawGridBpm` |
| **Heard** (wall clock) | Delay echoes, loop alignment | `gridBpm` |
| **Anchor's own** | the anchor's Snap | `anchorBpm` (withheld from the anchor) |

`anchorBpm` is deliberately `undefined` on the anchor. Gating anything but Snap on it
disables that control on the anchor — this regressed twice.

## The traps that have actually fired

1. **`tempoRelation` undefined ≠ `1`.** Undefined means "auto, let the fold decide". A stored
   `1` means "never fold". Collapsing them broke every slot (see above). `effectiveRelation`
   on the entry carries the resolved value for display and is **not** persisted.
2. **Phase lives only in the playhead**, so *every* re-anchor path must add it back. There are
   six: `rewindAll`, `play(fromLoopStart)`, per-slot rewind, `playSlot` and
   `startSilencedSlots` (both via `matchingLoopPosition`), and the offline render. An earlier
   version of this list named three, and the two it missed were silently dropping the offset.
   `matchingLoopPosition` must also **subtract the peer's** offset — the peer is whichever
   slot is first in the map.
3. **Quantize is destructive and has no undo.** It rewrites loop bounds in place and persists
   them. Run mid-load it rounds every loop to bars of the anchor's *guessed* BPM, because
   `detectedBpm` has not arrived and the fallback is onset autocorrelation. Both
   `quantizeAllToAnchorGrid` and `handleTempoMatchAll` now refuse while any slot is loading,
   and the transport button is disabled.
4. **`saveSlotSettings` replaces the whole record.** Five call sites; omitting a field at any
   one wipes it on the next knob turn. `surfaceCoverage` caught exactly this during the
   relation work — trust it over your own audit.
5. **`entriesRef.current` is a render behind** immediately after `setEntries`. Derive from the
   updater's `prev`, or read live values from the engine.
6. **Sessions store absolute seconds, per-slot settings store fractions.** A stretched slot
   saves seconds in its *stretched* timebase, so session load must divide by `stretch` first.
7. **The three time domains leak into the UI, not just the maths.** The grid chip and the slot
   pickers both name "the anchor's tempo". Quantize computes in *file* time; the pickers
   display *heard* time. With the anchor at Speed 0.70× those read 120 and 84 — the same bar,
   two clocks, and it looked like a bug. The chip now reports the heard tempo so the two
   surfaces agree. Any new surface naming a tempo must say which clock it is on.
8. **Auto re-lock reschedules itself.** A stretch can outlast the 600ms debounce, so a second
   cascade could start over slots the first was still rebuilding and `swapBuffer` would apply
   a ratio against a buffer already replaced. `relockInFlightRef` now allows one at a time.

## Tests

`web/src/lib/__tests__/`, wired to `npm test`.

- **`surfaceCoverage.test.mjs` (142)** reads the actual source and fails when a property is
  missing from a surface that must carry it. This is the real checklist. **Adding a property
  means adding a row.** It has now caught two live mistakes mid-development.
- **`rackSync.test.mjs` (506)** simulates a five-slot rack through the full pipeline and
  asserts what a listener would notice — whole bars in heard time, zero drift over 256 bars,
  phase durability, delay divisions, export tiling, auto re-lock convergence.

**Two limits that matter.** `rackSync` *mirrors* formulas rather than importing them (the app
code lives in React components and is not exported), so its assertions encode the belief but
cannot catch an app regression alone — `surfaceCoverage` is what enforces. And **neither
verifies sound**: a wrong BPM detection or a stretch artifact passes everything.

**An assertion can encode a wrong belief and pass.** That has happened three times here: a
phase re-anchor test written to a mistaken model, a render exemption whose stated reason went
stale, and a `rackSync` export section modelling a schedule that no longer existed. **When a
test exempts something, re-read the exemption's reason, not the pass count.**

## Not fixed — say so rather than discovering it

- **Nothing here is verified by ear.** Everything below is structural: tests, typecheck,
  build, and a clean headless run. The user does the listening and has caught three bugs the
  suites missed.
- **Export has never actually been rendered.** The phase-in-export fix is verified by tests
  and reasoning only; no file was produced and listened to.
- **Slow drift.** Loops free-run once started; rounding accumulates over many minutes. Export
  is unaffected. Rewind All resets it. Deliberately deferred — the fix is an engine redesign.
- **The `¾ speed` / `1⅓ speed` relations are off-grid by design.** Quantize skips them (`isGridSafeRelation`)
  rather than rounding them to a bar they do not share, and names them in the grid chip.
  Teaching quantize the relation so they *can* be quantized is the open follow-up.
- **Sessions saved before this work** carry old-format data. Re-save each once.
- **A stored `tempoRelation` written by the broken build may still be in the user's
  localStorage.** Selecting the `recommended` row clears it. If a slot stubbornly keeps a
  stretch that Match Tempos should have folded, that is the cause.
- **The user is not doing arithmetic and should not have to.** Several rounds here were spent
  on labels, and every one of their complaints was correct: ratio notation (`3:4`), musician's
  terms (`half time`), unlabelled numbers, a duplicated row, and the word "auto" all failed
  for the same reason — they named the mechanism instead of the outcome. Label by what is
  heard and what it costs.
- `main.tsx(1,1)` unused-React warning, pre-existing.

## Working style the user expects

- **Replies of 1–4 sentences.** They will ask for TLDR otherwise, repeatedly. They also ask
  for ELI5 — avoid jargon and ratio notation.
- **Confirm before editing** — saves trigger HMR and wipe their live audio session.
- They are doing the listening. When they say something sounds wrong, it is wrong.
- **Do not claim something works because tests pass.** State what was verified and how, and
  name what was not.
