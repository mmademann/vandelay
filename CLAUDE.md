# Vandelay — context for Claude

Personal-use "slowed + reverb" web app. Four routes: **`/`** (multi-slot stem layering with dub effects), **`/single`** (single track), **`/mix`** (multi-track + drums), **`/stems`** (demucs stem separation). Legacy `/multi` redirects to `/`, preserving `?slots=`.

**User-facing behavior** (features, defaults, export options): see `README.md`.  
**Implementation details** (limits, keys, presets): read the source — don't trust hardcoded values in this file.

## Stack

npm workspaces: **`/web`** (Vite, React, TS, react-router, Zustand, Tailwind, Wavesurfer, Tone.js) and **`/server`** (Express, yt-dlp, ffmpeg-static). Node version in `.nvmrc`.

**No React StrictMode** — removed from `web/src/main.tsx` because audio engine singletons can't survive the dev double-mount cycle. Do not re-add it.

## Architecture

### Server role

YouTube URLs → cached WAV on disk + `history.json` index. Browser fetches bytes via `/api/audio/*`. Local uploads never hit the server. Duration cap and extract pipeline live in `server/src/lib/extract.ts`.

### Browser role

Decode → `AudioBuffer` → real-time Tone.js playback. Offline export via `Tone.Offline`. Same effect math should drive **live playback and export** — use shared helpers (`playbackRateForEffects`, `effectiveEffects` / `appliedAudioEffects`, etc.) rather than duplicating logic in UI.

### Routing & state

- **`?v=` is the source of truth** for which tracks are loaded. Single: one id. Mix: comma-separated ids.
- Each page has a **URL→store reconciler** (`useEffect` on `?v=`): load missing ids, remove extras. UI actions **navigate**; they don't write the store directly. No two-way URL sync.
- **Zustand**: `useStore` (single), `useMixStore` (mix). Mix **persists per-id settings** to localStorage but **not** the active track list (session-only; avoids hydration races).

### Persistence (four layers)

| Layer | What | Where to look |
| --- | --- | --- |
| Server disk | YouTube WAV cache, server history index | `server/cache/`, `server/history.json` |
| Server disk (multi) | Full multi state snapshot (gitignored JSON) | `multi-state.json` at repo root via `GET/POST /api/multi-state` |
| IndexedDB | Raw audio bytes, track metadata (Recent) | `audioCache.ts`, `trackMetaCache.ts` |
| localStorage | Per-track settings, presets, both anchors, master speed, active session name | `settings.ts`, `mixSettings.ts`, `*Presets.ts`, `multiSettings.ts` |

Decoded `AudioBuffer`s are **in-memory only** (per session). WAV bytes and metadata survive reloads; buffers don't.

### Audio engines (singletons)

| Engine | Scope | Graph sketch |
| --- | --- | --- |
| `engine` | Single track | `Player → Distortion → EQ → Delay → Reverb → Gain → destination` |
| `mixEngine` | Per audio strip | Same chain → `Volume → PauseGain → master` |
| `drumEngine` | Drums | Synths → separate kick/hat effect chains → master |
| `multiEngine` | Per slot | `Player → Distortion → EqLo → EqMid → EqHi → Bass → TapeDelay → DualReverb → Gain → Volume → master` (+ parallel: `springConvolver → springWet → master`; `throwSend → throwFilter → throwDelay → throwReverb → master`) |

Loop regions are managed in engine code, not via the player's native loop points. Pitch/speed go through **`playbackRateForEffects`** on `Tone.Player`.

**Multi engine specifics**: each slot has independent playback position tracking (`startedAt` + `startOffset`). All timing uses `Tone.now()` — never mix with raw `AudioContext.currentTime`. Position formula: `loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur` (positive modulo required). `play()`/`stop()` skip already-playing/paused slots so Play All / Pause All respect individual slot states.

**Multi effects**: `TapeDelay` (in `tapeDelay.ts`) replaces `FeedbackDelay` in the multi chain — adds a feedback lowpass filter + distortion + pitch-wobble LFO controlled by `spaceEchoWow` (S.ECHO knob). **Big Knob** (`bigKnobWet`) drives a parallel spring reverb send (`springConvolver → springWet → master`) tapped from the slot's gain output, independent of all other effects. **3-band EQ** (`eqLo/eqMid/eqHi`) sits pre-delay so echoes inherit the EQ'd tone. **Throw** (`throwSend → throwFilter → throwDelay → throwReverb → master`) is a momentary gated send per slot; throw character (delay + reverb settings) is global via `ThrowSettings` in `MultiMasterSettings`. The throw filter adds an env-swept resonant lowpass on the echoes.

**Lazy graph build**: audio context needs a user gesture. URL loads decode the buffer first; Tone graph builds on first Play (`ensureGraph` / `playAll`). **Re-apply settings after graph rebuild** (track switch, `engine.load`) or the chain stays at factory defaults.

**Multi pitch/speed**: `slotPlaybackRate(slot)` computes the Tone.Player `playbackRate`. When `linkPitch: true`, only `speed` drives rate; `pitch` is ignored. When `linkPitch: false`, rate = `speed * 2^(pitch/12)`. Octave shift buttons force `linkPitch: false` so pitch changes are audible.

**Loop bounds clamping**: `multiEngine.addSlot` clamps `loopStart/loopEnd` against the actual buffer duration before setting them on the Tone Player. This is the authoritative clamp — upstream code in `MultiPage` also clamps but the engine is the safety net.

### Key detection + auto-match (multi)

- **Essentia.js** runs in a **Web Worker** (`audioAnalysisWorker.ts`) — offloaded to avoid blocking the audio thread. `audioAnalysis.ts` manages the worker singleton and routes requests/responses via a pending-callback map. WASM loads once in the worker; subsequent calls reuse it. Results cached in `trackMetaCache` (`detectedKey`, `detectedBpm`). Detection is skipped if already cached (`detectedKey !== undefined`). `null` = ran and failed/low confidence.
- **Confidence threshold**: < 0.5 → show `?` badge, treat as no key for auto-match.
- **Root-semitone only**: key string (e.g. `"C# major"`) → chromatic semitone 0–11. Major/minor ignored to avoid wrong transposition between relative keys.
- **Auto-match on load**: if a reference slot is pinned, incoming slot gets `speed` + `linkPitch` copied from reference, and `pitch` offset by `refSem - tgtSem`. If either side has no detected key, speed/linkPitch are still copied but pitch stays 0.
- **`computeIsMatched`**: slot is considered matched if speed matches reference and pitch is within any octave multiple (multiples of 12) of the auto-match target. This keeps the MATCHED badge visible after octave shifts.
- **Anchor persistence**: reference slot saved to localStorage (`loadAnchorKey`/`saveAnchorKey`). Restored synchronously at the top of the URL reconciler effect (before any `await`) so all async slot loads see it. Named sessions restore reference via `pendingReferenceIdRef` instead.

### Tempo matching + time stretch (multi)

Separate from key matching and deliberately orthogonal to it: **key matching moves pitch, tempo matching moves time**, so both apply to the same slot without fighting.

- **Tempo anchor** is a second, independent anchor (`tempoAnchorId`, persisted via `loadTempoAnchorKey`/`saveTempoAnchorKey`, and on session slots as `isTempoAnchor`). Pinning a stretched slot as the anchor resets it to its own tempo — the anchor defines the grid, so it must play unstretched.
- **Stretch** (`stretchBuffer.ts`, SoundTouch) rebuilds the buffer at a new length without changing pitch. `slot.stretch` is the ratio; 1 = source. Always computed from `entry.sourceBuffer` (the untouched decode) so repeated adjustments never compound. SoundTouch holds a window internally, so the source is padded with silence and the result trimmed to `expectedFrames`.
- **`multiEngine.swapBuffer(id, buffer, ratio)`** installs a stretched buffer and rescales loop bounds *and* playhead by the same ratio. `ratio` is relative to what the engine currently holds, not to the source.
- **Match Tempos** = stretch every non-anchor slot to the anchor's BPM, then `quantizeAllToAnchorGrid()` rounds every loop (anchor included) to whole bars of the anchor's grid. Rate alone still drifts: a 3.8-bar loop and a 4-bar loop pull apart every pass however well their tempos agree. The per-slot Match Tempo button runs the same two steps via `quantizeAllToAnchorGrid(slotId)`.
- **Effective (heard) tempo**: `anchorEffectiveBpm = rawBpm × rate / stretch`, where `rate` folds in Speed, pitch-when-unlinked, and master speed. This — not the raw detected BPM — is what slaves match to and what the delay grid uses. Riding the anchor's Speed knob changes it, which is why that now marks slaves stale.
- **Tempo relation** (`slot.tempoRelation`, persisted): the slot's tempo as a multiple of the anchor's heard tempo — `TEMPO_RELATIONS` in `loopSnap.ts` is the ladder, ordered slow→fast: `Slower 4× / 2× / a bit (¾)` · `Same as anchor` · `Faster a bit (1⅓) / 2× / 4×`. Labels lead with the direction and carry the resulting BPM; ratio notation (`3:4`) and musician's terms (`half time`) were both tried and both make you stop and decode. **`tempoRelation` undefined means "auto", which is NOT the same as `1`** — a stored 1 reads as "always play at the anchor's tempo" and suppresses the octave fold, so a ratio of 1.86 that should fold to 0.93 ships as 1.86 (audibly double speed). `effectiveRelation` on the entry is the resolved value for display; only `tempoRelation` persists. Auto is what Match Tempos picks; a select beside the tempo button chooses it directly (arrows were tried and read as a mystery — you cannot see the next value, and half the ladder is polymetric). This exists because beat detection routinely lands on the wrong multiple — it is the ÷2/×2 button every DJ tool ships. A stepped slot keeps its relation across re-matches and re-locks; stale detection compares against the *chosen* relation, so half-time is not instantly dragged back to `1:1`. `gridSafe` marks the relations whose bar stays a whole multiple of the anchor's. `3:4` and `4:3` are polymetric, so `quantizeAllToAnchorGrid` **skips them** (`isGridSafeRelation`) and names them in the grid chip as `off-grid by choice` — rounding a slot to a bar it does not share produces a loop that is not a whole number of *its* bars and never repeats cleanly.
- **Stale detection**: `staleTempoIds` compares each stretched slot's ratio against what the anchor's *current* BPM implies. Mismatch → amber `↻ Re-lock Tempo`. Shares `tempoStretchRatio()` with the stretch itself so the two cannot disagree.
- **Re-lock**: the transport shows `↻ Re-lock N` only while slots are stale, and re-stretches just those (unlike Match Tempos, which rebuilds every slot). An `auto re-lock on/off` toggle, persisted, does it automatically 600ms after the anchor settles — debounced because dragging a knob would otherwise fire a cascade of buffer rebuilds per frame.
- **Phase** (`slot.phase`) is a pure *playhead* offset — it shifts **when** a slot lands against the anchor by a fraction of the anchor's bar, and never touches the loop bounds. The engine owns one implementation (`phaseOffsetFor`), exposed as `startPositionFor()` / `setPhaseBarSec()`; `applyPhase` in `SlotStrip` moves by the *difference* from the current phase via `multiEngine.nudgeSlot`.
- **Move** is the counterpart: it slides the loop **region** by ¼ bar at a time, length unchanged — so Move changes *what* is looped, Phase changes *when* it lands. It carries the playhead with the region (`updateSlot` preserves absolute position, so a bare bounds change would strand it).
- **`estimateBpm()`** (`loopSnap.ts`) measures tempo by onset autocorrelation when Essentia has no cached BPM. Costs ~30ms on a 3-minute stem, so results are memoised per buffer in a `WeakMap` (`sourceBpm`) — never call it in a render path.

### Export

- Single: `render.ts` + `encodeExport.ts`
- Mix: `renderMix.ts` + `encodeExport.ts` (respects pause/mute/effects-bypass the same way live audition should)
- Multi: `renderMulti.ts` + `encodeExport.ts` (master loop length × loop count; respects mute/solo/effects per slot)
- Format/quality options: `exportOptions.ts`

### Where code lives

```
server/src/          API routes, yt-dlp/ffmpeg extract, server history, stems library
  routes/multiState.ts  GET/POST /api/multi-state — reads/writes multi-state.json at repo root
web/src/
  main.tsx           Entry point — no StrictMode
  pages/             Route shells + URL reconcilers
  store.ts           Single state, EFFECTS_LIMITS, effect sanitization/bypass
  mixStore.ts        Mix state
  audio/             Engines, offline render, encode
    multiEngine.ts  Per-slot playback engine (independent position tracking, effects, throw)
    multiChain.ts   Multi effects chain factory (live + offline); TapeDelay wiring, spring reverb, 3-band EQ, Phaser, Chorus
    tapeDelay.ts     TapeDelay class — filtered feedback + LFO wow (S.ECHO knob)
    stretchBuffer.ts SoundTouch offline time stretch — length without pitch; pads then trims to flush the tail
    multiRecorder.ts Raw float capture of the master node — live takes, encoded via encodeExport
    renderMulti.ts  Offline render for / (multi) export
    graph.ts         Shared effects chain (Distortion → EQ → Delay → Reverb → Gain)
  workers/
    audioAnalysisWorker.ts  Essentia WASM runs here (key + BPM extraction off main thread)
    reverbSlot.ts    DualReverb nodes + synthesizeSpringImpulse + createOfflineEqChain (single/mix)
  components/        UI (mix/ subfolder for mixer, multi/ subfolder for multi)
    multi/
      SlotStrip.tsx       Per-slot UI (waveform, knobs, presets, play/pause/rewind, THROW button, key badge, octave shift, MATCHED badge)
      SlotPicker.tsx      Inline track+stem picker panel (YouTube URL input above search; youtu.be short-link parsing)
      MultiTransport.tsx Transport bar: Sessions dropdown · Play All · Rewind All · Throw (floating panel) · Match All · Export (floating panel) · Clear
  lib/               Loaders, caches, persistence, format helpers, presets
    multiSettings.ts    MultiSlot/Session types, per-slot localStorage CRUD, named sessions, anchor key, throw settings
    multiExport.ts      MultiExportFile type, buildExport/saveExportToServer/loadExportFromServer/applyImport — full state backup to server
    vibePresets.ts       GENRE_PRESETS (Dub/Lo-fi/Ambient/Dry × stem role), STEM_AUTO_PRESETS, randomizeEffects(), RANDOMIZE_RANGES
    randomCombinator.ts  buildRandomSlots() — picks one stem role per track from library, skipping non-viable stems
    audioAnalysis.ts     Web Worker manager for Essentia — analyzeAudio(), rootSemitone(), preloadEssentia()
    loopSnap.ts          snapLoop(), quantizeToGrid(), phaseShiftLoop(), estimateBpm(), DELAY_DIVISIONS, PHASE_DIVISIONS, TEMPO_RELATIONS + autoTempoRelation()/stretchForRelation()/stepTempoRelation()
    trackMetaCache.ts    IndexedDB track metadata including detectedKey/detectedBpm
```

## Multi UI layout (current)

**Transport bar** (top): `Session <name>` button (names the active session; falls back to `Sessions (N)`) · `▶ Play All` / `⏸ Pause All` (+ `Fade` half) · `⏮` (Rewind All) · `● Rec` · master speed slider · `↻ Match Tempos` (with an inline result chip after quantizing) · `↻ Re-lock N` (only while slots are stale) · `auto re-lock on/off` · `↻ Match Keys` · `↓ Export` (floating panel) · `⚄ Random` · `↯ Throw` (floating panel) · `Clear`

**Per-slot (SlotStrip)**:
- Header row: key badge (`C# min`, BPM on hover, `?` if unknown) · tempo anchor button (`⚓ Tempo Anchor` / `Set Tempo Anchor` / `Tempo 1:1 ↻` / `↻ Re-lock Tempo`) · relation select (`1:4 … 4:1`, matched or stale non-anchor slots only) · key anchor button (`⚓ Key Anchor` / `Set Key Anchor` / `Key Matched ↻` / `Match Key`) · semitone interval group (`1 7 12` + `▼▲`) · `⇥ Snap` · `Move ◀ 1/4 | 1/4 ▶` · stem/track label · track title · remove (✕)
- Knob row 1 (timing + pitch): Pitch (+ `Link`) · Speed (+ `master: on/off`) · Stretch · Phase (`0 1/8 1/4 1/3 3/8 1/2 2/3 3/4`)
- Knob row 2 (level + tone): Gain · Reverb · Decay · Delay · D.Time · D.Feedbk · Bass · Grit · Phaser · Chorus
- Waveform with loop region handles
- Footer: Play/Pause · Rewind · Throw · Reset / Presets (name · 💾 · [spacer] · ✕)

`S.Echo` and `B.Knob` are commented out in `SlotStrip.tsx` — the effects still run, only the knobs are hidden. `+ GENRE` was removed from the transport.

**SlotPicker panel**: YouTube URL input (top) → Add button · Search input · Track list with stem buttons (Drums / Bass / Vocals / Other / Full track)

## Multi URL format

```
?slots=trackId:stemName,trackId:stemName,...
?slots=trackId,...          ← bare trackId = full track slot (stemName = null)
```

Slot IDs are UUIDs generated at runtime, not derived from trackId+stemName. Parser: token with colon = stem slot; bare token = full track. Full track audio loaded from `/api/audio/{trackId}` (shared cache with single/mix pages).

## Testing

`npm test` from `/web` runs both suites. **Run it after any change to multi**, and add to it
rather than relying on the prose below — documentation drifts, these do not.

### `surfaceCoverage.test.mjs` — the checklist, enforced

Reads the actual source and fails when a slot property is missing from a surface that must
carry it. This is the real checklist; the table further down is a human-readable summary of
what it already enforces.

It holds a `PROPERTIES` table naming every persisted slot property and which surfaces it has
to reach — session snapshot, `MultiSlotSavedSettings`, every `saveSlotSettings` call site,
the engine, the offline render. **Adding a property means adding a row.** An exemption is
allowed but must carry a written reason, so "this one doesn't need to reach the engine" can
never be a silent omission.

It also pins the mistakes that have actually recurred: live and export rate math being
character-identical, the three tempo domains staying distinct, transport re-anchor paths not
subtracting an offset from `loopStart`, Phase calling `nudgeSlot` so it is audible before the
loop wraps, Phase and Move working on the **anchor** and not only on slaves (regressed
twice), and octave folding using `round(log2())` rather than a hand-picked band.

On its first run it found four real bugs: every `saveSlotSettings` call site was dropping
`bypassMasterSpeed` and `pitchInterval`.

### `rackSync.test.mjs` — the playback simulation

Models a five-slot rack with mixed speeds, stretches, phases and master speed through the
full Match Tempos pipeline, then asserts on what a listener would notice: whole-bar loops in
*heard* time, zero drift over 256 bars, equal delay divisions across slots, phase landing
where it claims, idempotent matching, gapless export tiling, offsets surviving save/reload.

Why it exists: every bug in this area came from a function that was individually correct but
used the wrong **time domain**. Per-function tests all passed while the feature was wrong.
Only a whole-system model catches that — it found the non-idempotent phase bug on its first
run.

### `.claude/skills/run/drive.mjs` — the only check that runs the real app

`npm test` never executes the app. The driver launches it in headless Chromium, drives the
transport, and now **renders a real export** and asserts the file is neither tiny nor silent
— the gap CLAUDE.md used to describe as "export has never actually been rendered". It still
says nothing about how any of it *sounds*.

### Adding to the suite

Prefer a **new property in the simulation** over a per-function test. Ask "what would a
listener notice?" and assert that, rather than asserting the arithmetic of one helper.

Prefer a **new row or rule in surfaceCoverage** over adding a line to the prose checklist. If
a rule can be enforced against the source, enforce it; if it cannot, only then write it down.

Two real limits:

- **The simulation mirrors formulas rather than importing them** — the app code lives inside
  React components and is not exported. Each mirrored function names where the real one
  lives. Change a formula in the app and you must change it in the test, or it will keep
  passing while describing code that no longer exists. `surfaceCoverage` does not have this
  problem: it reads the source directly.
- **Both verify structure and timing, not sound.** A wrong BPM detection or a stretch
  artifact passes every check. Listening remains the only test for those.

An assertion can also encode a wrong belief and pass. That happened here: a transport
assertion was written to match a mistaken idea of how Phase should re-anchor, and 84/84 went
green while the playhead landed at the end of the loop. When a test and the user disagree,
the user is right.

## Changing multi: the surface list

Summarised from what `surfaceCoverage.test.mjs` enforces — **change the test, not this table**.
It exists so you know what to think about; the test is what stops you shipping it broken.

A slot's state is consumed by many independent surfaces that do not share a code path. A
change that is obviously correct in one is routinely wrong or absent in the others.

| Surface | What to check | Where |
| --- | --- | --- |
| Live playback | Reaches the engine; audible immediately, not only after the loop wraps | `multiEngine.updateSlot`, `nudgeSlot` |
| Transport re-anchor | Survives Play All, Rewind All, unmute-into-playback | `play(fromLoopStart)`, `rewindAll`, `startSilencedSlots` |
| Per-slot play | A single slot started mid-session joins in phase | `playSlot` |
| Refresh | In `MultiSlotSavedSettings`, written by **every** `saveSlotSettings` call site | `multiSettings.ts`, decode path |
| Session save/load | In `buildSessionSlots()`; note `saved` is null on that path | `MultiPage.tsx` |
| Export | Present in the offline render, using the same helpers as live | `renderMulti.ts` |
| Recording | Taps the live master, so it inherits playback | `multiRecorder.ts` |
| Match / quantize | Preserved or deliberately recomputed by Match Tempos, Snap, Re-lock | `MultiPage.tsx` |
| Stretch | Rescaled into the new timebase, or explicitly independent of it | `reapplyStretch` |
| Anchor parity | Works on the tempo anchor, not only on slaves | `rawGridBpm` vs `anchorBpm` |

Traps that have each actually bitten:

- **`saveSlotSettings` replaces the whole record.** Omitting a field at any one of the five
  call sites wipes it on the next knob turn.
- **Session load leaves `saved` null** and supplies `pendingSlot`. Reading only `saved?.x`
  silently drops the value on every session load.
- **Session bounds are absolute seconds, per-slot settings are fractions.** A stretched slot
  saves seconds in its *stretched* timebase; session load must divide by `stretch` first.
- **`entriesRef.current` is a render behind** immediately after `setEntries`. Derive from the
  updater's `prev`, or read live values from the engine.
- **Moving loop bounds does not move the playhead.** `updateSlot` preserves position across a
  bounds change, so a change meant to be heard now needs `nudgeSlot`.
- **Three time domains.** File time, heard time, and bars. Confusing them produces an error of
  exactly the playback-rate factor, and per-function tests will not catch it.
- **`anchorBpm` is withheld from the anchor slot.** Gating anything but Snap on it disables
  that control on the anchor.

## Invariants (don't break these)

1. **URL drives loaded tracks** — navigate, don't mutate store to add/remove.
2. **Export matches audible settings** — same bypass/rate helpers as playback.
3. **Settings merge with defaults on load** — `{ ...DEFAULT_EFFECTS, ...saved }` + `sanitizeEffects()` so new fields don't break old saves.
4. **Loop bounds clamped in `addSlot`** — engine clamps `loopStart/loopEnd` against buffer duration; upstream MultiPage also clamps but engine is the safety net.
5. **Mix pause = `pauseGain` to 0**, not stop — keeps phase on resume.
6. **`dispose()` / `removeTrack` hard-stops** before disconnecting — prevents ghost audio.
7. **Effects bypass preserves slider values** — `effectiveEffects` / `appliedAudioEffects` return dry/unity when disabled.
8. **Track switch / history remove** — stop engine and reconcile URL if the removed id is currently loaded.
9. **Mix `addTrack` / loaders idempotent** — StrictMode-safe (though StrictMode is off).
10. **ArrayBuffers consumed by decode/IDB** — `.slice(0)` before handoff (`audioBufferStore.ts`).
11. **Multi position tracking** — always use `Tone.now()`, never `AudioContext.currentTime`. `startedAt` is set at the scheduled start time (`Tone.now() + 0.05`), not wall clock. Use positive modulo for loop wrap.
12. **Effects chain includes Distortion** — `Tone.Distortion` is the first node after Player in all engines. `wet = grit`, `distortion = Math.pow(grit, 0.5)`. `createOfflineEqChain` (single/mix, in `reverbSlot.ts`) and `createOfflineMultiEqChain` (multi, in `multiChain.ts`) both return the distortion node as the chain input.
13. **Multi `addSlot` auto-join** uses `this.running` (private flag), not `isRunning()` — so manually-paused slots don't auto-join when a new slot is added mid-session.
14. **Anchor restored synchronously** — `loadAnchorKey()` is called at the top of the URL reconciler effect before any `await`, and both `setReferenceSlotId` + `referenceSlotIdRef.current` are updated together so the async decode loop sees the value immediately.
15. **Octave shift forces `linkPitch: false`** — pitch changes are only audible when unlinked; octave shift buttons set `linkPitch: false` in the same patch.
16. **`computeIsMatched` allows octave multiples** — lives in `MultiPage.tsx`; uses `((diff % 12) + 12) % 12 < 0.01` so the MATCHED badge stays after octave shifts. Only speed must match exactly; linkPitch is not checked. Re-evaluated on any speed *or* pitch change — clearing only on speed left the badge on after an off-key pitch nudge.
17. **Never read `entriesRef.current` right after `setEntries`** — the ref only updates on render, so it still holds the previous array. This caused four separate bugs (stretch restore silently no-opping, quantize using pre-stretch bounds, loop fractions saved against the wrong duration, stale persist in `handleStretchChange`). Derive from the updater's `prev` callback, or read live values from the engine (`getLoopStart`/`getLoopEnd`/`getBuffer`), which `swapBuffer` keeps current.
18. **Sessions store loop bounds as absolute seconds; per-slot settings store fractions** — the two layers disagree by design. A stretched slot saves seconds in its *stretched* timebase, so session load must divide by `slot.stretch` before clamping against the freshly decoded (unstretched) buffer. Skipping the division truncated loops and compounded on every save/load cycle.
19. **Phase offsets do not scale with the buffer** — a phase is a fraction of the *anchor's* bar, and the anchor's tempo does not change when a slot is stretched. So a stretch needs no phase bookkeeping at all: `swapBuffer` rescales the loop region and the playhead, and the bar length is unchanged. Applying phase *before* a stretch is wrong for the same reason — the offset gets scaled with the buffer. `applyRestoredPhase` runs after `reapplyStretch` on the decode path.
20. **Phase lives only in the playhead, so every re-anchor path must add it back** — bounds reload from storage on their own, a read position does not. Five paths: `rewindAll`, `play(fromLoopStart)`, per-slot rewind (`startPositionFor`), and `playSlot` / `startSilencedSlots` (both via `matchingLoopPosition`). `matchingLoopPosition` must also *subtract* the peer's own offset before reading its progress — the peer is whichever slot is first in the map, so unsubtracted its phase becomes everyone else's downbeat. Missing any one of these silently returns a phased slot to the beat while the UI still shows its fraction.
21. **`saveSlotSettings` replaces the whole record** — every call site must pass `stretch`, `tempoRelation`, `phase`, `soloed`, `bypassMasterSpeed` and `pitchInterval` or a knob turn silently wipes them. There are five call sites; audit all of them when adding a field.
22. **Transport actions that must be sample-aligned read `Tone.now()` once** — `rewindAll()` and `play(instant, fromLoopStart)` apply one timestamp to every slot. Looping per-slot `seekSlot` calls re-reads the clock each time and smears the start by ~1ms across a full rack.
23. **Muted / non-soloed slots still run, silently** — they start with Play All at `-Infinity` so unmuting drops them in on the grid. Costs a voice and an effects chain per hidden slot.
24. **Blocking UI work must yield a frame first** — `stretchBuffer` and `encodeExport` are synchronous and long. Set the spinner state, `await` a frame (`requestAnimationFrame` + `setTimeout`), *then* start the work, or the state is set but never painted and the UI just appears frozen.

25. **Solo persists alongside mute** — `soloed` is in `MultiSlotSavedSettings` and every `saveSlotSettings` writer. It was missing for a long time, so a soloed slot came back with everything audible.
26. **Per-slot play joins in phase** — `playSlot` and `startSilencedSlots` both derive their start from `matchingLoopPosition()`, a peer's progress through its own loop. Resuming from the slot's parked `startOffset` put it off the shared downbeat with nothing in the UI to say so. That helper applies the phase offset too — see invariant 20.
27. **`worker.format: "es"` in `vite.config.ts` is load-bearing** — the analysis worker dynamically imports Essentia, which forces a code-split, and Vite's default IIFE worker format cannot code-split. Removing it breaks `vite build` while leaving dev working.

28a. **One grid helper, four consumers** — `anchorBarGridBpm(anchorRaw, anchorSlot, slot,
    masterSpeed)` in `MultiPage.tsx` returns the anchor's bar measured in *that slot's* buffer
    seconds (`anchorRaw × anchorRate / slotRate`). **Phase, Move, Snap and quantize must all
    use it.** Quantize did and the other three did not, so a slot carrying its own Speed was
    quantized to one bar and phased/snapped against another — a ½-bar Phase landing ~7% early
    at Speed 0.70 against 0.75. Master speed hides this (it scales both sides equally); a
    Speed knob or an unlinked Pitch does not. It reaches the engine as `phaseBarSec`, which is
    also what the offline render reads, so getting it wrong desyncs exports too.
28b. **Joining a running rack is matched in bars, not loop fractions** —
    `multiEngine.matchingLoopPosition` converts the peer's progress through `phaseBarSec`.
    A fraction is only a musical position when both loops are the same length: 30% of a 4-bar
    loop is 1.2 bars, 30% of a 6-bar loop is 1.8 — the joining slot lands 0.6 of a bar off the
    beat. Falls back to the fraction when no bar length is known.
29. **Quantize uses a per-slot grid, not one shared BPM** — bars must be equal in *heard*
    time, and every slot plays at a different rate. `slotGridBpm = anchorRawBpm × (anchorRate
    / slotRate)`. Quantizing every slot to the same file-domain bar made bars last different
    wall-clock durations — 6s of drift over 32 bars at Speed 0.70 vs 0.75, while every slot
    still displayed `TEMPO MATCHED`.
30. **Quantize rounds the region only — it must not touch phase** — live loop bounds are
    already un-phased (the offset lives in the playhead), so quantize just rounds them.
    Adding the offset here as well applies it twice, and a phased slot walks forward one
    phase step on every Match Tempos. This was the bug that made phase a bounds shift in
    the first place; keep the two separate.
31. **Tempo matching picks a *relation*, and the automatic choice must stay the unbounded
    octave fold** — `autoTempoRelation` returns `2^round(log2(targetBpm/anchorBpm))`, which
    keeps the stretch inside `[1/√2, √2]` for any input. The old `while (s > 1.45) s /= 2;
    while (s < 0.7) s *= 2` band spanned 2.07×, so a 1 BPM difference flipped the result by a
    factor of two (127→1.440 but 128→0.726) and the same track matched at 130% one session
    and 93% the next. Two things that look like improvements are not: searching
    `TEMPO_RELATIONS` instead of rounding the log2 cannot fold a ratio beyond the ladder's
    ends, and letting `3:4`/`4:3` into the automatic set makes polymeter the default, because
    they almost always need a *smaller* stretch than `1:1`.
32. **Delay re-sync must be debounced** — it watches the heard tempo, which master speed and
    Speed both move continuously while dragging. Rewriting `delayTime` per frame pushed a new
    value into the audio graph every frame and was audible as the delay warbling. 400ms.
33. **The anchor's grid applies to every slot, matched or not** — a shared grid is the point
    of a tempo anchor. Giving an unmatched slot its own delay grid was tried and reverted: it
    made that slot's echoes sound isolated from the rest of the rack.

## Known gotchas

- `yt-dlp` on PATH; Rosetta: `arch -arm64 brew install yt-dlp`.
- YouTube blocks cloud IPs — local-only by design.
- Browsers block audio until user gesture. Tone.js creates its AudioContext eagerly on module import — the "AudioContext not allowed to start" console warnings on page load are expected and stop once the user clicks Play.
- `charCodeAt` in `wav.ts` is intentional for ASCII header bytes.
- Drum pattern names (e.g. "custom") are labels; playback only cares whether pattern is off.
- Multi URL format: `?slots=trackId:stemName,...` — slot IDs are UUIDs generated at runtime, not derived from trackId+stemName.
- `GET /api/stems/library` returns all previously-separated track IDs + titles (scans `server/stems/htdemucs/`, joins with `history.json`).
- **Delay re-syncs when the tempo moves** — `delayTime` is stored in seconds, so a tempo change silently stops it being the division it claims to be. `SlotStrip` watches `delayBpm` and re-derives the time from whichever division the value currently sits on. Only corrects values already within 5ms of a division, so a deliberately free delay is left alone.
- **Delay time snaps to musical divisions** — `snapDelayToTempo()` rounds `delayTime` to the nearest division of the anchor's bar (`DELAY_DIVISIONS`, 1/32 through 2 bars, including dotted and triplet). Labels are spelled out (`1/16 dot`, `1/8 trip`) because a trailing `.` was invisible and read as a duplicate entry. Arrow keys step by division *index* via `stepDelayDivision()` — a fixed seconds step is either too small to escape the current division (the snap pulls it back, so the key looks dead) or large enough to skip several.
- **Three tempo props, three time domains** — getting these confused has caused the same bug twice. `anchorBpm` is the anchor's raw tempo, deliberately withheld from the anchor slot so its Snap uses its own; `gridBpm` is the *heard* tempo (raw × speed × master ÷ stretch) and drives **Delay**, because an echo happens in real time; `rawGridBpm` is the *file* tempo including the anchor and drives **Phase**, because loop bounds are buffer positions that playback rate does not move. Snap and quantize also work in file time. Using the heard tempo for Phase, or the raw tempo for Delay, is wrong by exactly the speed factor.
- **S.ECHO (Space Echo) does nothing at Delay = 0** — it only modifies echo character (darkness per repeat, saturation, pitch wobble via LFO); it is not a sound source. "Delay" in the UI = `delayWet`.
- **B.KNOB is fully independent** — taps from the slot's gain output (post all effects chain) as a parallel spring reverb send; no dependency on Delay, Reverb, or any other knob.
- **Named session load vs. per-slot autosave**: two separate systems. `pendingSessionSlotsRef` in `MultiPage.tsx` stages session slot data before navigation so the URL reconciler reads from the session snapshot, not per-slot autosave. `isReference` is stored in named sessions only, not per-slot autosave.
- **Throw reverb decay changes require `reverb.generate()`** — debounced 300ms in `multiEngine.setThrowSettings`.
- **youtu.be short-link parsing**: `extractVideoId()` in `SlotPicker.tsx` handles both `youtube.com/watch?v=ID` and `youtu.be/ID` formats.
- **Viability map**: `viabilityMapRef` in `MultiPage` tracks `"trackId:stemName" → boolean` for whether a stem has meaningful audio (via `computeStemViability`). Used by `buildRandomSlots` to skip dead stems in RANDOM sessions. Populated lazily as stems load — absence means uncached (included), `false` means explicitly non-viable (skipped).
- **`SlotStrip.update()` vs `onChange()`**: always call the local `update()` function (engine + state + persist) not `onChange()` directly (state only) when changing slot properties from within SlotStrip.
- **`rawContext.createConvolver()` required in offline context**: always use `Tone.getContext().rawContext.createConvolver()`, not `Tone.getContext().createConvolver()`. The latter delegates silently in the live context but breaks in `Tone.Offline()`, so spring reverb drops from exports. See `multiChain.ts`.
- **Tone.js context config is module-level in `multiEngine.ts`**: `Tone.setContext(new Tone.Context({ latencyHint: "playback", lookAhead: 0.3, updateInterval: 0.08 }))` runs before any imports that create nodes. Do not move it or duplicate it — must stay at the very top of that file.
- **POST `/api/stems` returns 202 (not 200) when separation is needed**: blocks only for `extractAudio` (WAV download), then fires demucs in the background and returns immediately. Client polls `GET /api/stems/:id/status` every 2s. Returns 200 with full data only when already fully cached.
- **Multi state backup**: `buildExport(masterSettings)` + `saveExportToServer()` in `multiExport.ts` snapshot all localStorage multi keys to `multi-state.json` at repo root. Auto-fires on page unmount (if any slots loaded). Import via Sessions panel `↑ Import` button — writes localStorage then syncs live React state.

## Run

From repo root:

```bash
nvm use
npm install   # first time
npm run dev   # web + server (ports in vite.config.ts / server/src/index.ts)
```

## Out of scope

Auth, multi-user, cloud deploy, traditional database. Deliberately personal/local.

No general test suite either. The two files under `web/src/lib/__tests__/` are the exception
— see **Testing** — and cover only the multi timing/persistence area, which proved impossible
to get right by inspection.
