import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  saveSlotSettings,
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
  loadAnchorKey,
  saveAnchorKey,
  clearAnchorKey,
} from "../lib/collabSettings";
import { getTrackMeta, putTrackMeta } from "../lib/trackMetaCache";
import { analyzeAudio, rootSemitone, preloadEssentia } from "../lib/audioAnalysis";
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
  detectedKey: string | null | undefined;
  detectedBpm: number | undefined;
  isMatched: boolean;
  matchedBasePitch: number; // pitch value at time of match — octave/interval grid is anchored here
  pitchInterval: 1 | 7 | 12;
}

function parseSlotsParam(raw: string): Array<{ trackId: string; stemName: StemName | null }> {
  if (!raw) return [];
  const seen = new Set<string>();
  return raw
    .split(",")
    .map((token) => {
      const colonIdx = token.indexOf(":");
      if (colonIdx === -1) {
        const trackId = token.trim();
        if (!trackId) return null;
        return { trackId, stemName: null };
      }
      const trackId = token.slice(0, colonIdx).trim();
      const stemName = token.slice(colonIdx + 1).trim();
      if (!trackId || !stemName || !STEM_NAMES_SET.has(stemName)) return null;
      return { trackId, stemName: stemName as StemName };
    })
    .filter((x): x is { trackId: string; stemName: StemName | null } => {
      if (x === null) return false;
      const key = x.stemName ? `${x.trackId}:${x.stemName}` : x.trackId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function encodeSlotsParam(entries: SlotEntry[]): string {
  return entries
    .map((e) => (e.slot.stemName ? `${e.slot.trackId}:${e.slot.stemName}` : e.slot.trackId))
    .join(",");
}

function slotId(trackId: string, stemName: StemName | null): string {
  return stemName ? `${trackId}:${stemName}` : trackId;
}

function pendingKey(trackId: string, stemName: StemName | null): string {
  return stemName ? `${trackId}:${stemName}` : trackId;
}

export function CollabPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const slotsParam = searchParams.get("slots") ?? "";

  const [entries, setEntries] = useState<SlotEntry[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [referenceSlotId, setReferenceSlotId] = useState<string | null>(null);
  const [masterSettings, setMasterSettings] = useState<CollabMasterSettings>(() => ({
    gain: 0,
    loopLengthOverride: null,
    throwSettings: loadThrowSettings(),
  }));
  const [namedSessions, setNamedSessions] = useState<CollabSession[]>(() => loadNamedSessions());
  const [sessionName, setSessionName] = useState("");
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const sessionsPanelRef = useRef<HTMLDivElement>(null);
  const sessionsBtnRef = useRef<HTMLButtonElement>(null);
  const [presets, setPresets] = useState<CollabPreset[]>(() => loadCollabPresets());
  const [throwPresets, setThrowPresets] = useState<ThrowPreset[]>(() => loadThrowPresets());
  const [isPlayingAll, setIsPlayingAll] = useState(false);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const referenceSlotIdRef = useRef<string | null>(null);
  referenceSlotIdRef.current = referenceSlotId;
  // Staged slot data from a named session load — consumed by the URL reconciler
  const pendingSessionSlotsRef = useRef<Map<string, CollabSlot>>(new Map());
  // Staged reference slot ID from a session load — applied at start of next reconciler run
  const pendingReferenceIdRef = useRef<string | null>(null);

  // Sync initial throw settings to engine on mount; preload Essentia WASM
  useEffect(() => {
    collabEngine.setThrowSettings(masterSettings.throwSettings);
    preloadEssentia().catch(() => {});
    return () => {
      collabEngine.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll engine running state for Play All / Stop All button
  useEffect(() => {
    const id = setInterval(() => setIsPlayingAll(collabEngine.isRunning()), 100);
    return () => clearInterval(id);
  }, []);

  // Escape collapses the picker and sessions panel
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setShowPicker(false); setSessionsPanelOpen(false); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Close sessions panel on outside click
  useEffect(() => {
    if (!sessionsPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        sessionsPanelRef.current && !sessionsPanelRef.current.contains(e.target as Node) &&
        sessionsBtnRef.current && !sessionsBtnRef.current.contains(e.target as Node)
      ) {
        setSessionsPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sessionsPanelOpen]);

  // URL reconciler — fires when ?slots= changes
  useEffect(() => {
    // Apply pending reference from session load before processing entries
    if (pendingReferenceIdRef.current !== null) {
      setReferenceSlotId(pendingReferenceIdRef.current);
      referenceSlotIdRef.current = pendingReferenceIdRef.current;
      pendingReferenceIdRef.current = null;
    } else if (referenceSlotIdRef.current === null) {
      // On fresh page load, restore anchor synchronously so auto-match sees it
      // before any slot's async decode completes.
      const savedAnchor = loadAnchorKey();
      if (savedAnchor) {
        const restoredId = slotId(savedAnchor.trackId, savedAnchor.stemName);
        setReferenceSlotId(restoredId);
        referenceSlotIdRef.current = restoredId;
      }
    }

    const pairs = parseSlotsParam(slotsParam);
    const current = entriesRef.current;

    const next: SlotEntry[] = pairs.map((pair) => {
      const existing = current.find(
        (e) => e.slot.trackId === pair.trackId && e.slot.stemName === pair.stemName,
      );
      if (existing) return existing;
      const id = slotId(pair.trackId, pair.stemName);
      const slot: CollabSlot = {
        id,
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
      return { slot, title: pair.trackId, error: null, loading: true, buffer: null, detectedKey: undefined, detectedBpm: undefined, isMatched: false, matchedBasePitch: 0, pitchInterval: 12 };
    });

    // Remove engine slots no longer in URL
    const nextIds = new Set(next.map((e) => e.slot.id));
    for (const old of current) {
      if (!nextIds.has(old.slot.id)) {
        collabEngine.removeSlot(old.slot.id);
      }
    }

    setEntries(next);

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
          if (slot.stemName === null) {
            // Full track slot — load from /api/audio/{trackId}
            const cacheKey = slot.trackId;
            let arrayBuffer = await getCachedAudio(cacheKey);
            if (!arrayBuffer) {
              const res = await fetch(`/api/audio/${slot.trackId}`);
              if (!res.ok) {
                if (res.status === 404) throw new Error("Track not found");
                throw new Error(`Server error ${res.status}`);
              }
              arrayBuffer = await res.arrayBuffer();
              putCachedAudio(cacheKey, arrayBuffer.slice(0));
            }
            const decodeCtx = new AudioContext();
            buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
            decodeCtx.close();
          } else {
            // Stem slot
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
          }
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

        // Key / BPM detection — check cache first, run Essentia if not yet analyzed
        // For stem slots, analyze the full track (better harmonic content, same key)
        let detectedKey: string | null | undefined;
        let detectedBpm: number | undefined;
        try {
          const cached = await getTrackMeta(slot.trackId);
          // Use cached result only if it's a real key string (not null — null means
          // it was analyzed with stem audio before; re-try with full track)
          if (cached && typeof cached.detectedKey === 'string') {
            detectedKey = cached.detectedKey;
            detectedBpm = cached.detectedBpm;
          } else {
            let analysisBuffer = buffer;
            if (slot.stemName !== null) {
              try {
                let ab = await getCachedAudio(slot.trackId);
                if (!ab) {
                  const res = await fetch(`/api/audio/${slot.trackId}`);
                  if (res.ok) {
                    ab = await res.arrayBuffer();
                    putCachedAudio(slot.trackId, ab.slice(0));
                  }
                }
                if (ab) {
                  const ctx = new AudioContext();
                  analysisBuffer = await ctx.decodeAudioData(ab.slice(0));
                  ctx.close();
                }
              } catch {
                // fall back to stem audio
              }
            }
            const result = await analyzeAudio(analysisBuffer);
            detectedKey = result?.key ?? null;
            detectedBpm = result?.bpm;
            if (cached) {
              await putTrackMeta({ ...cached, detectedKey, detectedBpm });
            }
          }
        } catch {
          detectedKey = null;
        }

        if (cancelled) return;

        const dur = buffer.duration;
        const pk = pendingKey(slot.trackId, slot.stemName);
        const pendingSlot = pendingSessionSlotsRef.current.get(pk);
        let finalSlot: CollabSlot;
        if (pendingSlot) {
          pendingSessionSlotsRef.current.delete(pk);
          finalSlot = {
            ...pendingSlot,
            id: slot.id,
            loopStart: Math.max(0, Math.min(pendingSlot.loopStart, dur - 0.01)),
            loopEnd: Math.min(dur, pendingSlot.loopEnd > 0 ? pendingSlot.loopEnd : dur),
          };
        } else {
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

        // Restore saved matched state (overridden below if live auto-match runs)
        let autoMatched = finalSlot.isMatched ?? false;
        let matchedBasePitch = finalSlot.matchedBasePitch ?? 0;
        const savedForMatch = loadSlotSettings(slot.trackId, slot.stemName);
        if (!autoMatched && savedForMatch?.isMatched) {
          autoMatched = true;
          matchedBasePitch = savedForMatch.matchedBasePitch ?? 0;
        }
        const pitchInterval: 1 | 7 | 12 = savedForMatch?.pitchInterval ?? 12;


        // Auto-match to reference if one is pinned and this is not the reference.
        // Skip if already matched from saved state — trust the saved pitch (user may have octave-shifted).
        const currentRefId = referenceSlotIdRef.current;
        if (currentRefId && slot.id !== currentRefId && !autoMatched) {
          const refEntry = entriesRef.current.find((e) => e.slot.id === currentRefId);
          if (refEntry) {
            const speed = refEntry.slot.speed;
            const linkPitch = refEntry.slot.linkPitch;
            let pitch = 0;
            const refKey = refEntry.detectedKey;
            if (refKey && detectedKey) {
              const refSem = rootSemitone(refKey);
              const tgtSem = rootSemitone(detectedKey);
              if (refSem !== null && tgtSem !== null) {
                pitch = refEntry.slot.pitch - (tgtSem - refSem);
              }
            }
            finalSlot = { ...finalSlot, speed, pitch, linkPitch };
            autoMatched = true;
            matchedBasePitch = pitch;
          }
        }

        const title =
          library.find((e) => e.id === slot.trackId)?.title ?? slot.trackId;

        if (cancelled) return;

        await collabEngine.addSlot(finalSlot, buffer);

        setEntries((prev) =>
          prev.map((en) =>
            en.slot.id === slot.id
              ? { ...en, slot: finalSlot, title, loading: false, error: null, buffer, detectedKey, detectedBpm, isMatched: autoMatched, matchedBasePitch, pitchInterval }
              : en,
          ),
        );

        if (autoMatched) {
          const dur = buffer.duration;
          saveSlotSettings(finalSlot.trackId, finalSlot.stemName, {
            speed: finalSlot.speed,
            pitch: finalSlot.pitch,
            linkPitch: finalSlot.linkPitch,
            gain: finalSlot.gain,
            muted: finalSlot.muted,
            effects: finalSlot.effects,
            loopStartFrac: finalSlot.loopStart / dur,
            loopEndFrac: finalSlot.loopEnd / dur,
            isMatched: true,
            matchedBasePitch,
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [slotsParam]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSlotChange(id: string, patch: Partial<CollabSlot>) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.slot.id !== id) return e;
        const clearMatch = patch.speed !== undefined;
        const updated = { ...e, slot: { ...e.slot, ...patch }, isMatched: clearMatch ? false : e.isMatched };
        if (clearMatch) {
          // Persist cleared matched state
          const dur = e.buffer?.duration ?? 1;
          const s = updated.slot;
          saveSlotSettings(s.trackId, s.stemName, {
            speed: s.speed, pitch: s.pitch, linkPitch: s.linkPitch,
            gain: s.gain, muted: s.muted, effects: s.effects,
            loopStartFrac: s.loopStart / dur, loopEndFrac: s.loopEnd / dur,
            isMatched: false, matchedBasePitch: 0,
          });
        }
        return updated;
      }),
    );
  }

  function handleRemoveSlot(id: string) {
    if (referenceSlotId === id) {
      setReferenceSlotId(null);
      clearAnchorKey();
    }
    const remaining = entriesRef.current.filter((e) => e.slot.id !== id);
    const param = encodeSlotsParam(remaining);
    navigate(param ? `/collab?slots=${param}` : "/collab");
  }

  function handlePickerConfirm(trackId: string, stemName: StemName | null) {
    setShowPicker(false);
    if (entries.length >= MAX_STEMS) return;
    const current = encodeSlotsParam(entries);
    const added = stemName ? `${trackId}:${stemName}` : trackId;
    const param = current ? `${current},${added}` : added;
    navigate(`/collab?slots=${param}`);
  }

  function handleSetReference(slotId: string) {
    const isAlreadyRef = referenceSlotIdRef.current === slotId;
    const newRefId = isAlreadyRef ? null : slotId;
    setReferenceSlotId(newRefId);
    // Clear matched state on all slots — they're not matched to the new reference
    setEntries((prev) => prev.map((e) => ({ ...e, isMatched: false })));
    if (newRefId) {
      const entry = entriesRef.current.find((e) => e.slot.id === newRefId);
      if (entry) saveAnchorKey(entry.slot.trackId, entry.slot.stemName);
    } else {
      clearAnchorKey();
    }
  }

  function persistMatchedState(entry: SlotEntry, isMatched: boolean, matchedBasePitch: number) {
    const dur = entry.buffer?.duration ?? 1;
    const s = entry.slot;
    saveSlotSettings(s.trackId, s.stemName, {
      speed: s.speed,
      pitch: s.pitch,
      linkPitch: s.linkPitch,
      gain: s.gain,
      muted: s.muted,
      effects: s.effects,
      loopStartFrac: s.loopStart / dur,
      loopEndFrac: s.loopEnd / dur,
      isMatched,
      matchedBasePitch,
    });
  }

  function matchSlotToReference(targetSlotId: string) {
    const refEntry = entriesRef.current.find((e) => e.slot.id === referenceSlotIdRef.current);
    const targetEntry = entriesRef.current.find((e) => e.slot.id === targetSlotId);
    if (!refEntry || !targetEntry || targetSlotId === referenceSlotIdRef.current) return;

    const speed = refEntry.slot.speed;
    const linkPitch = refEntry.slot.linkPitch;
    let pitch = 0;

    const refKey = refEntry.detectedKey;
    const tgtKey = targetEntry.detectedKey;
    if (refKey && tgtKey) {
      const refSem = rootSemitone(refKey);
      const tgtSem = rootSemitone(tgtKey);
      if (refSem !== null && tgtSem !== null) {
        pitch = refEntry.slot.pitch - (tgtSem - refSem);
      }
    }

    collabEngine.updateSlot(targetSlotId, { speed, pitch, linkPitch });
    setEntries((prev) =>
      prev.map((e) =>
        e.slot.id === targetSlotId
          ? { ...e, slot: { ...e.slot, speed, pitch, linkPitch }, isMatched: true, matchedBasePitch: pitch }
          : e,
      ),
    );
    // Persist matched state so it survives reload
    persistMatchedState({ ...targetEntry, slot: { ...targetEntry.slot, speed, pitch, linkPitch } }, true, pitch);
  }

  function handleMatchAll() {
    const refId = referenceSlotIdRef.current;
    if (!refId) return;
    for (const entry of entriesRef.current) {
      if (entry.slot.id !== refId && !entry.loading) {
        matchSlotToReference(entry.slot.id);
      }
    }
  }

  function handleSaveSession() {
    const name = sessionName.trim();
    if (!name || entries.length === 0) return;
    const slots = entries.map((e) => ({
      ...e.slot,
      isReference: e.slot.id === referenceSlotId,
      isMatched: e.isMatched,
      matchedBasePitch: e.matchedBasePitch,
    }));
    setNamedSessions(saveNamedSession(name, slots, masterSettings));
    setSessionName("");
  }

  function handleLoadSession(session: CollabSession) {
    const ms = session.masterSettings;
    setMasterSettings(ms);
    collabEngine.setMasterSettings(ms);
    collabEngine.setThrowSettings(ms.throwSettings);

    pendingSessionSlotsRef.current = new Map(
      session.slots.map((s) => [pendingKey(s.trackId, s.stemName), s]),
    );

    // Stage reference to be applied when reconciler runs
    const refSlot = session.slots.find((s) => s.isReference);
    pendingReferenceIdRef.current = refSlot
      ? slotId(refSlot.trackId, refSlot.stemName)
      : null;

    const param = session.slots
      .map((s) => (s.stemName ? `${s.trackId}:${s.stemName}` : s.trackId))
      .join(",");
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

  const portalTarget = document.getElementById("collab-transport-portal");
  const topBar = (
    <div className="relative flex min-w-0 flex-1 items-center gap-2">
        {/* Sessions dropdown button */}
        <button
          ref={sessionsBtnRef}
          type="button"
          onClick={() => setSessionsPanelOpen((o) => !o)}
          className={`shrink-0 rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition ${sessionsPanelOpen ? "bg-accent/20 text-accent ring-1 ring-accent/40" : "bg-muted/80 text-foreground/50 hover:text-foreground hover:bg-muted"}`}
        >
          Sessions{namedSessions.length > 0 ? ` (${namedSessions.length})` : ""}
        </button>

        {/* Sessions panel */}
        {sessionsPanelOpen && (
          <div
            ref={sessionsPanelRef}
            className="absolute left-0 top-full mt-1 z-50 w-72 rounded-md border border-border/40 bg-zinc-900/95 shadow-xl backdrop-blur-sm ring-1 ring-border/30 p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground/40">Sessions</span>
              <button type="button" onClick={() => setSessionsPanelOpen(false)}
                className="text-foreground/30 hover:text-foreground/70 text-sm leading-none px-1">✕</button>
            </div>

            {namedSessions.length === 0 && (
              <div className="py-2 text-xs text-foreground/30">No saved sessions yet.</div>
            )}

            {namedSessions.map((s) => (
              <div key={s.name} className="group flex items-center rounded border border-border bg-muted/40 px-3 py-2">
                <button
                  type="button"
                  onClick={() => { handleLoadSession(s); setSessionsPanelOpen(false); }}
                  className="truncate text-left text-sm font-medium text-foreground/70 transition hover:text-foreground"
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (entriesRef.current.length > 0) {
                      const slots = entriesRef.current.map((e) => ({
                        ...e.slot,
                        isReference: e.slot.id === referenceSlotIdRef.current,
                        isMatched: e.isMatched,
                        matchedBasePitch: e.matchedBasePitch,
                      }));
                      setNamedSessions(saveNamedSession(s.name, slots, masterSettings));
                    }
                  }}
                  className="text-base leading-none text-foreground/30 opacity-0 group-hover:opacity-100 transition hover:text-accent pl-3"
                  aria-label="Resave session" title="Resave with current slots"
                >💾</button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => handleDeleteSession(s.name)}
                  className="text-base leading-none text-foreground/30 opacity-0 group-hover:opacity-100 transition hover:text-red-400"
                  aria-label="Delete session"
                >✕</button>
              </div>
            ))}

            <form
              onSubmit={(e) => { e.preventDefault(); handleSaveSession(); }}
              className="flex items-center gap-1.5 border-t border-border/30 pt-2 mt-1"
            >
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Save current session…"
                className="min-w-0 flex-1 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs outline-none focus:border-accent/60 placeholder:text-foreground/30"
              />
              {sessionName.trim() && (
                <button
                  type="submit"
                  className="rounded border border-border bg-muted/50 px-2 py-1.5 text-xs text-foreground/50 transition hover:text-foreground"
                >
                  Save
                </button>
              )}
            </form>
          </div>
        )}

        <div className="h-4 w-px shrink-0 bg-border/50" />

        <CollabTransport
          masterSettings={masterSettings}
          slotCount={entries.length}
          referenceSlotId={referenceSlotId}
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
          onMatchAll={handleMatchAll}
        />

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
  );

  return (
    <>
      {portalTarget && createPortal(topBar, portalTarget)}
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto content-start">
        {entries.length === 0 && !showPicker && (
          <div className="col-span-2 flex items-center justify-center rounded-md border border-dashed border-border px-4 py-16 text-center text-sm text-foreground/40">
            Add stems from any separated track and layer them together. Each stem gets its own speed, pitch, and effects.
          </div>
        )}

        {entries.map((entry) => {
          if (entry.loading) {
            const loadingLabel = entry.slot.stemName
              ? `Loading ${entry.slot.stemName} from ${entry.slot.trackId}…`
              : `Loading full track from ${entry.slot.trackId}…`;
            return (
              <div
                key={entry.slot.id}
                className="flex min-h-[160px] items-center justify-center rounded-md border border-border bg-muted/30 px-4 py-8 text-sm text-foreground/40"
              >
                {loadingLabel}
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
          const isReference = entry.slot.id === referenceSlotId;
          const hasReference = referenceSlotId !== null;
          return (
            <SlotStrip
              key={entry.slot.id}
              slot={entry.slot}
              title={entry.title}
              buffer={entry.buffer}
              presets={presets}
              isReference={isReference}
              hasReference={hasReference}
              detectedKey={entry.detectedKey}
              detectedBpm={entry.detectedBpm}
              isMatched={!isReference && entry.isMatched}
              matchedBasePitch={entry.matchedBasePitch}
              pitchInterval={entry.pitchInterval}
              onPitchIntervalChange={(n) => setEntries((prev) => prev.map((e) => e.slot.id === entry.slot.id ? { ...e, pitchInterval: n } : e))}
              onRemove={() => handleRemoveSlot(entry.slot.id)}
              onChange={(patch) => handleSlotChange(entry.slot.id, patch)}
              onSetReference={() => handleSetReference(entry.slot.id)}
              onMatch={() => matchSlotToReference(entry.slot.id)}
              onSavePreset={handleSavePreset}
              onDeletePreset={handleDeletePreset}
              onApplyPreset={(preset) => handleApplyPreset(entry.slot.id, preset)}
            />
          );
        })}

        {entries.length < MAX_STEMS && !showPicker && (
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="min-h-[120px] rounded-md border border-dashed border-border bg-transparent text-sm text-foreground/40 transition hover:border-accent/40 hover:text-foreground/60"
          >
            + Add stem or track
          </button>
        )}

        {showPicker && (
          <SlotPicker
            onConfirm={handlePickerConfirm}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    </>
  );
}
