# Vandelay

A "slowed + reverb" web app with two modes: a single-track editor at `/`, and a multi-track mixer at `/mix`. Paste a YouTube URL or upload a local audio file, set loop regions, dial in effects, and export.

Open http://localhost:5173 after starting the dev server (see below).

## Prerequisites

- Node 20+ (`nvm use` reads `.nvmrc`)
- `yt-dlp` on PATH (`brew install yt-dlp`)

`ffmpeg` is bundled via `ffmpeg-static` — no separate install.

## Setup & run

From the **repo root** (npm workspaces install `web` + `server` together):

```bash
nvm use
npm install    # first time
npm run dev    # web + server
```

Fresh terminal? Run `nvm use` again before `npm run dev`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Run web + server concurrently |
| `npm run build` | Type-check and build both packages |
| `npm run start` | Production server (after build) |
| `npm run dev -w web` | Frontend only |
| `npm run dev -w server` | Backend only |

Default ports: web **5173**, server **5174** (see `web/vite.config.ts` and `server/src/index.ts` to change).

## Single-track mode (`/`)

Three columns: **Recent** | waveform + effects | export + presets.

1. **Load** a YouTube URL or **Upload file**. Server handles YouTube extraction; local files stay in the browser.
2. **Recent** — click to load from cache; ✕ to remove (removing the active track stops playback and clears the page).
3. **Loop region** — drag on the waveform, edit **Start** / **End** (format shown beside the fields), or click the waveform to seek.
4. **Play loop** — preview with a live cursor.
5. **Effects** — speed, pitch (optionally linked), reverb, delay, bass, gain. Toggle **Effects** off to bypass for preview and export; slider values are kept.
6. **Presets** — save/load named combinations of loop region, loop count, and effects.
7. **Export** — set loop count, pick format and quality in the export panel, download.

Settings restore automatically per track on reload.

## Mix mode (`/mix`)

Layer multiple loops with independent settings per strip.

1. Add tracks via URL, file upload, or **Recent**.
2. Each **track strip**: mini waveform, loop region, pause/resume (stays in phase), effects on/off, volume, mute, and the same effect sliders as single mode.
3. **Drum machine** — 16-step kick/hat sequencer, pattern presets, BPM, synth tweaks, separate hat effects, saveable drum presets.
4. **Play all / Stop all** — tracks and drums start together; loops drift naturally over time.
5. **Master gain** — combined output level.
6. **Export mix** — unpaused, unmuted strips plus drums (if enabled). Paused strips are skipped.

Per-id settings persist; re-adding a track brings back its saved loop and effects. The active mix lineup comes from the URL, not localStorage.

## URL params

- `/?v=<id>` — single track
- `/mix?v=id1,id2` — mix lineup (order preserved)

The URL is the source of truth: load, add, and remove actions update `?v=`; each page reconciles against it.

YouTube ids are shareable. Local upload ids only work in the same browser while cached audio/metadata exist.

Browsers block audio until you interact — click **Play** once after a cold load.

## Troubleshooting

| Issue | Fix |
| --- | --- |
| `yt-dlp not found` | `brew install yt-dlp` |
| Rosetta brew error on Apple Silicon | `arch -arm64 brew install yt-dlp` |
| Video too long | Cap is in `server/src/lib/extract.ts` (`MAX_DURATION_SECONDS`) |
| No sound after refresh | Click Play once (autoplay policy) |
| Port in use | Change ports in vite config / server entry |

YouTube extraction is unreliable from cloud/datacenter IPs — intended for local use.

## Repo layout

```
server/     Express API — yt-dlp + ffmpeg, WAV cache, server history
web/        React SPA — audio engines, UI, offline export, browser caches
```

Inside `web/src/`: `pages/` (routes), `components/` (UI), `audio/` (engines + render), `lib/` (loaders, persistence, format helpers). See `CLAUDE.md` for architecture notes aimed at contributors/agents.
