# Vandelay — context for Claude

Personal-use "slowed + reverb" web app. Four routes: **`/`** (single track), **`/mix`** (multi-track + drums), **`/stems`** (demucs stem separation), **`/collab`** (multi-slot stem layering with dub effects).

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
| `collabEngine` | Per slot | `Player → Distortion → EqLo → EqMid → EqHi → Bass → TapeDelay → DualReverb → Gain → Volume → master` (+ parallel: `springConvolver → springWet → master`; `throwSend → throwFilter → throwDelay → throwReverb → master`) |

Loop regions are managed in engine code, not via the player's native loop points. Pitch/speed go through **`playbackRateForEffects`** on `Tone.Player`.

**Collab engine specifics**: each slot has independent playback position tracking (`startedAt` + `startOffset`). All timing uses `Tone.now()` — never mix with raw `AudioContext.currentTime`. Position formula: `loopStart + ((offsetInLoop + elapsed) % loopDur + loopDur) % loopDur` (positive modulo required). `play()`/`stop()` skip already-playing/paused slots so Play All / Pause All respect individual slot states.

**Collab effects**: `TapeDelay` (in `tapeDelay.ts`) replaces `FeedbackDelay` in the collab chain — adds a feedback lowpass filter + distortion + pitch-wobble LFO controlled by `spaceEchoWow` (S.ECHO knob). **Big Knob** (`bigKnobWet`) drives a parallel spring reverb send (`springConvolver → springWet → master`) tapped from the slot's gain output, independent of all other effects. **3-band EQ** (`eqLo/eqMid/eqHi`) sits pre-delay so echoes inherit the EQ'd tone. **Throw** (`throwSend → throwFilter → throwDelay → throwReverb → master`) is a momentary gated send per slot; throw character (delay + reverb settings) is global via `ThrowSettings` in `CollabMasterSettings`. The throw filter adds an env-swept resonant lowpass on the echoes.

**Lazy graph build**: audio context needs a user gesture. URL loads decode the buffer first; Tone graph builds on first Play (`ensureGraph` / `playAll`). **Re-apply settings after graph rebuild** (track switch, `engine.load`) or the chain stays at factory defaults.

**Collab pitch/speed**: `slotPlaybackRate(slot)` computes the Tone.Player `playbackRate`. When `linkPitch: true`, only `speed` drives rate; `pitch` is ignored. When `linkPitch: false`, rate = `speed * 2^(pitch/12)`. Octave shift buttons force `linkPitch: false` so pitch changes are audible.

**Loop bounds clamping**: `collabEngine.addSlot` clamps `loopStart/loopEnd` against the actual buffer duration before setting them on the Tone Player. This is the authoritative clamp — upstream code in `CollabPage` also clamps but the engine is the safety net.

### Key detection + auto-match (collab)

- **Essentia.js** (WASM, lazy-loaded) runs `KeyExtractor` + `RhythmExtractor2013` on each decoded buffer. Results cached in `trackMetaCache` (`detectedKey`, `detectedBpm`). Detection is skipped if already cached (`detectedKey !== undefined`). `null` = ran and failed/low confidence.
- **Confidence threshold**: < 0.5 → show `?` badge, treat as no key for auto-match.
- **Root-semitone only**: key string (e.g. `"C# major"`) → chromatic semitone 0–11. Major/minor ignored to avoid wrong transposition between relative keys.
- **Auto-match on load**: if a reference slot is pinned, incoming slot gets `speed` + `linkPitch` copied from reference, and `pitch` offset by `refSem - tgtSem`. If either side has no detected key, speed/linkPitch are still copied but pitch stays 0.
- **`computeIsMatched`**: slot is considered matched if speed matches reference and pitch is within any octave multiple (multiples of 12) of the auto-match target. This keeps the MATCHED badge visible after octave shifts.
- **Anchor persistence**: reference slot saved to localStorage (`loadAnchorKey`/`saveAnchorKey`). Restored synchronously at the top of the URL reconciler effect (before any `await`) so all async slot loads see it. Named sessions restore reference via `pendingReferenceIdRef` instead.

### Export

- Single: `render.ts` + `encodeExport.ts`
- Mix: `renderMix.ts` + `encodeExport.ts` (respects pause/mute/effects-bypass the same way live audition should)
- Collab: `renderCollab.ts` + `encodeExport.ts` (master loop length × loop count; respects mute/solo/effects per slot)
- Format/quality options: `exportOptions.ts`

### Where code lives

```
server/src/          API routes, yt-dlp/ffmpeg extract, server history, stems library
web/src/
  main.tsx           Entry point — no StrictMode
  pages/             Route shells + URL reconcilers
  store.ts           Single state, EFFECTS_LIMITS, effect sanitization/bypass
  mixStore.ts        Mix state
  audio/             Engines, offline render, encode
    collabEngine.ts  Per-slot playback engine (independent position tracking, effects, throw)
    collabChain.ts   Collab effects chain factory (live + offline); TapeDelay wiring, spring reverb, 3-band EQ, Phaser, Chorus
    tapeDelay.ts     TapeDelay class — filtered feedback + LFO wow (S.ECHO knob)
    renderCollab.ts  Offline render for /collab export
    graph.ts         Shared effects chain (Distortion → EQ → Delay → Reverb → Gain)
    reverbSlot.ts    DualReverb nodes + synthesizeSpringImpulse + createOfflineEqChain (single/mix)
  components/        UI (mix/ subfolder for mixer, collab/ subfolder for collab)
    collab/
      SlotStrip.tsx       Per-slot UI (waveform, knobs, presets, play/pause/rewind, THROW button, key badge, octave shift, MATCHED badge)
      SlotPicker.tsx      Inline track+stem picker panel (YouTube URL input above search; youtu.be short-link parsing)
      CollabTransport.tsx Transport bar: Sessions dropdown · Play All · Rewind All · Throw (floating panel) · Match All · Export (floating panel) · Clear
  lib/               Loaders, caches, persistence, format helpers, presets
    collabSettings.ts    CollabSlot/Session types, per-slot localStorage CRUD, named sessions, anchor key, throw settings
    audioAnalysis.ts     Essentia.js wrapper — analyzeAudio(), rootSemitone(), preloadEssentia()
    trackMetaCache.ts    IndexedDB track metadata including detectedKey/detectedBpm
```

## Collab UI layout (current)

**Transport bar** (top): `Sessions (N)` button (dropdown) · `▶ Play All` · `⏮ Rewind All` · `↯ Throw` (floating panel) · `Match All to Anchor` (visible when reference pinned + ≥2 slots) · `↓ Export` (floating panel) · `Clear`

**Per-slot (SlotStrip)**:
- Header row: key badge (`C# min`, BPM on hover, `?` if unknown) · `Set Key Anchor` / `Key Anchor ✓` button · `MATCH` button (hidden when already matched or this is the reference) · `MATCHED ▼ ▲` badge (octave shift buttons, visible when matched) · stem/track label · track title · remove (✕)
- Knob rows: Speed · Pitch · Link · Gain / Delay · Reverb · B.Knob / S.Echo · EqLo · EqMid · EqHi / Bass · Grit · Phaser · Chorus
- Waveform with loop region handles
- Footer: Play/Pause · Rewind · Throw · Reset / Presets (name · 💾 · [spacer] · ✕)

**SlotPicker panel**: YouTube URL input (top) → Add button · Search input · Track list with stem buttons (Drums / Bass / Vocals / Other / Full track)

## Collab URL format

```
?slots=trackId:stemName,trackId:stemName,...
?slots=trackId,...          ← bare trackId = full track slot (stemName = null)
```

Slot IDs are UUIDs generated at runtime, not derived from trackId+stemName. Parser: token with colon = stem slot; bare token = full track. Full track audio loaded from `/api/audio/{trackId}` (shared cache with single/mix pages).

## Invariants (don't break these)

1. **URL drives loaded tracks** — navigate, don't mutate store to add/remove.
2. **Export matches audible settings** — same bypass/rate helpers as playback.
3. **Settings merge with defaults on load** — `{ ...DEFAULT_EFFECTS, ...saved }` + `sanitizeEffects()` so new fields don't break old saves.
4. **Loop bounds clamped in `addSlot`** — engine clamps `loopStart/loopEnd` against buffer duration; upstream CollabPage also clamps but engine is the safety net.
5. **Mix pause = `pauseGain` to 0**, not stop — keeps phase on resume.
6. **`dispose()` / `removeTrack` hard-stops** before disconnecting — prevents ghost audio.
7. **Effects bypass preserves slider values** — `effectiveEffects` / `appliedAudioEffects` return dry/unity when disabled.
8. **Track switch / history remove** — stop engine and reconcile URL if the removed id is currently loaded.
9. **Mix `addTrack` / loaders idempotent** — StrictMode-safe (though StrictMode is off).
10. **ArrayBuffers consumed by decode/IDB** — `.slice(0)` before handoff (`audioBufferStore.ts`).
11. **Collab position tracking** — always use `Tone.now()`, never `AudioContext.currentTime`. `startedAt` is set at the scheduled start time (`Tone.now() + 0.05`), not wall clock. Use positive modulo for loop wrap.
12. **Effects chain includes Distortion** — `Tone.Distortion` is the first node after Player in all engines. `wet = grit`, `distortion = Math.pow(grit, 0.5)`. `createOfflineEqChain` (single/mix, in `reverbSlot.ts`) and `createOfflineCollabEqChain` (collab, in `collabChain.ts`) both return the distortion node as the chain input.
13. **Collab `addSlot` auto-join** uses `this.running` (private flag), not `isRunning()` — so manually-paused slots don't auto-join when a new slot is added mid-session.
14. **Anchor restored synchronously** — `loadAnchorKey()` is called at the top of the URL reconciler effect before any `await`, and both `setReferenceSlotId` + `referenceSlotIdRef.current` are updated together so the async decode loop sees the value immediately.
15. **Octave shift forces `linkPitch: false`** — pitch changes are only audible when unlinked; octave shift buttons set `linkPitch: false` in the same patch.
16. **`computeIsMatched` allows octave multiples** — uses `((diff % 12) + 12) % 12 < 0.01` so MATCHED badge stays after octave shifts. Only speed must match exactly; linkPitch is not checked.

## Known gotchas

- `yt-dlp` on PATH; Rosetta: `arch -arm64 brew install yt-dlp`.
- YouTube blocks cloud IPs — local-only by design.
- Browsers block audio until user gesture. Tone.js creates its AudioContext eagerly on module import — the "AudioContext not allowed to start" console warnings on page load are expected and stop once the user clicks Play.
- `charCodeAt` in `wav.ts` is intentional for ASCII header bytes.
- Drum pattern names (e.g. "custom") are labels; playback only cares whether pattern is off.
- Collab URL format: `?slots=trackId:stemName,...` — slot IDs are UUIDs generated at runtime, not derived from trackId+stemName.
- `GET /api/stems/library` returns all previously-separated track IDs + titles (scans `server/stems/htdemucs/`, joins with `history.json`).
- **S.ECHO (Space Echo) does nothing at Delay = 0** — it only modifies echo character (darkness per repeat, saturation, pitch wobble via LFO); it is not a sound source. "Delay" in the UI = `delayWet`.
- **B.KNOB is fully independent** — taps from the slot's gain output (post all effects chain) as a parallel spring reverb send; no dependency on Delay, Reverb, or any other knob.
- **Named session load vs. per-slot autosave**: two separate systems. `pendingSessionSlotsRef` in `CollabPage.tsx` stages session slot data before navigation so the URL reconciler reads from the session snapshot, not per-slot autosave. `isReference` is stored in named sessions only, not per-slot autosave.
- **Throw reverb decay changes require `reverb.generate()`** — debounced 300ms in `collabEngine.setThrowSettings`.
- **youtu.be short-link parsing**: `extractVideoId()` in `SlotPicker.tsx` handles both `youtube.com/watch?v=ID` and `youtu.be/ID` formats.
- **`SlotStrip.update()` vs `onChange()`**: always call the local `update()` function (engine + state + persist) not `onChange()` directly (state only) when changing slot properties from within SlotStrip.

## Run

From repo root:

```bash
nvm use
npm install   # first time
npm run dev   # web + server (ports in vite.config.ts / server/src/index.ts)
```

## Out of scope

Auth, multi-user, cloud deploy, traditional database, automated tests. Deliberately personal/local.
