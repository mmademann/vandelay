import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { collabEngine } from "../audio/collabEngine";
import { DRY_EFFECTS, type StemName } from "../audio/dubEngine";
import type { CollabMasterSettings, CollabSlot, CollabSession, ThrowSettings } from "../lib/collabSettings";
import { getCachedAudio, putCachedAudio } from "../lib/audioCache";
import {
  loadNamedSessions,
  saveNamedSession,
  deleteNamedSession,
  loadSlotSettings,
  loadCollabPresets,
  saveCollabPreset,
  deleteCollabPreset,
  loadThrowSettings,
  saveThrowSettings,
  loadThrowPresets,
  saveThrowPreset,
  deleteThrowPreset,
  type CollabPreset,
  type ThrowPreset,
} from "../lib/collabSettings";
import { SlotStrip } from "../components/collab/SlotStrip";
import { SlotPicker } from "../components/collab/SlotPicker";
import { CollabTransport } from "../components/collab/CollabTransport";

const STEM_NAMES_SET = new Set<string>(["drums", "bass", "vocals", "other"]);
const MAX_STEMS = 8;

interface SlotEntry {
  slot: CollabSlot;
  title: string;
  error: string | null;
  loading: boolean;
  buffer: AudioBuffer | null;
}

function parseSlotsParam(raw: string): Array<{ trackId: string; stemName: StemName }> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => {
      const [trackId, stemName] = pair.trim().split(":");
      if (!trackId || !stemName || !STEM_NAMES_SET.has(stemName)) return null;
      return { trackId, stemName: stemName as StemName };
    })
    .filter((x): x is { trackId: string; stemName: StemName } => x !== null);
}

function encodeSlotsParam(entries: SlotEntry[]): string {
  return entries.map((e) => `${e.slot.trackId}:${e.slot.stemName}`).join(",");
}

export function CollabPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const slotsParam = searchParams.get("slots") ?? "";

  const [entries, setEntries] = useState<SlotEntry[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [masterSettings, setMasterSettings] = useState<CollabMasterSettings>(() => ({
    gain: 0,
    loopLengthOverride: null,
    throwSettings: loadThrowSettings(),
  }));
  const [namedSessions, setNamedSessions] = useState<CollabSession[]>(() => loadNamedSessions());
  const [sessionName, setSessionName] = useState("");
  const [presets, setPresets] = useState<CollabPreset[]>(() => loadCollabPresets());
  const [throwPresets, setThrowPresets] = useState<ThrowPreset[]>(() => loadThrowPresets());
  const [isPlayingAll, setIsPlayingAll] = useState(false);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Staged slot data from a named session load — consumed by the URL reconciler
  const pendingSessionSlotsRef = useRef<Map<string, CollabSlot>>(new Map());

  // Sync initial throw settings to engine on mount
  useEffect(() => {
    collabEngine.setThrowSettings(masterSettings.throwSettings);
    return () => {
      collabEngine.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll engine running state for Play All / Stop All button
  useEffect(() => {
    const id = setInterval(() => setIsPlayingAll(collabEngine.isRunning()), 100);
    return () => clearInterval(id);
  }, []);

  // Escape collapses the picker
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setShowPicker(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // URL reconciler — fires when ?slots= changes
  useEffect(() => {
    const pairs = parseSlotsParam(slotsParam);
    const current = entriesRef.current;

    // Match existing entries by trackId+stemName at same position to reuse UUIDs
    const next: SlotEntry[] = pairs.map((pair) => {
      const existing = current.find(
        (e) => e.slot.trackId === pair.trackId && e.slot.stemName === pair.stemName,
      );
      if (existing) return existing;
      const slot: CollabSlot = {
        id: `${pair.trackId}:${pair.stemName}`,
        trackId: pair.trackId,
        stemName: pair.stemName,
        speed: 1,
        pitch: 0,
        linkPitch: true,
        gain: 0,
        muted: false,
        soloed: false,
        effects: { ...DRY_EFFECTS },
        loopStart: 0,
        loopEnd: 0,
      };
      return { slot, title: pair.trackId, error: null, loading: true, buffer: null };
    });

    // Remove engine slots no longer in URL
    const nextIds = new Set(next.map((e) => e.slot.id));
    for (const old of current) {
      if (!nextIds.has(old.slot.id)) {
        collabEngine.removeSlot(old.slot.id);
      }
    }

    setEntries(next);

    // Load any new slots (those still in loading state)
    let cancelled = false;
    (async () => {
      // Fetch library once for title resolution
      let library: Array<{ id: string; title: string }> = [];
      try {
        const libRes = await fetch("/api/stems/library");
        if (libRes.ok) library = await libRes.json() as typeof library;
      } catch { /* titles fall back to trackId */ }

      for (const entry of next) {
        if (!entry.loading) continue;
        if (cancelled) return;

        const { slot } = entry;
        let buffer: AudioBuffer;
        try {
          const cacheKey = `stem:${slot.trackId}:${slot.stemName}:mp3`;
          let arrayBuffer = await getCachedAudio(cacheKey);
          if (!arrayBuffer) {
            const res = await fetch(`/api/stems/${slot.trackId}/${slot.stemName}`);
            if (!res.ok) {
              if (res.status === 404) throw new Error("Stem not found — separate this track first");
              throw new Error(`Server error ${res.status}`);
            }
            arrayBuffer = await res.arrayBuffer();
            putCachedAudio(cacheKey, arrayBuffer.slice(0));
          }
          const decodeCtx = new AudioContext();
          buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
          decodeCtx.close();
        } catch (e) {
          if (cancelled) return;
          setEntries((prev) =>
            prev.map((en) =>
              en.slot.id === slot.id
                ? { ...en, loading: false, error: e instanceof Error ? e.message : "Failed to load" }
                : en,
            ),
          );
          continue;
        }

        if (cancelled) return;

        const dur = buffer.duration;
        const slotKey = `${slot.trackId}:${slot.stemName}`;
        const pendingSlot = pendingSessionSlotsRef.current.get(slotKey);
        let finalSlot: CollabSlot;
        if (pendingSlot) {
          // Session load — restore all settings from the named session
          pendingSessionSlotsRef.current.delete(slotKey);
          finalSlot = {
            ...pendingSlot,
            id: slot.id,
            loopStart: Math.max(0, Math.min(pendingSlot.loopStart, dur - 0.01)),
            loopEnd: Math.min(dur, pendingSlot.loopEnd > 0 ? pendingSlot.loopEnd : dur),
          };
        } else {
          // Normal load — restore from per-slot autosave
          const saved = loadSlotSettings(slot.trackId, slot.stemName);
          finalSlot = {
            ...slot,
            loopStart: saved ? Math.max(0, saved.loopStartFrac * dur) : 0,
            loopEnd: saved ? Math.min(dur, saved.loopEndFrac * dur) : dur,
            speed: saved?.speed ?? slot.speed,
            pitch: saved?.pitch ?? slot.pitch,
            linkPitch: saved?.linkPitch ?? slot.linkPitch,
            gain: saved?.gain ?? slot.gain,
            muted: saved?.muted ?? slot.muted,
            effects: saved?.effects ?? slot.effects,
          };
        }

        const title = library.find((e) => e.id === slot.trackId)?.title ?? slot.trackId;

        if (cancelled) return;

        await collabEngine.addSlot(finalSlot, buffer);

        setEntries((prev) =>
          prev.map((en) =>
            en.slot.id === slot.id
              ? { ...en, slot: finalSlot, title, loading: false, error: null, buffer }
              : en,
          ),
        );
      }
    })();

    return () => { cancelled = true; };
  }, [slotsParam]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSlotChange(id: string, patch: Partial<CollabSlot>) {
    setEntries((prev) =>
      prev.map((e) => (e.slot.id === id ? { ...e, slot: { ...e.slot, ...patch } } : e)),
    );
  }

  function handleRemoveSlot(id: string) {
    const remaining = entriesRef.current.filter((e) => e.slot.id !== id);
    const param = encodeSlotsParam(remaining);
    navigate(param ? `/collab?slots=${param}` : "/collab");
  }

  function handlePickerConfirm(trackId: string, stemName: StemName) {
    setShowPicker(false);
    if (entries.length >= MAX_STEMS) return;
    const current = encodeSlotsParam(entries);
    const added = `${trackId}:${stemName}`;
    const param = current ? `${current},${added}` : added;
    navigate(`/collab?slots=${param}`);
  }

  function handleSaveSession() {
    const name = sessionName.trim();
    if (!name || entries.length === 0) return;
    const slots = entries.map((e) => e.slot);
    setNamedSessions(saveNamedSession(name, slots, masterSettings));
    setSessionName("");
  }

  function handleLoadSession(session: CollabSession) {
    const ms = session.masterSettings;
    setMasterSettings(ms);
    collabEngine.setMasterSettings(ms);
    collabEngine.setThrowSettings(ms.throwSettings);
    // Stage slot settings so the reconciler restores them instead of per-slot autosave
    pendingSessionSlotsRef.current = new Map(
      session.slots.map((s) => [`${s.trackId}:${s.stemName}`, s]),
    );
    const param = session.slots.map((s) => `${s.trackId}:${s.stemName}`).join(",");
    navigate(param ? `/collab?slots=${param}` : "/collab");
  }

  function handleDeleteSession(name: string) {
    setNamedSessions(deleteNamedSession(name));
  }

  function handleSavePreset(name: string, preset: Omit<CollabPreset, "name">) {
    setPresets(saveCollabPreset(name, preset));
  }

  function handleDeletePreset(name: string) {
    setPresets(deleteCollabPreset(name));
  }

  function handleApplyPreset(slotId: string, preset: CollabPreset) {
    const patch = {
      effects: preset.effects,
      speed: preset.speed,
      pitch: preset.pitch,
      linkPitch: preset.linkPitch,
      gain: preset.gain,
    };
    collabEngine.updateSlot(slotId, patch);
    setEntries((prev) =>
      prev.map((e) => e.slot.id === slotId ? { ...e, slot: { ...e.slot, ...patch } } : e),
    );
  }

  const getSlotsAndBuffers = useRef(() => ({
    slots: entriesRef.current.map((e) => e.slot),
    buffers: new Map(entriesRef.current.filter((e) => e.buffer).map((e) => [e.slot.id, e.buffer!])),
  }));


  function handleThrowSettingsChange(throwSettings: ThrowSettings) {
    setMasterSettings((prev) => ({ ...prev, throwSettings }));
    saveThrowSettings(throwSettings);
  }

  function handleSaveThrowPreset(name: string) {
    setThrowPresets(saveThrowPreset(name, masterSettings.throwSettings));
  }

  function handleDeleteThrowPreset(name: string) {
    setThrowPresets(deleteThrowPreset(name));
  }

  function handleApplyThrowPreset(preset: ThrowPreset) {
    collabEngine.setThrowSettings(preset.settings);
    setMasterSettings((prev) => ({ ...prev, throwSettings: preset.settings }));
    saveThrowSettings(preset.settings);
  }

  async function handlePlayAll() {
    await collabEngine.play();
  }

  function handleStopAll() {
    collabEngine.stop();
  }

  function handleClear() {
    navigate("/collab");
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* Top bar: sessions + transport in one row */}
      <div className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        {/* Sessions label */}
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-foreground/40">Sessions</span>

        {/* Session chips */}
        <div className="flex flex-1 flex-wrap items-center gap-1.5 overflow-hidden">
          {namedSessions.map((s) => (
            <div
              key={s.name}
              className="group flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2"
            >
              <button
                type="button"
                onClick={() => handleLoadSession(s)}
                className="text-sm font-medium text-foreground/70 transition hover:text-foreground whitespace-nowrap"
              >
                {s.name}
              </button>
              <div className="flex items-center justify-between w-14 opacity-0 group-hover:opacity-100 transition border-l border-border/50 pl-2">
                <button
                  type="button"
                  onClick={() => { if (entriesRef.current.length > 0) setNamedSessions(saveNamedSession(s.name, entriesRef.current.map((e) => e.slot), masterSettings)); }}
                  className="text-base leading-none text-foreground/30 transition hover:text-accent"
                  aria-label="Resave session"
                  title="Resave with current slots"
                >
                  💾
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteSession(s.name)}
                  className="text-base leading-none text-foreground/30 transition hover:text-red-400"
                  aria-label="Delete session"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {/* Save input */}
          <form
            onSubmit={(e) => { e.preventDefault(); handleSaveSession(); }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Save session…"
              className="w-36 rounded border border-border bg-muted/50 px-3 py-2 text-sm outline-none focus:border-accent/60 placeholder:text-foreground/30"
            />
            {sessionName.trim() && (
              <button
                type="submit"
                className="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground/50 transition hover:text-foreground"
              >
                Save
              </button>
            )}
          </form>
        </div>

        {/* Divider */}
        <div className="h-4 w-px shrink-0 bg-border/50" />

        {/* Transport */}
        <CollabTransport
          masterSettings={masterSettings}
          slotCount={entries.length}
          getSlotsAndBuffers={getSlotsAndBuffers.current}
          onPlayAll={handlePlayAll}
          onStopAll={handleStopAll}
          onRewindAll={() => { for (const e of entries) collabEngine.seekSlot(e.slot.id, e.slot.loopStart); }}
          onThrowSettingsChange={handleThrowSettingsChange}
          throwPresets={throwPresets}
          onSaveThrowPreset={handleSaveThrowPreset}
          onDeleteThrowPreset={handleDeleteThrowPreset}
          onApplyThrowPreset={handleApplyThrowPreset}
          isPlaying={isPlayingAll}
        />

        {/* Clear / reset */}
        {entries.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 rounded border border-border/50 bg-muted/30 px-2.5 py-1 text-xs text-foreground/30 transition hover:border-red-500/30 hover:text-red-400"
          >
            Clear
          </button>
        )}
      </div>

      {/* Add slot button */}
      {/* Slots grid */}
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto content-start">
        {entries.length === 0 && !showPicker && (
          <div className="col-span-2 flex items-center justify-center rounded-md border border-dashed border-border px-4 py-16 text-center text-sm text-foreground/40">
            Add stems from any separated track and layer them together. Each stem gets its own speed, pitch, and effects.
          </div>
        )}

        {entries.map((entry) => {
          if (entry.loading) {
            return (
              <div
                key={entry.slot.id}
                className="flex min-h-[160px] items-center justify-center rounded-md border border-border bg-muted/30 px-4 py-8 text-sm text-foreground/40"
              >
                Loading {entry.slot.stemName} from {entry.slot.trackId}…
              </div>
            );
          }
          if (entry.error) {
            return (
              <div
                key={entry.slot.id}
                className="flex min-h-[160px] flex-col items-start justify-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-6"
              >
                <span className="text-sm text-red-400">{entry.error}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveSlot(entry.slot.id)}
                  className="text-xs text-foreground/40 hover:text-foreground/70"
                >
                  Remove
                </button>
              </div>
            );
          }
          return (
            <SlotStrip
              key={entry.slot.id}
              slot={entry.slot}
              title={entry.title}
              buffer={entry.buffer}
              presets={presets}
              onRemove={() => handleRemoveSlot(entry.slot.id)}
              onChange={(patch) => handleSlotChange(entry.slot.id, patch)}
              onSavePreset={handleSavePreset}
              onDeletePreset={handleDeletePreset}
              onApplyPreset={(preset) => handleApplyPreset(entry.slot.id, preset)}
            />
          );
        })}

        {/* Add stem — lives inside the grid as a cell */}
        {entries.length < MAX_STEMS && !showPicker && (
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="min-h-[120px] rounded-md border border-dashed border-border bg-transparent text-sm text-foreground/40 transition hover:border-accent/40 hover:text-foreground/60"
          >
            + Add stem
          </button>
        )}

        {showPicker && (
          <SlotPicker
            onConfirm={handlePickerConfirm}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
