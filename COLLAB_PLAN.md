# Phase 2: Collab Feature Plan

A multi-slot mixer for layering stems from any previously-separated tracks.
Per-slot pitch/speed compensation, master loop control, and export.

---

## Design decisions (locked)

| Question | Decision |
|---|---|
| Track picker | Track-first: pick a track, then pick which stem. Avoids stem-first confusion when you have many tracks. |
| linkPitch default | On by default per slot. Auto-compensates pitch drop from slowdown: `PitchShift.pitch = -12 * log2(speed) + manualOffset` |
| Max slots | 8 |
| Loop mode | Dual: **master** (Transport-synced, default) + **free** (independent player.loop). Master is the default — drift-free playback is the common case, polyrhythm is the escape hatch. Free slots must NOT sync to Transport or they double-trigger on loop. |
| "Lock to global" | Not a separate concept — **master mode IS Transport-sync**. Free mode IS the unlock. No additional toggle needed. |
| Send to Collab | **Replace**, not append. Sends **active-only** stems (non-muted, not silenced by solo). Muted stems would confuse the landing state on /collab. |
| Export | Loop count × master loop duration. Active (non-muted) slots only. |
| Named sessions | Follow `singlePresets.ts` pattern. Key: `vandelay:collab:sessions:v1`, value: `{ name, savedAt, slots, masterSettings }[]` |
| Dispose | `useEffect` cleanup in CollabPage — `return () => collabEngine.dispose()`. Fires on any navigation away. |
| Master loop length UI | **Anchor slot** (option c): one slot has `anchor: boolean`; master loop = `(anchorSlot.loopEnd - anchorSlot.loopStart) / anchorSlot.speed`. Fallback when no anchor: manual seconds input. No BPM+bars. |
| Slot ID | `crypto.randomUUID()` on creation. Not derived from trackId+stemName (same combo can appear twice). |

---

## Data model

### CollabSlot (persisted, no AudioBuffer)

```ts
interface CollabSlot {
  id: string;                  // crypto.randomUUID()
  trackId: string;
  stemName: StemName;
  speed: number;
  pitch: number;               // manual semitone offset
  linkPitch: boolean;          // auto-compensate pitch drop from slowdown
  gain: number;                // dB
  muted: boolean;
  soloed: boolean;
  effects: EffectsState;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  mode: "master" | "free";
  anchor: boolean;             // this slot sets master loop length
}
```

### CollabMasterSettings

```ts
interface CollabMasterSettings {
  gain: number;                // dB
  loopLengthOverride: number | null;  // null = use anchor slot
}
```

### CollabSession

```ts
interface CollabSession {
  name: string;
  savedAt: number;
  slots: CollabSlot[];
  masterSettings: CollabMasterSettings;
}
```

---

## UI / layout decisions

- **No composite waveform** on `/collab` — can't meaningfully represent stems from different-length tracks. The top area is just a transport bar (playhead counter + play/stop + master loop display). Waveforms are per-slot only.
- Per-slot mini-waveforms with draggable loop region handles (extend the DubWaveform canvas pattern, single-stem peaks).

---

## Server

No new routes required for the core feature — existing `/api/stems/:id/:stemName` handles everything (already cached on disk, fast).

`GET /api/stems/library` — returns all previously-separated track IDs + titles. **Required in 2b** (not optional) — without it the slot picker only shows tracks in localStorage, which can be incomplete (e.g. stems separated in a different session). Implementation: `readdirSync` scan of `server/stems/htdemucs/` for IDs, then join with `history.json` for titles. The stems directory has IDs only; titles live in history.json.

---

## Audio engine invariants

- **Master slots**: `player.sync().start(0, slot.loopStart)` — Transport loop governs repeat
- **Free slots**: `player.loop = true; player.loopStart/End = ...; player.start()` — must NOT sync to Transport
- **PitchShift**: **Always instantiate per slot** (pitch=0 when dry). Lazy rewiring (disconnect/reconnect when pitch crosses zero while playing) has race conditions that aren't worth the complexity for 8 nodes. Fixed overhead is acceptable. If CPU becomes a problem, revisit.
- **linkPitch formula**: `effectivePitch = linkPitch ? -12 * log2(speed) + pitch : pitch`
- **getMasterLoopLength()**: checks `loopLengthOverride` first, then finds anchor slot, returns null if neither
- **play()** stop sequence: `transport.loop = false` → `transport.stop(t)` → `player.stop(t)` + `player.unsync()` for all slots → reconfigure → `transport.start(t + 0.05)` (50ms gap clears pipeline)
- **dispose()**: hard-stop all players, disconnect+dispose all nodes, clear slot map, `transport.loop = false`

### Per-slot audio graph

```
Player → PitchShift → EQ3 → FeedbackDelay → DualReverb → Gain → Volume → masterVolume → destination
```

PitchShift is always present. Set `pitch = 0` when dry (no shift, no rewiring needed).

---

## File structure

```
web/src/
  audio/
    collabEngine.ts        -- CollabEngine singleton + RuntimeSlot graph management
  lib/
    collabSettings.ts      -- CollabSlot/Session types, localStorage CRUD
  components/
    collab/
      SlotStrip.tsx        -- per-slot UI row (waveform, pitch/speed, mute, effects, anchor toggle)
      SlotPicker.tsx       -- modal: track list → stem picker → adds slot
      CollabTransport.tsx  -- play/stop, master loop display, loop length input, export button
  pages/
    CollabPage.tsx         -- route /collab, URL reconciler (?slots=id:stem,...), engine lifecycle
```

---

## Build order

### 2a — Engine + settings (foundation)
- `collabSettings.ts`: types + localStorage CRUD for sessions
- `collabEngine.ts`: singleton with addSlot/removeSlot/updateSlot/loadBuffer/play/stop/dispose + getMasterLoopLength

### 2b — URL scheme + CollabPage + SlotPicker + SlotStrip shell
**URL format must be defined here, not 2e.** CLAUDE.md invariant: URL drives loaded tracks; the reconciler needs this to exist before the page can be built correctly.

- URL format: `?slots=trackId:stemName,trackId:stemName,...` — encode as a single `slots` param, colon-separated pairs, comma-delimited. Survives reload, works with "Send to Collab" deep-link.
- `CollabPage.tsx`: URL→store reconciler (parse `?slots=`, load missing, remove extras), engine lifecycle (dispose on unmount), slot list render
- `SlotPicker.tsx`: pulls track list from `GET /api/stems/library` (see Server section — implement this endpoint in 2b, not optional) → stem picker → navigate with updated `?slots=`
- `SlotStrip.tsx`: per-slot row — title, stem badge, mute, gain, placeholder for waveform + effects
- UI actions navigate (`?slots=` update); they don't write engine state directly

### 2c — Waveforms + loop handles + transport
- Per-slot waveform canvas (reuse DubWaveform pattern, single-stem peaks)
- Loop drag handles on waveform
- Anchor toggle button per slot
- `CollabTransport.tsx`: play/stop, master loop length display (anchor-derived or override input), export button placeholder

### 2d — Export
- `renderCollab.ts`: `Tone.Offline` render respecting mute/loop/effects
- Master-loop slots render `loopCount × masterLoopLength` seconds. Free slots play for the same total duration (loop however many times they fit) — same as mix export's longest-segment logic.
- Wire export button in CollabTransport
- `Tone.PitchShift` in Offline context is high-risk. Mitigation: **pre-bake each pitched slot** via a quick offline resample pass first, then run the main render with the baked buffers. Validate this approach early before building the export UI around it. Fallback: skip pitch compensation in export.

### 2e — Polish
All items below are in scope for this phase. Read the full "UX polish" section further down for detailed requirements on auto-anchor, transport bar states, slot strip clarity, and empty state copy.

**`StemsPage.tsx` (touch carefully — regression risk):**
- Add "Send to Collab" button in the transport row. Navigates to `/collab?slots=id:drums,id:bass,...` with active-only stems (non-muted, not silenced by solo). Do not modify any existing handler, state, or layout.

**`SlotStrip.tsx`:**
- Add per-slot effects UI — reverb, delay, and bass boost sliders using the existing `EffectsState` fields. Follow the `StemStrip` pattern in `StemsPage.tsx` exactly (same sliders, same labels, same ranges from `EFFECTS_LIMITS`). Call `collabEngine.updateSlot(id, { effects: nextEffects })` then `onChange({ effects: nextEffects })` on change.
- Rename "Master" → "Sync" and "Free" → "Free" on the mode toggle for clarity.
- Hide the Anchor button on free/Free slots — only show it on Sync slots.
- Group Solo and Mute buttons visually together.

**`CollabPage.tsx`:**
- Auto-anchor: when a new master slot is added and no anchor exists, automatically set it as anchor. If the anchored slot is removed, auto-anchor the next master slot; if none, clear anchor.
- Show overall loading progress in the transport area: "Loading 2 of 4…" while slots are fetching.
- Update empty state copy to: "Add stems from any separated track and layer them together. Each slot gets its own speed, pitch, and effects."

**`collabSettings.ts`:**
- Named session save/load UI — add a small session bar below the transport: text input + Save button, list of saved sessions with load/delete. Follow `StemPresetBar` in `StemsPage.tsx` for the pattern.

---

### 2g — SlotPicker: full UX redesign (replaces 2f)

**Problem**: the current slot picker is a two-step modal anchored to the bottom of the screen — disruptive, hides context, no search, forces two taps to add one stem.

**Solution**: replace the modal with an inline slide-in panel that appears inside the page layout (not a fixed overlay). No steps — track list and stem buttons are visible simultaneously.

**Layout** (inside the collab page, below the transport/session bar, above the slot list):

```
┌─────────────────────────────────────────────────────┐
│ [🔍 Search tracks…]              [Paste YouTube URL] │
├──────────────────────┬──────────────────────────────┤
│ Track list           │ Stems (shown when track       │
│ (scrollable)         │ is selected/hovered)          │
│                      │ [Drums] [Bass] [Vocals] [Other]│
│ > DeepChord dc14     │                               │
│   Grimes REALiTi     │ ← click a stem to add + close│
│   Om Seed of Sound   │                               │
└──────────────────────┴──────────────────────────────┘
```

**Behavior:**
- Panel replaces the "+ Add slot" button — clicking "+ Add slot" expands the panel inline (not a modal). Clicking again or pressing Escape collapses it.
- Search input filters the track list in real time (client-side, by title)
- Clicking a track highlights it and shows its 4 stem buttons on the right. Clicking a stem calls `onConfirm` and collapses the panel.
- YouTube URL input at top right: paste URL → submit (Enter or button) → show inline progress "Separating… 1–2 min" → on completion, new track appears in list and is auto-selected → user picks a stem → panel collapses
- Error from URL submit shown inline below the URL input, clears on next submit
- If library is empty and no URL submitted: show "Paste a YouTube URL to add your first track" in the track list area

**Files to change**: `web/src/components/collab/SlotPicker.tsx` (full rewrite) and `web/src/pages/CollabPage.tsx` (minor: replace the fixed-bottom "+ Add slot" button with the inline panel toggle, pass `showPicker`/`setShowPicker` to render the panel in the slot list area rather than as a modal).

**Do not change any other file.**

---

### 2f — SlotPicker: add new track inline

**Problem**: the slot picker only lists already-separated tracks, forcing users to leave Collab to separate a new one — bad UX.

**Solution**: add a YouTube URL input directly in the slot picker. When submitted, trigger separation in the background, show progress inline, and add the slot automatically when stems are ready.

**Only file to change**: `web/src/components/collab/SlotPicker.tsx`

Flow:
1. Track list step gains a URL input field at the top (placeholder: "Or paste a YouTube URL…")
2. On submit (Enter or button): call `POST /api/stems` with `{ url }` — same call as StemsPage.tsx:91
3. Poll `GET /api/stems/:id/status` every 2s until `ready: true` — same pattern as StemsPage
4. While polling: show inline progress message ("Separating… this takes 1–2 minutes") and disable the input
5. On completion: the new track appears in the library list AND the picker advances to the stem-select step for that track automatically
6. On error: show the error message inline, re-enable input
7. The existing library list remains visible while the URL input is idle — users can still pick from already-separated tracks

**ID extraction**: parse the `v=` param from the URL the same way the rest of the app does (see StemsPage.tsx handleSubmit). `POST /api/stems` returns `{ title, id? }` or `{ error }`.

**Do not modify any other file.**

---

## Open questions (resolved)

- ~~Master loop length UX?~~ → Anchor slot + manual seconds fallback (no BPM+bars)

## Execution notes (for the agent implementing this)

- Work **phase by phase** — complete and review each phase before starting the next. Don't batch 2a–2e in one shot.
- The places most likely to go wrong: URL reconciler (2b), PitchShift graph wiring (2a), export offline render (2d). These deserve extra care and early testing.
- COLLAB_PLAN.md + CLAUDE.md are your authoritative references. The decisions in this file are locked — don't relitigate them.

---

## Risks / watch items

- `Tone.PitchShift` in `Tone.Offline` — may not work; validate in 2d before building export UI around it
- Free slots drifting out of phase intentionally — make sure UI communicates this (no visual lock indicator)
- `player.sync()` + Transport.loop re-triggers synced players every cycle — this is the desired behavior for master slots, but confirm Tone.js version handles it correctly

## UX polish (implement in 2e alongside other polish)

### Auto-anchor
When the first slot is added in master mode and no anchor exists, automatically set it as the anchor. Users shouldn't have to discover the Anchor button to get basic loop sync working. If the anchored slot is removed, auto-anchor the next master slot if one exists; otherwise clear the anchor and show the manual override input. The Anchor button should still be visible per-slot so users can reassign it, but it should never be required to get loops working.

### Transport bar clarity
The transport bar is the control center — it must clearly communicate state at a glance:
- When an anchor exists: show "Loop: 12.3s" (derived from anchor slot)
- When no anchor and no override: show "No loop set" with the manual seconds input visible and focused
- When playing: show a running playhead clock
- Overall loading progress when slots are loading: "Loading 2 of 4…" instead of just per-slot spinners — the page can feel broken during silent multi-WAV fetches otherwise

### Slot strip clarity
- The master/free toggle should be labeled clearly — consider "Sync" / "Free" instead of "Master" / "Free" so the meaning is more obvious at a glance
- The Anchor button should only appear on master/sync slots (hidden on free slots — free slots can't set the master loop length)
- Solo and Mute should be visually grouped together, consistent with how they appear on `/stems`
- Speed and pitch sliders should show their current value inline (e.g. "80%" and "+2st") so users don't have to guess

### Empty state
When no slots are loaded, the empty state should explain what to do in plain terms: "Add stems from any separated track and layer them together. Each slot gets its own speed, pitch, and effects." Not just "Add a stem slot to get started."

### Live speed/pitch changes while playing
`collabEngine.updateSlot()` applies `playbackRate` and `pitchShift.pitch` immediately — changes take effect live without requiring a stop/play cycle. No "apply" button. Abrupt speed changes mid-play will cause a noticeable jump; this is expected and acceptable creative behavior, not a bug.

---

## Regression risks by phase

### 2b
- **`App.tsx`** — adding the `/collab` route and nav link. Preserve all existing routes (`/`, `/mix`, `/stems`) and nav links exactly. Only add, never modify existing entries.
- **`server/src/routes/stems.ts`** — adding `GET /api/stems/library`. Add the new route only; do not modify existing routes (`POST /api/stems`, `GET /api/stems/:id/status`, `GET /api/stems/:id/:stem`).

### 2c
- No existing files touched — all new components under `components/collab/`.

### 2d
- **`renderCollab.ts`** is new. No existing files touched.

### 2e
- **`StemsPage.tsx`** — adding "Send to Collab" button. Do not modify any existing handler, state, or UI element. Add only: a button in the transport row that navigates to `/collab?slots=...` with active stems.
- **`App.tsx`** — nav link added in 2b; no further changes needed here in 2e.
