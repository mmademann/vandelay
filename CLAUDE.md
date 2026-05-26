# Vandelay — context for Claude

Personal-use "slowed + reverb" web app. Two routes: **`/`** (single track) and **`/mix`** (multi-track + drums).

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
| `engine` | Single track | `Player → effects chain → destination` |
| `mixEngine` | Per audio strip | Same chain → `Volume → PauseGain → master` |
| `drumEngine` | Drums | Synths → separate kick/hat effect chains → master |

Loop regions are managed in engine code, not via the player's native loop points. Pitch/speed go through **`playbackRateForEffects`** on `Tone.Player`.

**Lazy graph build**: audio context needs a user gesture. URL loads decode the buffer first; Tone graph builds on first Play (`ensureGraph` / `playAll`). **Re-apply settings after graph rebuild** (track switch, `engine.load`) or the chain stays at factory defaults.

### Export

- Single: `render.ts` + `encodeExport.ts`
- Mix: `renderMix.ts` + `encodeExport.ts` (respects pause/mute/effects-bypass the same way live audition should)
- Format/quality options: `exportOptions.ts`

### Where code lives

```
server/src/          API routes, yt-dlp/ffmpeg extract, server history
web/src/
  pages/             Route shells + URL reconcilers
  store.ts           Single state, EFFECTS_LIMITS, effect sanitization/bypass
  mixStore.ts        Mix state
  audio/             Engines, offline render, encode
  components/        UI (mix/ subfolder for mixer)
  lib/               Loaders, caches, persistence, format helpers, presets
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

## Known gotchas

- `yt-dlp` on PATH; Rosetta: `arch -arm64 brew install yt-dlp`.
- YouTube blocks cloud IPs — local-only by design.
- Browsers block audio until user gesture.
- `charCodeAt` in `wav.ts` is intentional for ASCII header bytes.
- Drum pattern names (e.g. "custom") are labels; playback only cares whether pattern is off.

## Run

From repo root:

```bash
nvm use
npm install   # first time
npm run dev   # web + server (ports in vite.config.ts / server/src/index.ts)
```

## Out of scope

Auth, multi-user, cloud deploy, traditional database, automated tests. Deliberately personal/local.
