---
name: run
description: Launch the Vandelay dev servers and drive the multi page in a headless browser to confirm a change works in the real app. Use when asked to run, start, or smoke-test the app, or to verify multi-page audio/transport behaviour beyond `npm test`.
---

# Running Vandelay

`npm test` verifies structure and timing by reading source and simulating a rack. It never
executes the app. This skill covers the other half: does the thing actually boot, decode
audio, build the Tone graph, and survive the transport without throwing.

Neither checks how anything **sounds**. That is still the user's ears — say so rather than
reporting "works".

## Start the servers

```bash
nvm use && npm run dev      # from repo root — server on 5174, web on 5173
```

Poll, don't sleep. Vite compiles on demand and the first load is slow:

```bash
timeout 60 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

**Check first whether they are already running** — the user usually has them up:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

If so, drive that instance instead of starting another (5173 is fixed in `vite.config.ts`,
so a second copy silently lands on 5174+ and proxies nowhere). Stop with
`lsof -ti:5173 -sTCP:LISTEN | xargs kill` — never a broad `pkill -f node`.

**Editing a file mid-run invalidates the run.** Saves trigger HMR, which rebuilds the page
and wipes the audio session. Finish driving before you edit.

## Drive it

`playwright-core` is deliberately **not** a repo dependency — this is a personal local app
and `package.json` should stay clean. Install it out of tree:

```bash
S=/tmp/vandelay-drive
mkdir -p $S && (cd $S && npm init -y >/dev/null && npm i playwright-core)
node skills/run/drive.mjs --shots /tmp/vandelay-shots     # run from the repo root
```

`drive.mjs` finds that install on its own (`$PLAYWRIGHT_CORE`, then a bare specifier, then
the path above). ESM ignores `NODE_PATH`, so pointing at it that way silently fails.

`drive.mjs` loads two real stems, pins a tempo anchor, plays, applies Phase and Move,
rewinds, mutes/unmutes, runs Match Tempos, and screenshots each stage. It prints JSON:
per-step ok/FAILED, a position readout per slot, and every page error and 4xx.

Flags: `--slots "id:drums,id:bass"` (default: first two tracks from
`GET /api/stems/library`), `--url`, `--api`, `--shots`.

**Exit code is 1 on any uncaught page error.** A clean exit is necessary, not sufficient —
**open the screenshots**. A page renders its shell perfectly while every slot fails to
decode, and only the picture shows you the empty rack.

## Gotchas that cost real time

- **`waitForFunction` on canvas count, not `waitForLoadState("networkidle")`.** One
  waveform canvas appears per decoded slot; decode is a full-WAV fetch. Idle never settles.
- **Audio does nothing until Play All is clicked.** The Tone graph builds lazily on the
  first user gesture (CLAUDE.md, "Lazy graph build"). Anything asserted before that click is
  measuring an unbuilt graph.
- **`--autoplay-policy=no-user-gesture-required` is required** even though the app gates on
  a click — without it the headless context stays suspended and every position reads 0.
- **The position readout is whole seconds.** Fine for "is this slot grossly adrift", useless
  for sub-second checks like a Phase offset. For those, compare the *shape* across
  screenshots or add an instrumented readout — don't over-read the text.
- **You cannot reach the engine singleton from the page.** `await
  import("/src/audio/multiEngine.ts")` in `page.evaluate` returns a *second* module
  instance with an empty `slots` map, not the one the UI is using. Tried; it does not work.
  Instrument the app temporarily if you need engine internals.
- **Playwright's browser path carries a pinned revision** (`chromium-1228/...`) that changes
  on upgrade. `findBrowser()` globs for it and falls back to system Chrome.
- **Match Tempos takes ~8s for two slots.** `stretchBuffer` is synchronous per slot.
- **Buttons whose label changes on click break a stored locator.** `MUTE` becomes `MUTED`,
  `PLAY` becomes `PAUSE`. A locator anchored to the old text re-resolves to a *different
  slot's* button on the second click — muting two slots while the step still reports ok.
  Match both states (`/^\\W*MUTED?$/i`) and pin the slot with `.nth(i)`.
- **The app ships no favicon**, so `/favicon.ico` 404s on every load. Filtered in the
  driver; don't report it as a finding.

## What to report

The step JSON, whether you looked at the screenshots, and what remains unverified. The
recurring failure mode in this repo is a change that works where it was written and is
silently wrong on a surface nobody re-checked — so name the surfaces you did not exercise.
