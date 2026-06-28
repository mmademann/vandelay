# Vandelay — context for Claude

Personal-use "slowed + reverb" web app. Four routes: **`/`** (single track), **`/mix`** (multi-track + drums), **`/stems`** (demucs stem separation), **`/collab`** (multi-slot stem layering with dub effects).

**User-facing behavior** (features, defaults, export options): see `README.md`.  
**Implementation details** (limits, keys, presets): read the source — don't trust hardcoded values in this file.

## Stack

npm workspaces: **`/web`** (Vite, React, TS, react-router, Zustand, Tailwind, Wavesurfer, Tone.js) and **`/server`** (Express, yt-dlp, ffmpeg-static). Node version in `.nvmrc`.

## Architecture

### Server role

YouTube URLs → cached WAV on disk + `history.json` index. Browser fetches bytes via `/api/audio/*`. Local uploads never hit the server. Duration cap and extract pipeline live in `server/src/lib/extract.ts`.

### Browser role

Decode → `AudioBuffer` → real-time Tone.js playback. Offline export via `Tone.Offline`. Same effect math should drive **live playback and export** — use shared helpers (`playbackRateForEffects`, `effectiveEffects` / `appliedAudioEffects`, etc.) rather than duplicating logic in UI.

### Routing & state

- **`?v=` is the source of truth** for which tracks are loaded. Single: one id. Mix: comma-separated ids.
- Each page has a **URL→store reconciler** (`useEffect` on `?v=`): load missing ids, remove extras. UI actions **navigate**; they don't write the store directly. No two-way URL sync.
- **Zustand**: `useStore` (single), `useMixStore` (mix). Mix **persists per-id settings** to localStorage but **not** the active track list (session-only; avoids hydration races).

### Persistence (three layers)

| Layer | What | Where to look |
| --- | --- | --- |
| Server disk | YouTube WAV cache, server history index | `server/cache/`, `server/history.json` |
| IndexedDB | Raw audio bytes, track metadata (Recent) | `audioCache.ts`, `trackMetaCache.ts` |
| localStorage | Per-track settings, presets | `settings.ts`, `mixSettings.ts`, `*Presets.ts` |

Decoded `AudioBuffer`s are **in-memory only** (per session). WAV bytes and metadata survive reloads; buffers don't.

### Audio engines (singletons)

| Engine | Scope | Graph sketch |
| --- | --- | --- |
| `engine` | Single track | `Player → Distortion → EQ → Delay → Reverb → Gain → destination` |
| `mixEngine` | Per audio strip | Same chain → `Volume → PauseGain → master` |
| `drumEngine` | Drums | Synths → separate kick/hat effect chains → master |
| `collabEngine` | Per slot | `Player → Distortion → EqLo → EqMid → EqHi → Bass → TapeDelay → DualReverb → Gain → Volume → master` (+ parallel: `springConvolver → springWet → master`; `throwSend → throwDelay → throwReverb → master`) |

Loop regions are managed in engine code, not via the player's native loop points. Pitch/speed go through **`playbackRateForEffects`** on `Tone.Player`.

**Collab engine specifics**: each slot has independent playback position tracking (`startedAt` + `startOffset`). All timing uses `Tone.now()` — never mix with raw `AudioContext.currentTime`. Position formula: `loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur` (positive modulo required). `play()`/`stop()` skip already-playing/paused slots so Play All / Pause All respect individual slot states.

**Collab effects**: `TapeDelay` (in `tapeDelay.ts`) replaces `FeedbackDelay` in the collab chain — adds a feedback lowpass filter + distortion + pitch-wobble LFO controlled by `spaceEchoWow` (S.ECHO). **Big Knob** (`bigKnobWet`) drives a parallel spring reverb send (`springConvolver → springWet → master`) tapped from the slot's gain output, independent of all other effects. **3-band EQ** (`eqLo/eqMid/eqHi`) sits pre-delay so echoes inherit the EQ'd tone. **Throw** (`throwSend → throwDelay → throwReverb → master`) is a momentary gated send per slot; throw character (delay + reverb settings) is global via `ThrowSettings` in `CollabMasterSettings`.

**Lazy graph build**: audio context needs a user gesture. URL loads decode the buffer first; Tone graph builds on first Play (`ensureGraph` / `playAll`). **Re-apply settings after graph rebuild** (track switch, `engine.load`) or the chain stays at factory defaults.

### Export

- Single: `render.ts` + `encodeExport.ts`
- Mix: `renderMix.ts` + `encodeExport.ts` (respects pause/mute/effects-bypass the same way live audition should)
- Collab: `renderCollab.ts` + `encodeExport.ts` (master loop length × loop count; respects mute/solo/effects per slot)
- Format/quality options: `exportOptions.ts`

### Where code lives

```
server/src/          API routes, yt-dlp/ffmpeg extract, server history, stems library
web/src/
  pages/             Route shells + URL reconcilers
  store.ts           Single state, EFFECTS_LIMITS, effect sanitization/bypass
  mixStore.ts        Mix state
  audio/             Engines, offline render, encode
    collabEngine.ts  Per-slot playback engine (independent position tracking, effects, throw)
    collabChain.ts   Collab effects chain factory (live + offline); TapeDelay wiring, spring reverb, 3-band EQ
    tapeDelay.ts     TapeDelay class — filtered feedback + LFO wow (S.ECHO)
    renderCollab.ts  Offline render for /collab export
    graph.ts         Shared effects chain (Distortion → EQ → Delay → Reverb → Gain)
    reverbSlot.ts    DualReverb nodes + synthesizeSpringImpulse + createOfflineEqChain (single/mix)
  components/        UI (mix/ subfolder for mixer, collab/ subfolder for collab)
    collab/
      SlotStrip.tsx       Per-slot UI (waveform, knobs, presets, play/pause/rewind, THROW button)
      SlotPicker.tsx      Inline track+stem picker panel
      CollabTransport.tsx Play All / Pause All / Rewind All + export controls + Throw Character panel (floating overlay)
  lib/               Loaders, caches, persistence, format helpers, presets
    collabSettings.ts    CollabSlot/Session types, per-slot localStorage CRUD, named sessions
```

## Invariants (don't break these)

1. **URL drives loaded tracks** — navigate, don't mutate store to add/remove.
2. **Export matches audible settings** — same bypass/rate helpers as playback.
3. **Settings merge with defaults on load** — `{ ...DEFAULT_EFFECTS, ...saved }` + `sanitizeEffects()` so new fields don't break old saves.
4. **`sanitizeLoopRegion`** — clamp loop bounds to buffer duration after rounding.
5. **Mix pause = `pauseGain` to 0**, not stop — keeps phase on resume.
6. **`dispose()` / `removeTrack` hard-stops** before disconnecting — prevents ghost audio.
7. **Effects bypass preserves slider values** — `effectiveEffects` / `appliedAudioEffects` return dry/unity when disabled.
8. **Track switch / history remove** — stop engine and reconcile URL if the removed id is currently loaded.
9. **Mix `addTrack` / loaders idempotent** — StrictMode-safe.
10. **ArrayBuffers consumed by decode/IDB** — `.slice(0)` before handoff (`audioBufferStore.ts`).
11. **Collab position tracking** — always use `Tone.now()`, never `AudioContext.currentTime`. `startedAt` is set at the scheduled start time (`Tone.now() + 0.05`), not wall clock. Use positive modulo for loop wrap.
12. **Effects chain includes Distortion** — `Tone.Distortion` is the first node after Player in all engines. `wet = grit`, `distortion = Math.pow(grit, 0.5)`. `createOfflineEqChain` (single/mix, in `reverbSlot.ts`) and `createOfflineCollabEqChain` (collab, in `collabChain.ts`) both return the distortion node as the chain input.
13. **Collab `addSlot` auto-join** uses `this.running` (private flag), not `isRunning()` — so manually-paused slots don't auto-join when a new slot is added mid-session.

## Known gotchas

- `yt-dlp` on PATH; Rosetta: `arch -arm64 brew install yt-dlp`.
- YouTube blocks cloud IPs — local-only by design.
- Browsers block audio until user gesture.
- `charCodeAt` in `wav.ts` is intentional for ASCII header bytes.
- Drum pattern names (e.g. "custom") are labels; playback only cares whether pattern is off.
- Collab URL format: `?slots=trackId:stemName,trackId:stemName,...` — slot IDs are UUIDs generated at runtime, not derived from trackId+stemName.
- `GET /api/stems/library` returns all previously-separated track IDs + titles (scans `server/stems/htdemucs/`, joins with `history.json`).
- **S.ECHO does nothing at Delay wet = 0** — it only modifies echo character (darkness per repeat, saturation, pitch wobble); it is not a sound source.
- **B.KNOB is fully independent** — taps from the slot's gain output (post all effects chain) as a parallel spring reverb send; no dependency on delay, reverb, or any other knob.
- **Named session load vs. per-slot autosave**: two separate systems. `pendingSessionSlotsRef` in `CollabPage.tsx` stages session slot data before navigation so the URL reconciler reads from the session snapshot, not per-slot autosave.
- **Throw reverb decay changes require `reverb.generate()`** — debounced 300ms in `collabEngine.setThrowSettings`.

## Run

From repo root:

```bash
nvm use
npm install   # first time
npm run dev   # web + server (ports in vite.config.ts / server/src/index.ts)
```

## Out of scope

Auth, multi-user, cloud deploy, traditional database, automated tests. Deliberately personal/local.
