import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { multiEngine } from "../audio/multiEngine";
import { DRY_EFFECTS, type StemName } from "../audio/dubEngine";
import { sanitizeEffects } from "../store";
import type { MultiMasterSettings, MultiSlot, MultiSession, ThrowSettings } from "../lib/multiSettings";
import { getCachedAudio, putCachedAudio } from "../lib/audioCache";
import {
  loadNamedSessions,
  saveNamedSession,
  deleteNamedSession,
  loadSlotSettings,
  saveSlotSettings,
  loadMultiPresets,
  saveMultiPreset,
  deleteMultiPreset,
  loadThrowSettings,
  saveThrowSettings,
  loadThrowPresets,
  saveThrowPreset,
  deleteThrowPreset,
  type MultiPreset,
  type ThrowPreset,
  loadAnchorKey,
  saveAnchorKey,
  clearAnchorKey,
} from "../lib/multiSettings";
import { getAllTrackMeta, getTrackMeta, putTrackMeta } from "../lib/trackMetaCache";
import { analyzeAudio, rootSemitone, preloadEssentia } from "../lib/audioAnalysis";
import { computeAutoGain, computeStemViability } from "../lib/autoGain";
import { STEM_AUTO_PRESETS, GENRE_PRESETS, randomizeEffects, type StemRole, type GenreName } from "../lib/vibePresets";
import { buildRandomSlots } from "../lib/randomCombinator";
import { SlotStrip } from "../components/multi/SlotStrip";
import { SlotPicker } from "../components/multi/SlotPicker";
import { MultiTransport } from "../components/multi/MultiTransport";
import { buildExport, saveExportToServer, loadExportFromServer, applyImport } from "../lib/multiExport";

const STEM_NAMES_SET = new Set<string>(["drums", "bass", "vocals", "other"]);
const MAX_STEMS = 8;

interface SlotEntry {
  slot: MultiSlot;
  title: string;
  error: string | null;
  loading: boolean;
  buffer: AudioBuffer | null;
  detectedKey: string | null | undefined;
  detectedBpm: number | undefined;
  isMatched: boolean;
  matchedBasePitch: number;
  pitchInterval: 1 | 7 | 12;
}

function parseSlotsParam(raw: string): {
  tokens: Array<{ uuid: string; trackId: string; stemName: StemName | null }>;
  redirect: string | null;
} {
  if (!raw) return { tokens: [], redirect: null };
  const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);
  const results: Array<{ uuid: string; trackId: string; stemName: StemName | null }> = [];
  let needsRedirect = false;

  for (const rawToken of raw.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const firstColon = token.indexOf(":");
    if (firstColon === -1) {
      // Legacy bare trackId
      results.push({ uuid: crypto.randomUUID(), trackId: token, stemName: null });
      needsRedirect = true;
      continue;
    }
    const firstPart = token.slice(0, firstColon);
    const rest = token.slice(firstColon + 1);
    if (isUUID(firstPart)) {
      // New format: uuid:trackId or uuid:trackId:stemName
      const secondColon = rest.indexOf(":");
      if (secondColon === -1) {
        results.push({ uuid: firstPart, trackId: rest, stemName: null });
      } else {
        const trackId = rest.slice(0, secondColon);
        const stemName = rest.slice(secondColon + 1);
        if (!STEM_NAMES_SET.has(stemName)) continue;
        results.push({ uuid: firstPart, trackId, stemName: stemName as StemName });
      }
    } else {
      // Legacy trackId:stemName
      const stemName = rest;
      if (!STEM_NAMES_SET.has(stemName)) continue;
      results.push({ uuid: crypto.randomUUID(), trackId: firstPart, stemName: stemName as StemName });
      needsRedirect = true;
    }
  }

  if (!needsRedirect) return { tokens: results, redirect: null };
  const param = results
    .map(t => t.stemName ? `${t.uuid}:${t.trackId}:${t.stemName}` : `${t.uuid}:${t.trackId}`)
    .join(",");
  return { tokens: results, redirect: param };
}

function encodeSlotsParam(entries: SlotEntry[]): string {
  return entries
    .map((e) => e.slot.stemName
      ? `${e.slot.id}:${e.slot.trackId}:${e.slot.stemName}`
      : `${e.slot.id}:${e.slot.trackId}`)
    .join(",");
}

function pendingKey(trackId: string, stemName: StemName | null): string {
  return stemName ? `${trackId}:${stemName}` : trackId;
}

export function MultiPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const slotsParam = searchParams.get("slots") ?? "";

  const [entries, setEntries] = useState<SlotEntry[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [referenceSlotId, setReferenceSlotId] = useState<string | null>(null);
  const [masterSettings, setMasterSettings] = useState<MultiMasterSettings>(() => ({
    gain: 0,
    loopLengthOverride: null,
    throwSettings: loadThrowSettings(),
  }));
  const [namedSessions, setNamedSessions] = useState<MultiSession[]>(() => loadNamedSessions());
  const [sessionName, setSessionName] = useState("");
  const [activeSessionName, setActiveSessionName] = useState<string | null>(null);
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const sessionsPanelRef = useRef<HTMLDivElement>(null);
  const sessionsBtnRef = useRef<HTMLButtonElement>(null);
  const [presets, setPresets] = useState<MultiPreset[]>(() => loadMultiPresets());
  const [throwPresets, setThrowPresets] = useState<ThrowPreset[]>(() => loadThrowPresets());
  const [exportStatus, setExportStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "imported" | "none" | "error">("idle");
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [library, setLibrary] = useState<{ id: string; title: string }[]>([]);
  const libraryRef = useRef<{ id: string; title: string }[]>([]);
  const libraryPromiseRef = useRef<Promise<{ id: string; title: string }[]> | null>(null);
  const [stemsLibrary, setStemsLibrary] = useState<{ id: string; title: string }[]>([]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const masterSettingsRef = useRef(masterSettings);
  masterSettingsRef.current = masterSettings;
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleDebouncedBackup() {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => {
      saveExportToServer(buildExport(masterSettingsRef.current));
    }, 2000);
  }
  const referenceSlotIdRef = useRef<string | null>(null);
  referenceSlotIdRef.current = referenceSlotId;
  const pendingSessionSlotsRef = useRef<Map<string, MultiSlot>>(new Map());
  const pendingReferenceIdRef = useRef<string | null>(null);
  const viabilityMapRef = useRef<Map<string, boolean>>(new Map());

  // Sync initial throw settings to engine on mount; preload Essentia WASM; seed viability cache
  useEffect(() => {
    if (!localStorage.getItem("vandelay:multi:sessions:v1")) {
      loadExportFromServer().then((data) => {
        if (data) applyImport(data);
      }).catch(() => {});
    }
    multiEngine.setThrowSettings(masterSettings.throwSettings);
    preloadEssentia().catch(() => {});
    getAllTrackMeta().then((entries) => {
      for (const entry of entries) {
        if (!entry.stemViability) continue;
        for (const [stem, viable] of Object.entries(entry.stemViability)) {
          viabilityMapRef.current.set(`${entry.id}:${stem}`, viable);
        }
      }
    }).catch(() => {});
    return () => {
      if (entriesRef.current.length > 0) {
        saveExportToServer(buildExport(masterSettingsRef.current));
      }
      multiEngine.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch library + history for title resolution and random session. Slot loading awaits
  // `libraryPromiseRef` rather than reading `libraryRef` opportunistically, so a slot can never
  // bake in a raw trackId just because it decoded before this resolved.
  const refreshLibrary = useCallback(() => {
    const p = Promise.all([
      fetch("/api/stems/library", { priority: "high" } as RequestInit).then((r) => r.ok ? r.json() as Promise<{ id: string; title: string }[]> : Promise.resolve([])),
      fetch("/api/history", { priority: "high" } as RequestInit).then((r) => r.ok ? r.json() as Promise<{ id: string; title: string }[]> : Promise.resolve([])),
    ]).then(([lib, history]) => {
      setStemsLibrary(lib);
      const merged = new Map(history.map((e) => [e.id, e.title]));
      for (const e of lib) merged.set(e.id, e.title);
      const data = Array.from(merged.entries()).map(([id, title]) => ({ id, title }));
      setLibrary(data);
      libraryRef.current = data;
      return data;
    }).catch(() => libraryRef.current);
    libraryPromiseRef.current = p;
    return p;
  }, []);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Back-fill titles when library loads (race: fast IDB-cached tracks finish before library fetch)
  useEffect(() => {
    if (library.length === 0) return;
    setEntries((prev) =>
      prev.map((e) => {
        const libTitle = library.find((l) => l.id === e.slot.trackId)?.title;
        if (!libTitle) return e;
        return { ...e, title: libTitle };
      }),
    );
  }, [library]);

  // Poll engine running state for Play All / Stop All button
  useEffect(() => {
    const id = setInterval(() => setIsPlayingAll(multiEngine.isRunning()), 100);
    return () => clearInterval(id);
  }, []);

  // Debounced backup to server on any slot change
  useEffect(() => {
    if (entries.length === 0) return;
    scheduleDebouncedBackup();
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // 1. Apply pending reference from session load
    if (pendingReferenceIdRef.current !== null) {
      setReferenceSlotId(pendingReferenceIdRef.current);
      referenceSlotIdRef.current = pendingReferenceIdRef.current;
      pendingReferenceIdRef.current = null;
    }

    // 2. Parse + redirect check — BEFORE anchor restore
    const { tokens: pairs, redirect } = parseSlotsParam(slotsParam);
    if (redirect !== null) {
      navigate(`/?slots=${redirect}`, { replace: true });
      return;
    }

    // 3. Anchor restore from localStorage — AFTER parseSlotsParam (needs pairs)
    if (referenceSlotIdRef.current === null) {
      const savedAnchor = loadAnchorKey();
      if (savedAnchor) {
        const anchorToken = pairs.find(t => t.trackId === savedAnchor.trackId && t.stemName === savedAnchor.stemName);
        if (anchorToken) {
          setReferenceSlotId(anchorToken.uuid);
          referenceSlotIdRef.current = anchorToken.uuid;
        }
      }
    }

    const current = entriesRef.current;

    const next: SlotEntry[] = pairs.map((pair) => {
      const existing = current.find((e) => e.slot.id === pair.uuid);
      if (existing) return existing;
      const id = pair.uuid;
      const slot: MultiSlot = {
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
        multiEngine.removeSlot(old.slot.id);
      }
    }

    setEntries(next);

    let cancelled = false;
    (async () => {
      await Promise.all(next.map(async (entry) => {
        if (!entry.loading) return;
        if (cancelled) return;

        const { slot } = entry;
        const label = slot.stemName ? `${slot.stemName}:${slot.trackId}` : `track:${slot.trackId}`;
        console.time(`[multi] ${label} total`);
        let buffer: AudioBuffer;
        try {
          if (slot.stemName === null) {
            const cacheKey = slot.trackId;
            let arrayBuffer = await getCachedAudio(cacheKey);
            console.log(`[multi] ${label} idb: ${arrayBuffer ? "HIT" : "MISS"}`);
            if (!arrayBuffer) {
              console.time(`[multi] ${label} fetch`);
              const res = await fetch(`/api/audio/${slot.trackId}`);
              if (!res.ok) {
                if (res.status === 404) throw new Error("Track not found");
                throw new Error(`Server error ${res.status}`);
              }
              arrayBuffer = await res.arrayBuffer();
              console.timeEnd(`[multi] ${label} fetch`);
              putCachedAudio(cacheKey, arrayBuffer.slice(0));
            }
            console.time(`[multi] ${label} decode`);
            const decodeCtx = new AudioContext();
            buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
            decodeCtx.close();
            console.timeEnd(`[multi] ${label} decode`);
          } else {
            const cacheKey = `stem:${slot.trackId}:${slot.stemName}:mp3`;
            let arrayBuffer = await getCachedAudio(cacheKey);
            console.log(`[multi] ${label} idb: ${arrayBuffer ? "HIT" : "MISS"}`);
            if (!arrayBuffer) {
              console.time(`[multi] ${label} fetch`);
              const res = await fetch(`/api/stems/${slot.trackId}/${slot.stemName}`);
              if (!res.ok) {
                if (res.status === 404) throw new Error("Stem not found — separate this track first");
                throw new Error(`Server error ${res.status}`);
              }
              arrayBuffer = await res.arrayBuffer();
              console.timeEnd(`[multi] ${label} fetch`);
              putCachedAudio(cacheKey, arrayBuffer.slice(0));
            }
            console.time(`[multi] ${label} decode`);
            const decodeCtx = new AudioContext();
            buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
            decodeCtx.close();
            console.timeEnd(`[multi] ${label} decode`);
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
          return;
        }

        if (cancelled) return;

        // Viability check + key cache read — single IDB fetch
        const cachedMeta = await getTrackMeta(slot.trackId);
        // Compute + cache stem viability if not already known
        const stemRole = slot.stemName ?? "full";
        const viabilityKey = `${slot.trackId}:${stemRole}`;
        const cachedViability = cachedMeta?.stemViability?.[stemRole];
        if (cachedViability === undefined) {
          const viable = computeStemViability(buffer);
          viabilityMapRef.current.set(viabilityKey, viable);
          const metaTitle = libraryRef.current.find((e) => e.id === slot.trackId)?.title ?? slot.trackId;
          putTrackMeta({
            ...(cachedMeta ?? { id: slot.trackId, title: metaTitle, duration: buffer.duration, addedAt: Date.now() }),
            stemViability: { ...(cachedMeta?.stemViability ?? {}), [stemRole]: viable },
          });
        } else {
          viabilityMapRef.current.set(viabilityKey, cachedViability);
        }

        let detectedKey: string | null | undefined;
        let detectedBpm: number | undefined;
        if (cachedMeta && cachedMeta.detectedKey !== undefined) {
          detectedKey = cachedMeta.detectedKey;
          detectedBpm = cachedMeta.detectedBpm;
          console.log(`[multi] ${label} key cache: HIT (${detectedKey ?? "null"})`);
        } else {
          console.log(`[multi] ${label} key cache: MISS — Essentia will run in background`);
        }
        // If not cached, detectedKey stays undefined — slot shows ? badge, Essentia runs later

        if (cancelled) return;

        const dur = buffer.duration;
        const pk = pendingKey(slot.trackId, slot.stemName);
        const pendingSlot = pendingSessionSlotsRef.current.get(pk);
        const saved = pendingSlot ? null : loadSlotSettings(slot.id);
        let finalSlot: MultiSlot;
        if (pendingSlot) {
          pendingSessionSlotsRef.current.delete(pk);
          finalSlot = {
            ...pendingSlot,
            id: slot.id,
            loopStart: Math.max(0, Math.min(pendingSlot.loopStart, dur - 0.01)),
            loopEnd: Math.min(dur, pendingSlot.loopEnd > 0 ? pendingSlot.loopEnd : dur),
          };
        } else {
          const stemRole: StemRole = slot.stemName ?? "full";
          finalSlot = {
            ...slot,
            loopStart: saved ? Math.max(0, saved.loopStartFrac * dur) : 0,
            loopEnd: saved ? Math.min(dur, saved.loopEndFrac * dur) : dur,
            speed: saved?.speed ?? slot.speed,
            pitch: saved?.pitch ?? slot.pitch,
            linkPitch: saved?.linkPitch ?? slot.linkPitch,
            gain: saved?.gain ?? computeAutoGain(buffer),
            muted: saved?.muted ?? slot.muted,
            effects: saved?.effects ?? sanitizeEffects({ ...DRY_EFFECTS }),
          };
        }

        const isMatched = saved?.isMatched ?? false;
        const matchedBasePitch = saved?.matchedBasePitch ?? 0;
        const pitchInterval: 1 | 7 | 12 = saved?.pitchInterval ?? 12;

        // Wait for the in-flight library fetch, then refetch once if this id is still unknown
        // (separated in another tab after we mounted). Only falls back to the raw id if the
        // server genuinely has no title for it.
        let lib = (await libraryPromiseRef.current) ?? libraryRef.current;
        if (!lib.some((e) => e.id === slot.trackId)) lib = await refreshLibrary();
        const title = lib.find((e) => e.id === slot.trackId)?.title ?? slot.trackId;

        if (cancelled) return;

        await multiEngine.addSlot(finalSlot, buffer);
        console.timeEnd(`[multi] ${label} total`);
        console.log(`[multi] ${label} READY (key: ${detectedKey ?? "pending"})`);

        // Slot is now playable — display immediately
        setEntries((prev) =>
          prev.map((en) =>
            en.slot.id === slot.id
              ? { ...en, slot: finalSlot, title, loading: false, error: null, buffer, detectedKey, detectedBpm, isMatched, matchedBasePitch, pitchInterval }
              : en,
          ),
        );

        saveSlotSettings(finalSlot.id, {
          speed: finalSlot.speed, pitch: finalSlot.pitch, linkPitch: finalSlot.linkPitch,
          gain: finalSlot.gain, muted: finalSlot.muted, effects: finalSlot.effects,
          loopStartFrac: finalSlot.loopStart / dur, loopEndFrac: finalSlot.loopEnd / dur,
          isMatched: pendingSlot?.isMatched, matchedBasePitch: pendingSlot?.matchedBasePitch,
        });

        // Background key detection — only if not already cached
        if (cachedMeta?.detectedKey === undefined) {
          (async () => {
            try {
              console.time(`[multi] ${label} essentia`);
              const result = await analyzeAudio(buffer);
              console.timeEnd(`[multi] ${label} essentia`);
              console.log(`[multi] ${label} key detected: ${result?.key ?? "null"}`);
              if (cancelled) return;
              const key = result?.key ?? null;
              const bpm = result?.bpm;
              const metaTitle = libraryRef.current.find((e) => e.id === slot.trackId)?.title ?? slot.trackId;
              await putTrackMeta({
                ...(cachedMeta ?? { id: slot.trackId, title: metaTitle, duration: dur, addedAt: Date.now() }),
                detectedKey: key,
                detectedBpm: bpm,
              });
              if (cancelled) return;

              // Update key badge only — matching is manual via "Match All"
              setEntries((prev) =>
                prev.map((en) =>
                  en.slot.id === slot.id ? { ...en, detectedKey: key, detectedBpm: bpm } : en,
                ),
              );
            } catch {
              if (!cancelled) setEntries((prev) => prev.map((en) => en.slot.id === slot.id ? { ...en, detectedKey: null } : en));
            }
          })();
        }
      }));
    })();

    return () => { cancelled = true; };
  }, [slotsParam]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSlotChange(id: string, patch: Partial<MultiSlot>) {
    setEntries((prev) =>
      prev.map((e) => {
        if (e.slot.id !== id) return e;
        const clearMatch = patch.speed !== undefined;
        const updated = { ...e, slot: { ...e.slot, ...patch }, isMatched: clearMatch ? false : e.isMatched };
        if (clearMatch) {
          const dur = e.buffer?.duration ?? 1;
          const s = updated.slot;
          saveSlotSettings(s.id, {
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
    navigate(param ? `/?slots=${param}` : "/");
  }

  function handlePickerConfirm(trackId: string, stemName: StemName | null) {
    setShowPicker(false);
    if (entries.length >= MAX_STEMS) return;
    const uuid = crypto.randomUUID();
    const token = stemName ? `${uuid}:${trackId}:${stemName}` : `${uuid}:${trackId}`;
    const current = encodeSlotsParam(entries);
    const param = current ? `${current},${token}` : token;
    navigate(`/?slots=${param}`);
  }

  function handleSetReference(slotId: string) {
    const isAlreadyRef = referenceSlotIdRef.current === slotId;
    const newRefId = isAlreadyRef ? null : slotId;
    setReferenceSlotId(newRefId);
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
    saveSlotSettings(s.id, {
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

    multiEngine.updateSlot(targetSlotId, { speed, pitch, linkPitch });
    setEntries((prev) =>
      prev.map((e) =>
        e.slot.id === targetSlotId
          ? { ...e, slot: { ...e.slot, speed, pitch, linkPitch }, isMatched: true, matchedBasePitch: pitch }
          : e,
      ),
    );
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

  function handleApplyGenre(genre: GenreName) {
    setEntries((prev) => prev.map((e) => {
      if (e.loading || e.error) return e;
      const role: StemRole = e.slot.stemName ?? "full";
      const overrides = GENRE_PRESETS[genre][role];
      const newEffects = sanitizeEffects({ ...e.slot.effects, ...overrides });
      const newSlot = { ...e.slot, effects: newEffects };
      multiEngine.updateSlot(newSlot.id, { effects: newEffects });
      const dur = e.buffer?.duration ?? 1;
      saveSlotSettings(newSlot.id, {
        speed: newSlot.speed, pitch: newSlot.pitch, linkPitch: newSlot.linkPitch,
        gain: newSlot.gain, muted: newSlot.muted, effects: newEffects,
        loopStartFrac: newSlot.loopStart / dur, loopEndFrac: newSlot.loopEnd / dur,
      });
      return { ...e, slot: newSlot };
    }));
  }

  function handleRandomizeAll() {
    setEntries((prev) => prev.map((e) => {
      if (e.loading || e.error) return e;
      const role: StemRole = e.slot.stemName ?? "full";
      const newEffects = randomizeEffects(e.slot.effects, role);
      const newSlot = { ...e.slot, effects: newEffects };
      multiEngine.updateSlot(newSlot.id, { effects: newEffects });
      const dur = e.buffer?.duration ?? 1;
      saveSlotSettings(newSlot.id, {
        speed: newSlot.speed, pitch: newSlot.pitch, linkPitch: newSlot.linkPitch,
        gain: newSlot.gain, muted: newSlot.muted, effects: newEffects,
        loopStartFrac: newSlot.loopStart / dur, loopEndFrac: newSlot.loopEnd / dur,
      });
      return { ...e, slot: newSlot };
    }));
  }

  function handleRandomSession() {
    const slots = buildRandomSlots(stemsLibrary, viabilityMapRef.current);
    if (!slots) return;
    const uuids = slots.map(() => crypto.randomUUID());
    const param = slots.map((s, i) => `${uuids[i]}:${s.trackId}:${s.stemName}`).join(",");
    // Prefer pitched stems as anchor — drums have no key so avoid them
    const anchorPriority = ["vocals", "bass", "other", "drums"];
    const anchorIdx = anchorPriority.reduce((best, stemName) => {
      if (best !== -1) return best;
      return slots.findIndex((s) => s.stemName === stemName);
    }, -1);
    pendingReferenceIdRef.current = uuids[anchorIdx === -1 ? 0 : anchorIdx];
    navigate(`/?slots=${param}`);
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
    setActiveSessionName(name);
    saveExportToServer(buildExport(masterSettingsRef.current));
  }

  function handleLoadSession(session: MultiSession) {
    setActiveSessionName(session.name);
    const ms = session.masterSettings;
    setMasterSettings(ms);
    multiEngine.setMasterSettings(ms);
    multiEngine.setThrowSettings(ms.throwSettings);

    const slotsWithIds = session.slots.map((s) => ({
      ...s,
      id: crypto.randomUUID(), // always fresh so URL changes and reconciler re-runs
    }));

    pendingSessionSlotsRef.current = new Map(
      slotsWithIds.map((s) => [pendingKey(s.trackId, s.stemName), s]),
    );

    const refSlot = slotsWithIds.find((s) => s.isReference);
    pendingReferenceIdRef.current = refSlot ? refSlot.id : null;

    const param = slotsWithIds
      .map((s) => s.stemName ? `${s.id}:${s.trackId}:${s.stemName}` : `${s.id}:${s.trackId}`)
      .join(",");
    multiEngine.stop();
    navigate(param ? `/?slots=${param}` : "/");
  }

  function handleDeleteSession(name: string) {
    setNamedSessions(deleteNamedSession(name));
    saveExportToServer(buildExport(masterSettingsRef.current));
  }

  function handleSavePreset(name: string, preset: Omit<MultiPreset, "name">) {
    setPresets(saveMultiPreset(name, preset));
  }

  function handleDeletePreset(name: string) {
    setPresets(deleteMultiPreset(name));
  }

  function handleApplyPreset(slotId: string, preset: MultiPreset) {
    const patch = {
      effects: preset.effects,
      speed: preset.speed,
      pitch: preset.pitch,
      linkPitch: preset.linkPitch,
      gain: preset.gain,
    };
    multiEngine.updateSlot(slotId, patch);
    setEntries((prev) =>
      prev.map((e) => {
        if (e.slot.id !== slotId) return e;
        const s = { ...e.slot, ...patch };
        const dur = e.buffer?.duration ?? 1;
        saveSlotSettings(s.id, {
          speed: s.speed, pitch: s.pitch, linkPitch: s.linkPitch,
          gain: s.gain, muted: s.muted, effects: s.effects,
          loopStartFrac: s.loopStart / dur, loopEndFrac: s.loopEnd / dur,
          isMatched: false, matchedBasePitch: 0,
        });
        return { ...e, slot: s, isMatched: false, matchedBasePitch: 0 };
      }),
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
    multiEngine.setThrowSettings(preset.settings);
    setMasterSettings((prev) => ({ ...prev, throwSettings: preset.settings }));
    saveThrowSettings(preset.settings);
  }

  async function handleExport() {
    setExportStatus("saving");
    try {
      await saveExportToServer(buildExport(masterSettings));
      setExportStatus("saved");
      setTimeout(() => setExportStatus("idle"), 2000);
    } catch {
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2000);
    }
  }

  async function handleImport() {
    setImportStatus("importing");
    try {
      const data = await loadExportFromServer();
      if (!data) {
        setImportStatus("none");
        setTimeout(() => setImportStatus("idle"), 2000);
        return;
      }
      if (!window.confirm("This will replace all existing sessions, presets, and settings. Continue?")) {
        setImportStatus("idle");
        return;
      }
      applyImport(data);
      setNamedSessions(data.namedSessions);
      setPresets(data.presets);
      setThrowPresets(data.throwPresets);
      setMasterSettings(data.masterSettings);
      multiEngine.setMasterSettings(data.masterSettings);
      multiEngine.setThrowSettings(data.masterSettings.throwSettings);
      setImportStatus("imported");
      setTimeout(() => setImportStatus("idle"), 2000);
    } catch {
      setImportStatus("error");
      setTimeout(() => setImportStatus("idle"), 2000);
    }
  }

  async function handlePlayAll() {
    await multiEngine.play();
  }

  function handleStopAll() {
    multiEngine.stop();
  }

  function handleClear() {
    navigate("/");
  }

  const portalTarget = document.getElementById("multi-transport-portal");
  const topBar = (
    <div className="relative flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
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

            <div className="flex items-center gap-2 border-t border-border/30 pt-2 mt-1">
              <button
                type="button"
                onClick={handleImport}
                disabled={importStatus === "importing"}
                className="flex-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground/50 transition hover:text-foreground disabled:opacity-50"
              >
                {importStatus === "importing" ? "…"
                  : importStatus === "imported" ? "Restored ✓"
                  : importStatus === "none" ? "No backup found"
                  : importStatus === "error" ? "Error"
                  : "↑ Restore"}
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exportStatus === "saving"}
                className="flex-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground/50 transition hover:text-foreground disabled:opacity-50"
              >
                {exportStatus === "saving" ? "…"
                  : exportStatus === "saved" ? "Backed up ✓"
                  : exportStatus === "error" ? "Error"
                  : "↓ Backup"}
              </button>
            </div>
          </div>
        )}

        <div className="h-4 w-px shrink-0 bg-border/50" />

        <MultiTransport
          masterSettings={masterSettings}
          slotCount={entries.length}
          referenceSlotId={referenceSlotId}
          activeSessionName={activeSessionName}
          slotTitles={entries.map((e) => e.title)}
          getSlotsAndBuffers={getSlotsAndBuffers.current}
          onPlayAll={handlePlayAll}
          onStopAll={handleStopAll}
          onRewindAll={() => { for (const e of entries) multiEngine.seekSlot(e.slot.id, e.slot.loopStart); }}
          onThrowSettingsChange={handleThrowSettingsChange}
          throwPresets={throwPresets}
          onSaveThrowPreset={handleSaveThrowPreset}
          onDeleteThrowPreset={handleDeleteThrowPreset}
          onApplyThrowPreset={handleApplyThrowPreset}
          isPlaying={isPlayingAll}
          onMatchAll={handleMatchAll}
          onApplyGenre={handleApplyGenre}
          onRandomizeAll={handleRandomizeAll}
          onRandomSession={handleRandomSession}
          randomDisabled={stemsLibrary.length < 2}
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
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto content-start">
        {entries.length === 0 && !showPicker && (
          <div className="col-span-2 flex items-center justify-center py-24">
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className="text-sm text-foreground/30 hover:text-foreground/60 transition"
            >
              + Add stem or track
            </button>
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

        {entries.length > 0 && entries.length < MAX_STEMS && !showPicker && (
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
            library={stemsLibrary}
            onConfirm={handlePickerConfirm}
            onClose={() => setShowPicker(false)}
            onLibraryUpdated={(lib) => {
              setStemsLibrary(lib);
              // Also merge into `library`/`libraryRef` — those drive slot title resolution.
              // Without this a freshly separated track shows its raw id until a page refresh.
              const merged = new Map(libraryRef.current.map((e) => [e.id, e.title]));
              for (const e of lib) merged.set(e.id, e.title);
              const next = Array.from(merged.entries()).map(([id, title]) => ({ id, title }));
              libraryRef.current = next;
              setLibrary(next);
            }}
          />
        )}
      </div>
    </>
  );
}
