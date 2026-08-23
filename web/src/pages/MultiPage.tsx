import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  renameNamedSession,
  loadSlotSettings,
  saveSlotSettings,
  loadMultiPresets,
  saveMultiPreset,
  deleteMultiPreset,
  loadThrowSettings,
  saveThrowSettings,
  loadMasterSpeed,
  saveMasterSpeed,
  loadThrowPresets,
  saveThrowPreset,
  deleteThrowPreset,
  type MultiPreset,
  type ThrowPreset,
  loadAnchorKey,
  saveAnchorKey,
  clearAnchorKey,
  loadActiveSessionName,
  saveActiveSessionName,
  loadTempoAnchorKey,
  saveTempoAnchorKey,
  clearTempoAnchorKey,
} from "../lib/multiSettings";
import { getAllTrackMeta, getTrackMeta, putTrackMeta } from "../lib/trackMetaCache";
import { analyzeAudio, rootSemitone, preloadEssentia } from "../lib/audioAnalysis";
import { stretchBuffer } from "../audio/stretchBuffer";
import { estimateBpm, quantizeToGrid } from "../lib/loopSnap";
import { computeAutoGain, computeStemViability } from "../lib/autoGain";
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
  /** The untouched decode. Stretching always works from this so repeats don't compound. */
  sourceBuffer: AudioBuffer | null;
  /** Length multiple currently applied to sourceBuffer; 1 = playing the original. */
  stretch: number;
  /** True while a stretch is being computed, so the UI can show progress. */
  stretching: boolean;
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
  /** Slot whose tempo the others stretch to match. Independent of the key anchor. */
  const [tempoAnchorId, setTempoAnchorId] = useState<string | null>(null);
  /** Result of the last quantize pass, shown in the transport so a skipped slot is visible. */
  const [gridNote, setGridNote] = useState<string | null>(null);

  /**
   * Per-buffer BPM cache. estimateBpm costs ~30ms on a 3-minute stem, and stale detection
   * would otherwise re-measure every slot on every render — a quarter-second stall per
   * frame with a full rack. Keyed on buffer identity, which is stable for a given decode.
   */
  const bpmCacheRef = useRef(new WeakMap<AudioBuffer, number | undefined>());
  const sourceBpm = useCallback((buf: AudioBuffer | null): number | undefined => {
    if (!buf) return undefined;
    const cache = bpmCacheRef.current;
    if (cache.has(buf)) return cache.get(buf);
    const bpm = estimateBpm(buf);
    cache.set(buf, bpm);
    return bpm;
  }, []);

  // estimateBpm autocorrelates the whole buffer, so this must not run per render. Keyed on
  // the anchor's buffer identity rather than `entries` — playback and stretch flags churn
  // that array constantly, and none of them change the anchor's tempo.
  const anchorEntryForBpm = entries.find((e) => e.slot.id === tempoAnchorId);
  const anchorBpmSource = anchorEntryForBpm?.sourceBuffer ?? anchorEntryForBpm?.buffer ?? null;
  const anchorDetectedBpm = anchorEntryForBpm?.detectedBpm;
  const anchorBpm = useMemo(() => {
    if (!tempoAnchorId) return undefined;
    return anchorDetectedBpm ?? sourceBpm(anchorBpmSource);
  }, [tempoAnchorId, anchorDetectedBpm, anchorBpmSource, sourceBpm]);

  /**
   * Slots whose stretch no longer agrees with the anchor's current tempo.
   *
   * The case this catches: you match everything, then re-snap or swap the anchor. Every
   * other slot is now stretched to a tempo that no longer exists, and nothing else in the
   * UI would say so. Only already-matched slots qualify — an untouched slot is unmatched,
   * which is a different thing and shouldn't nag.
   */
  const staleTempoIds = useMemo(() => {
    const out = new Set<string>();
    if (!tempoAnchorId || !anchorBpm) return out;
    for (const e of entries) {
      if (e.slot.id === tempoAnchorId || e.loading) continue;
      if (Math.abs(e.stretch - 1) <= 0.005) continue;
      const bpm = e.detectedBpm ?? sourceBpm(e.sourceBuffer);
      if (!bpm) continue;
      const want = tempoStretchRatio(bpm, anchorBpm);
      if (Math.abs(want - e.stretch) > 0.01) out.add(e.slot.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempoAnchorId, anchorBpm, entries]);
  const [masterSettings, setMasterSettings] = useState<MultiMasterSettings>(() => ({
    gain: 0,
    loopLengthOverride: null,
    masterSpeed: loadMasterSpeed(),
    throwSettings: loadThrowSettings(),
  }));
  const [namedSessions, setNamedSessions] = useState<MultiSession[]>(() => loadNamedSessions());
  const [sessionName, setSessionName] = useState("");
  // Lazy initialiser so the header shows the right name on the very first paint after a
  // reload, rather than flashing "Sessions" and correcting itself.
  const [activeSessionName, setActiveSessionName] = useState<string | null>(loadActiveSessionName);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const sessionsPanelRef = useRef<HTMLDivElement>(null);
  const sessionsBtnRef = useRef<HTMLButtonElement>(null);
  const [presets, setPresets] = useState<MultiPreset[]>(() => loadMultiPresets());
  const [throwPresets, setThrowPresets] = useState<ThrowPreset[]>(() => loadThrowPresets());
  const [exportStatus, setExportStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "imported" | "none" | "error">("idle");
  /** Name of the session that just saved — drives the transient ✓ on its row. "" = the new-session form. */
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [library, setLibrary] = useState<{ id: string; title: string }[]>([]);
  const libraryRef = useRef<{ id: string; title: string }[]>([]);
  const libraryPromiseRef = useRef<Promise<{ id: string; title: string }[]> | null>(null);
  const [stemsLibrary, setStemsLibrary] = useState<{ id: string; title: string }[]>([]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const masterSettingsRef = useRef(masterSettings);
  masterSettingsRef.current = masterSettings;
  const referenceSlotIdRef = useRef<string | null>(null);
  referenceSlotIdRef.current = referenceSlotId;
  const tempoAnchorIdRef = useRef<string | null>(null);
  tempoAnchorIdRef.current = tempoAnchorId;
  const pendingSessionSlotsRef = useRef<Map<string, MultiSlot>>(new Map());
  const pendingReferenceIdRef = useRef<string | null>(null);
  const pendingTempoAnchorIdRef = useRef<string | null>(null);
  const viabilityMapRef = useRef<Map<string, boolean>>(new Map());

  // Mirror the active session name to localStorage. Done as an effect rather than at each
  // setter so every path that changes it — save, resave, load, rename, clear — persists.
  useEffect(() => { saveActiveSessionName(activeSessionName); }, [activeSessionName]);

  // Drop the restored name if it no longer refers to a real session — a session deleted in
  // another tab, or a stale value left behind. Better to show "Sessions" than to name a
  // session that does not exist.
  useEffect(() => {
    if (!activeSessionName) return;
    if (!namedSessions.some((s) => s.name === activeSessionName)) setActiveSessionName(null);
  }, [activeSessionName, namedSessions]);

  // Sync initial throw settings to engine on mount; preload Essentia WASM; seed viability cache
  useEffect(() => {
    if (!localStorage.getItem("vandelay:multi:sessions:v1")) {
      loadExportFromServer().then((data) => {
        if (data) applyImport(data);
      }).catch(() => {});
    }
    multiEngine.setThrowSettings(masterSettings.throwSettings);
    // The engine defaults masterSpeed to 1; without this a persisted value would show in
    // the dial while every slot still played at full rate.
    multiEngine.setMasterSettings(masterSettingsRef.current);
    preloadEssentia().catch(() => {});
    getAllTrackMeta().then((entries) => {
      for (const entry of entries) {
        if (!entry.stemViability) continue;
        for (const [stem, viable] of Object.entries(entry.stemViability)) {
          viabilityMapRef.current.set(`${entry.id}:${stem}`, viable);
        }
      }
    }).catch(() => {});
    // No auto-backup on unmount: multi-state.json is committed to git, and writing it on every
    // page unload left the working tree permanently dirty. Use ↓ Backup in the Sessions panel.
    return () => {
      multiEngine.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch library + history for title resolution and random session. Slot loading awaits
  // `libraryPromiseRef` rather than reading `libraryRef` opportunistically, so a slot can never
  // bake in a raw trackId just because it decoded before this resolved.
  const refreshLibrary = useCallback(() => {
    const p = Promise.all([
      fetch("/api/stems/library", { priority: "high", cache: "no-store" } as RequestInit).then((r) => r.ok ? r.json() as Promise<{ id: string; title: string }[]> : Promise.resolve([])),
      fetch("/api/history", { priority: "high", cache: "no-store" } as RequestInit).then((r) => r.ok ? r.json() as Promise<{ id: string; title: string }[]> : Promise.resolve([])),
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
    // Same staging for the tempo anchor: the session's slot UUIDs are minted fresh on load,
    // so the localStorage anchor (keyed by trackId+stem) must not win over the session's.
    if (pendingTempoAnchorIdRef.current !== null) {
      setTempoAnchorId(pendingTempoAnchorIdRef.current);
      tempoAnchorIdRef.current = pendingTempoAnchorIdRef.current;
      pendingTempoAnchorIdRef.current = null;
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

    // Same restore for the tempo anchor. Must also be synchronous (before any await) so the
    // decode loop below sees it when it re-applies each slot's saved stretch.
    if (tempoAnchorIdRef.current === null) {
      const savedTempo = loadTempoAnchorKey();
      if (savedTempo) {
        const token = pairs.find(t => t.trackId === savedTempo.trackId && t.stemName === savedTempo.stemName);
        if (token) {
          setTempoAnchorId(token.uuid);
          tempoAnchorIdRef.current = token.uuid;
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
        // Drums are unpitched, so holding them at tempo under a slowed bed costs no key
        // relationship. Default the bypass on; the strip's Master/Free toggle overrides it.
        bypassMasterSpeed: pair.stemName === "drums",
        gain: 0,
        muted: false,
        soloed: false,
        effects: { ...DRY_EFFECTS },
        loopStart: 0,
        loopEnd: 0,
      };
      return { slot, title: pair.trackId, error: null, loading: true, buffer: null, detectedKey: undefined, detectedBpm: undefined, isMatched: false, matchedBasePitch: 0, pitchInterval: 12, sourceBuffer: null, stretch: 1, stretching: false };
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

        // Peek at the staged session slot; the pendingSlot lookup further down is what
        // actually consumes it from the map.
        const sessionSlot = pendingSessionSlotsRef.current.get(pendingKey(slot.trackId, slot.stemName));
        let detectedKey: string | null | undefined;
        let detectedBpm: number | undefined;
        const stemAnalysis = cachedMeta?.stemAnalysis?.[stemRole];
        if (stemAnalysis) {
          detectedKey = stemAnalysis.key;
          detectedBpm = stemAnalysis.bpm;
          console.log(`[multi] ${label} key cache: HIT (${detectedKey ?? "null"})`);
        } else if (stemRole === "full" && cachedMeta && cachedMeta.detectedKey !== undefined) {
          // Legacy records predate per-stem storage; only trustworthy for the full track.
          detectedKey = cachedMeta.detectedKey;
          detectedBpm = cachedMeta.detectedBpm;
          console.log(`[multi] ${label} key cache: HIT legacy (${detectedKey ?? "null"})`);
        } else if (sessionSlot?.detectedKey !== undefined || sessionSlot?.detectedBpm !== undefined) {
          // Session snapshot as a fallback: the IndexedDB analysis cache usually covers this,
          // but it is a separate store, so a session restored on a machine (or profile) that
          // never analysed these stems would otherwise show ? until Essentia caught up.
          detectedKey = sessionSlot.detectedKey;
          detectedBpm = sessionSlot.detectedBpm;
          console.log(`[multi] ${label} key cache: from session snapshot`);
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
          // Session loop bounds are absolute seconds in whatever timebase the slot was in
          // when saved — so a stretched slot saved them against its stretched length. The
          // buffer here is the unstretched decode, and reapplyStretch below will rescale
          // these by the same ratio, so divide it out first. Clamping the stretched values
          // against the shorter source duration was truncating the loop, and the error
          // compounded on every save/load cycle.
          const savedRatio =
            pendingSlot.stretch && Number.isFinite(pendingSlot.stretch) && pendingSlot.stretch > 0
              ? pendingSlot.stretch
              : 1;
          const srcStart = pendingSlot.loopStart / savedRatio;
          const srcEnd = pendingSlot.loopEnd / savedRatio;
          finalSlot = {
            ...pendingSlot,
            id: slot.id,
            loopStart: Math.max(0, Math.min(srcStart, dur - 0.01)),
            loopEnd: Math.min(dur, srcEnd > 0 ? srcEnd : dur),
          };
        } else {
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
            bypassMasterSpeed: saved?.bypassMasterSpeed ?? slot.bypassMasterSpeed,
            // Loop bounds already encode the shift; these restore which button reads as
            // active and where future phase changes rotate from.
            phase: saved?.phase ?? slot.phase,
            phaseBaseStart:
              saved?.phaseBaseStartFrac !== undefined ? saved.phaseBaseStartFrac * dur : undefined,
            phaseBaseEnd:
              saved?.phaseBaseEndFrac !== undefined ? saved.phaseBaseEndFrac * dur : undefined,
          };
        }

        // A session load supplies pendingSlot and leaves `saved` null. Reading only `saved`
        // silently reset every match flag to false, which is why a restored session looked
        // unmatched even though the numbers underneath were correct.
        const isMatched = (pendingSlot ? pendingSlot.isMatched : saved?.isMatched) ?? false;
        const matchedBasePitch =
          (pendingSlot ? pendingSlot.matchedBasePitch : saved?.matchedBasePitch) ?? 0;
        const pitchInterval: 1 | 7 | 12 =
          (pendingSlot ? pendingSlot.pitchInterval : saved?.pitchInterval) ?? 12;
        // Re-applied after the slot is live, so the buffer matches the tempo anchor the
        // restored UI claims it is synced to. Guarded against absurd saved values.
        // Session load supplies pendingSlot and leaves `saved` null, so the stretch has to
        // be read from whichever of the two actually provided this slot.
        const savedStretch = pendingSlot ? pendingSlot.stretch : saved?.stretch;
        const restoreStretch =
          savedStretch !== undefined &&
          Number.isFinite(savedStretch) &&
          savedStretch > 0.25 &&
          savedStretch < 4 &&
          Math.abs(savedStretch - 1) > 0.005
            ? savedStretch
            : null;

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
              ? { ...en, slot: finalSlot, title, loading: false, error: null, buffer, sourceBuffer: buffer, stretch: 1, stretching: false, detectedKey, detectedBpm, isMatched, matchedBasePitch, pitchInterval }
              : en,
          ),
        );

        // Engine holds the freshly decoded (unstretched) buffer here, so the base is 1.
        if (restoreStretch !== null) void reapplyStretch(slot.id, buffer, restoreStretch, 1);

        saveSlotSettings(finalSlot.id, {
          speed: finalSlot.speed, pitch: finalSlot.pitch, linkPitch: finalSlot.linkPitch,
          gain: finalSlot.gain, muted: finalSlot.muted, effects: finalSlot.effects,
          loopStartFrac: finalSlot.loopStart / dur, loopEndFrac: finalSlot.loopEnd / dur,
          isMatched: pendingSlot?.isMatched, matchedBasePitch: pendingSlot?.matchedBasePitch,
          // Keep the ratio we are about to re-apply, so a refresh before any further edit
          // does not lose it.
          stretch: restoreStretch ?? undefined,
          phase: finalSlot.phase,
          phaseBaseStartFrac: finalSlot.phaseBaseStart !== undefined ? finalSlot.phaseBaseStart / dur : undefined,
          phaseBaseEndFrac: finalSlot.phaseBaseEnd !== undefined ? finalSlot.phaseBaseEnd / dur : undefined,
        });

        // Background analysis — only if this stem has no cached result at all. Keyed on the
        // record's presence, not on detectedKey: unpitched stems cache a null key with a
        // valid BPM, and gating on the key alone would re-analyse them on every load.
        // A record written before key/tempo were decoupled can hold a key with no BPM (or
        // neither). Treat a missing BPM as incomplete so those heal on load instead of
        // staying stale forever behind a cache HIT.
        const analysisCached = stemAnalysis !== undefined
          ? stemAnalysis.bpm !== undefined
          : stemRole === "full" && cachedMeta?.detectedKey !== undefined
            && cachedMeta?.detectedBpm !== undefined;
        if (!analysisCached) {
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
              // Re-read: several stems of one track analyse concurrently and each would
              // otherwise write a stale copy of the record, dropping the others' results.
              const fresh = (await getTrackMeta(slot.trackId)) ?? cachedMeta;
              await putTrackMeta({
                ...(fresh ?? { id: slot.trackId, title: metaTitle, duration: dur, addedAt: Date.now() }),
                stemAnalysis: {
                  ...(fresh?.stemAnalysis ?? {}),
                  [stemRole]: { key, bpm },
                },
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
            // saveSlotSettings replaces the whole record, so omitting this dropped the
            // stretch and the slot came back unstretched on the next refresh.
            stretch: e.stretch,
            phase: s.phase,
          phaseBaseStartFrac: s.phaseBaseStart !== undefined ? s.phaseBaseStart / dur : undefined,
          phaseBaseEndFrac: s.phaseBaseEnd !== undefined ? s.phaseBaseEnd / dur : undefined,
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
    if (tempoAnchorId === id) {
      setTempoAnchorId(null);
      tempoAnchorIdRef.current = null;
      clearTempoAnchorKey();
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
      stretch: entry.stretch,
      phase: s.phase,
          phaseBaseStartFrac: s.phaseBaseStart !== undefined ? s.phaseBaseStart / dur : undefined,
          phaseBaseEndFrac: s.phaseBaseEnd !== undefined ? s.phaseBaseEnd / dur : undefined,
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

  /**
   * Re-apply a stretch ratio saved from a previous session.
   *
   * Distinct from stretchSlotToTempoAnchor: the ratio is already known, so no BPM detection
   * runs and no settings are re-persisted — this only rebuilds the audio the saved state
   * already describes. Also used with stretch = 1 to return a slot to its source tempo.
   */
  /**
   * Apply a known stretch ratio to a slot.
   *
   * `baseStretch` is what the engine currently holds for this slot (1 on the decode path,
   * the live ratio when re-stretching). It is passed in rather than read from entriesRef
   * because this runs immediately after setEntries on the load path, before React has
   * re-rendered — the ref still holds the previous array and the slot would not be found.
   */
  async function reapplyStretch(
    slotId: string,
    source: AudioBuffer,
    stretch: number,
    baseStretch: number,
  ) {
    setEntries((prev) => prev.map((e) => (e.slot.id === slotId ? { ...e, stretching: true } : e)));
    // Yield so the spinner paints before the synchronous stretch blocks the thread.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const stretched = stretchBuffer(source, stretch);
      multiEngine.swapBuffer(slotId, stretched, stretch / baseStretch);
      const loopStart = multiEngine.getLoopStart(slotId);
      const loopEnd = multiEngine.getLoopEnd(slotId);

      // Derive from the updater's own `prev`, which is always current, and persist from
      // there too — reading entriesRef here had the same staleness problem.
      let persisted: SlotEntry | null = null;
      // The phase base is in the pre-swap timebase; swapBuffer rescaled the live loop but
      // not this, so rescale it by the same ratio or the next phase click jumps the loop.
      const tbRatio = stretch / baseStretch;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.slot.id !== slotId) return e;
          const next = {
            ...e,
            buffer: stretched,
            stretch,
            stretching: false,
            slot: {
              ...e.slot,
              loopStart,
              loopEnd,
              phaseBaseStart:
                e.slot.phaseBaseStart !== undefined ? e.slot.phaseBaseStart * tbRatio : undefined,
              phaseBaseEnd:
                e.slot.phaseBaseEnd !== undefined ? e.slot.phaseBaseEnd * tbRatio : undefined,
            },
          };
          persisted = next;
          return next;
        }),
      );
      // Without this a reset back to source tempo would be undone on reload, because the
      // stale saved ratio would simply be re-applied.
      if (persisted) {
        const p: SlotEntry = persisted;
        persistMatchedState(p, p.isMatched ?? false, p.matchedBasePitch ?? 0);
      }
    } catch {
      setEntries((prev) => prev.map((e) => (e.slot.id === slotId ? { ...e, stretching: false } : e)));
    }
  }

  /** Manual stretch from the slot's Stretch knob. Always works from the untouched source,
   *  so repeated adjustments cannot compound rounding error. */
  async function handleStretchChange(slotId: string, ratio: number) {
    const entry = entriesRef.current.find((e) => e.slot.id === slotId);
    if (!entry?.sourceBuffer) return;
    if (Math.abs(ratio - entry.stretch) < 0.005) return;
    // reapplyStretch persists from inside its own state updater, which is the only place
    // that sees the post-stretch buffer and loop bounds together. Writing again here read
    // entriesRef before React had re-rendered, so it saved pre-stretch loop fractions
    // alongside the new ratio — two halves of different timebases.
    await reapplyStretch(slotId, entry.sourceBuffer, ratio, entry.stretch);
  }

  /**
   * Stretch ratio that would bring `targetBpm` onto `anchorBpm`.
   *
   * Extracted so stale detection and the stretch itself use identical math — if they
   * diverged, a slot could be flagged stale immediately after being matched, or stay
   * silent when it genuinely drifted.
   */
  function tempoStretchRatio(targetBpm: number, anchorBpm: number): number {
    let stretch = targetBpm / anchorBpm;
    // Fold octave errors: a half-time detection would otherwise demand a 2x stretch,
    // which sounds far worse than the musically equivalent 1x.
    while (stretch > 1.45) stretch /= 2;
    while (stretch < 0.7) stretch *= 2;
    return stretch;
  }

  /**
   * Stretch one slot so its tempo matches the tempo anchor's.
   *
   * Only touches the audio buffer and loop bounds — never speed/pitch/linkPitch — so a
   * slot can be tempo-matched and key-matched at the same time. That separation is the
   * whole point of stretching rather than resampling.
   */
  async function stretchSlotToTempoAnchor(targetSlotId: string) {
    const anchorId = tempoAnchorIdRef.current;
    if (!anchorId || anchorId === targetSlotId) return;

    const anchorEntry = entriesRef.current.find((e) => e.slot.id === anchorId);
    const target = entriesRef.current.find((e) => e.slot.id === targetSlotId);
    if (!anchorEntry || !target || !target.sourceBuffer) return;

    const anchorSrc = anchorEntry.sourceBuffer ?? anchorEntry.buffer;
    const anchorBpm = anchorEntry.detectedBpm ?? (anchorSrc ? estimateBpm(anchorSrc) : undefined);
    const targetBpm = target.detectedBpm ?? estimateBpm(target.sourceBuffer);
    if (!anchorBpm || !targetBpm) return;

    // Slower target tempo => must play faster => shorter buffer, hence the inversion.
    const stretch = tempoStretchRatio(targetBpm, anchorBpm);

    if (Math.abs(stretch - target.stretch) < 0.005) return;

    setEntries((prev) => prev.map((e) => (e.slot.id === targetSlotId ? { ...e, stretching: true } : e)));

    // Yield first: stretchBuffer is synchronous and long, so without this the spinner
    // never paints and the UI just appears frozen.
    await new Promise((r) => setTimeout(r, 0));

    try {
      const stretched = stretchBuffer(target.sourceBuffer, stretch);
      // Ratio is relative to what the engine currently holds, not to the source.
      multiEngine.swapBuffer(targetSlotId, stretched, stretch / target.stretch);
      const stretchedSlot = {
        ...target.slot,
        loopStart: multiEngine.getLoopStart(targetSlotId),
        loopEnd: multiEngine.getLoopEnd(targetSlotId),
      };
      setEntries((prev) =>
        prev.map((e) =>
          e.slot.id === targetSlotId
            ? { ...e, buffer: stretched, stretch, stretching: false, slot: stretchedSlot }
            : e,
        ),
      );
      // Persist so the stretch can be re-applied on reload — the buffer itself is memory-only.
      persistMatchedState(
        { ...target, buffer: stretched, stretch, slot: stretchedSlot },
        target.isMatched ?? false,
        target.matchedBasePitch ?? 0,
      );
    } catch {
      setEntries((prev) => prev.map((e) => (e.slot.id === targetSlotId ? { ...e, stretching: false } : e)));
    }
  }

  // Persisted like the key anchor. Stretched buffers are memory-only, so the saved stretch
  // ratio on each slot is re-applied after decode — otherwise the restored anchor would
  // claim slots are synced to a tempo they had silently reverted from.
  function handleSetTempoAnchor(slotId: string) {
    const next = tempoAnchorIdRef.current === slotId ? null : slotId;
    setTempoAnchorId(next);
    tempoAnchorIdRef.current = next;
    const entry = next ? entriesRef.current.find((e) => e.slot.id === next) : null;
    if (entry) saveTempoAnchorKey(entry.slot.trackId, entry.slot.stemName);
    else clearTempoAnchorKey();
    // The anchor defines the tempo, so it plays at its own. A slot that was previously
    // matched to some other anchor would otherwise stay stretched and every other slot
    // would be matched to a tempo that is not actually this slot's.
    if (entry && entry.sourceBuffer && Math.abs(entry.stretch - 1) > 0.005) {
      void reapplyStretch(entry.slot.id, entry.sourceBuffer, 1, entry.stretch);
    }
  }

  async function handleTempoMatchAll() {
    const anchorId = tempoAnchorIdRef.current;
    if (!anchorId) return;
    for (const entry of entriesRef.current) {
      if (entry.slot.id !== anchorId && !entry.loading) {
        await stretchSlotToTempoAnchor(entry.slot.id);
      }
    }
    // Matching rate alone still drifts: a 3.8-bar loop and a 4-bar loop pull apart every
    // pass however well their tempos agree. Quantizing every slot — the anchor included —
    // to the anchor's bar grid is what makes a shared downbeat hold.
    quantizeAllToAnchorGrid();
  }

  /**
   * Round every loop to a whole number of the anchor's bars.
   *
   * Reads entriesRef rather than the stretched entries returned above because the stretch
   * pass has already rewritten loop bounds; this must see those, not the pre-stretch values.
   */
  /**
   * Quantize loops onto the tempo anchor's bar grid.
   *
   * `only` restricts it to a single slot, which is what the per-slot Match Tempo button
   * needs — matching one slot's rate without also putting its loop on the grid leaves it
   * drifting against everything else, so both paths run the same quantize.
   */
  function quantizeAllToAnchorGrid(only?: string) {
    const anchorId = tempoAnchorIdRef.current;
    if (!anchorId) return;
    const anchor = entriesRef.current.find((e) => e.slot.id === anchorId);
    // sourceBuffer is the untouched decode and never changes, so it is safe to read here
    // even though the rest of the entry may be a render behind.
    const anchorSrc = anchor?.sourceBuffer ?? anchor?.buffer;
    const anchorBpm = anchor?.detectedBpm ?? (anchorSrc ? sourceBpm(anchorSrc) : undefined);
    if (!anchorBpm) return;

    const skipped: string[] = [];
    for (const entry of entriesRef.current) {
      if (only !== undefined && entry.slot.id !== only) continue;
      if (entry.loading || !entry.buffer) continue;
      // Loop bounds from the engine, not from entry.slot: this runs immediately after the
      // stretch pass, and React has not re-rendered yet, so entriesRef still holds the
      // pre-stretch bounds. Quantizing those onto an already-stretched buffer put the loop
      // ends in the wrong place. The engine's copy is rescaled by swapBuffer, so it is live.
      const liveSlot = multiEngine.getSlot(entry.slot.id);
      const loopStart = liveSlot?.loopStart ?? entry.slot.loopStart;
      const loopEnd = liveSlot?.loopEnd ?? entry.slot.loopEnd;
      // The engine also holds the stretched buffer; entry.buffer may still be the old one.
      const liveBuffer = multiEngine.getBuffer(entry.slot.id) ?? entry.buffer;
      // Every slot is already at the anchor's tempo, so the anchor's BPM is the right grid
      // for all of them — including slots whose own detected tempo differs.
      const q = quantizeToGrid(liveBuffer, loopStart, loopEnd, anchorBpm);
      if (!q) { skipped.push(entry.title); continue; }
      // Quantizing rewrites the loop to whole bars, which discards any phase offset. The
      // quantized loop becomes the new un-phased base, and the slot's phase is re-applied
      // on top — otherwise the UI would keep showing "½" while the loop sat on the downbeat.
      const phase = entry.slot.phase ?? 0;
      const qDur = q.loopEnd - q.loopStart;
      let finalStart = q.loopStart;
      if (phase > 0 && qDur > 0) {
        const barSec = (60 / anchorBpm) * 4;
        const off = (((phase * barSec) % qDur) + qDur) % qDur;
        const cand = q.loopStart + off;
        finalStart = cand + qDur > liveBuffer.duration ? cand - qDur : cand;
        if (finalStart < 0) finalStart = q.loopStart;
      }
      const finalEnd = finalStart + qDur;
      multiEngine.updateSlot(entry.slot.id, { loopStart: finalStart, loopEnd: finalEnd });
      // Persist from the updater's own `prev`, not from the captured `entry`: the latter is
      // pre-stretch, and persistMatchedState divides by buffer.duration to store loop
      // fractions — using the old duration would save bounds that are wrong on reload.
      let updated: SlotEntry | null = null;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.slot.id !== entry.slot.id) return e;
          const next = {
            ...e,
            slot: {
              ...e.slot,
              loopStart: finalStart,
              loopEnd: finalEnd,
              // The quantized (unshifted) loop is the base every future phase derives from.
              phaseBaseStart: q.loopStart,
              phaseBaseEnd: q.loopEnd,
            },
          };
          updated = next;
          return next;
        }),
      );
      if (updated) {
        const u: SlotEntry = updated;
        persistMatchedState(u, u.isMatched ?? false, u.matchedBasePitch ?? 0);
      }
    }
    setGridNote(
      skipped.length
        ? `Loops quantized to ${Math.round(anchorBpm)} bpm bars. Too short to fit a bar: ${skipped.join(", ")}.`
        : only !== undefined
          ? `Loop quantized to whole bars at ${Math.round(anchorBpm)} bpm.`
          : `All loops quantized to whole bars at ${Math.round(anchorBpm)} bpm.`,
    );
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

  function handleRandomSession() {
    const slots = buildRandomSlots(stemsLibrary, viabilityMapRef.current);
    if (!slots) return;
    // A random rack is not the previously loaded session, so drop the label.
    setActiveSessionName(null);
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

  /**
   * Slot list for a session write.
   *
   * Both save paths (named save and the resave button) go through this — when they each
   * built the list inline, adding a field to one silently stripped it from the other.
   */
  function buildSessionSlots(): MultiSlot[] {
    return entriesRef.current.map((e) => ({
      ...e.slot,
      isReference: e.slot.id === referenceSlotIdRef.current,
      isTempoAnchor: e.slot.id === tempoAnchorIdRef.current,
      stretch: e.stretch,
      isMatched: e.isMatched,
      matchedBasePitch: e.matchedBasePitch,
      pitchInterval: e.pitchInterval,
      detectedKey: e.detectedKey,
      detectedBpm: e.detectedBpm,
    }));
  }

  function handleSaveSession() {
    const name = sessionName.trim();
    if (!name || entries.length === 0) return;
    setNamedSessions(saveNamedSession(name, buildSessionSlots(), masterSettings));
    setSessionName("");
    setActiveSessionName(name);
    setSavedFlash(name);
    setTimeout(() => setSavedFlash((n) => (n === name ? null : n)), 2000);
    saveExportToServer(buildExport(masterSettingsRef.current));
  }

  function handleLoadSession(session: MultiSession) {
    setActiveSessionName(session.name);
    const ms = { ...session.masterSettings, masterSpeed: session.masterSettings.masterSpeed ?? 1 };
    setMasterSettings(ms);
    multiEngine.setMasterSettings(ms);
    multiEngine.setThrowSettings(ms.throwSettings);
    saveMasterSpeed(ms.masterSpeed);

    const slotsWithIds = session.slots.map((s) => ({
      ...s,
      id: crypto.randomUUID(), // always fresh so URL changes and reconciler re-runs
    }));

    pendingSessionSlotsRef.current = new Map(
      slotsWithIds.map((s) => [pendingKey(s.trackId, s.stemName), s]),
    );

    const refSlot = slotsWithIds.find((s) => s.isReference);
    pendingReferenceIdRef.current = refSlot ? refSlot.id : null;
    const tempoSlot = slotsWithIds.find((s) => s.isTempoAnchor);
    pendingTempoAnchorIdRef.current = tempoSlot ? tempoSlot.id : null;
    // Only clear when this session actually records anchor state. Sessions saved before
    // isTempoAnchor existed have the field on no slot, which is indistinguishable from
    // "deliberately no anchor" — clearing on those wiped the live anchor (and its
    // localStorage key) every time an older session was loaded.
    const sessionKnowsTempoAnchor = slotsWithIds.some((s) => s.isTempoAnchor !== undefined);
    if (!tempoSlot && sessionKnowsTempoAnchor) {
      setTempoAnchorId(null);
      tempoAnchorIdRef.current = null;
      clearTempoAnchorKey();
    }

    const param = slotsWithIds
      .map((s) => s.stemName ? `${s.id}:${s.trackId}:${s.stemName}` : `${s.id}:${s.trackId}`)
      .join(",");
    multiEngine.stop();
    navigate(param ? `/?slots=${param}` : "/");
  }

  function commitRename(oldName: string) {
    const next = renameDraft.trim();
    setRenamingSession(null);
    if (!next || next === oldName) return;
    setNamedSessions(renameNamedSession(oldName, next));
    // Keep the active-session label in sync if we just renamed the loaded one.
    setActiveSessionName((cur) => (cur === oldName ? next : cur));
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
          // A preset changes tone, not tempo — preserve the stretch through the overwrite.
          stretch: e.stretch,
          phase: s.phase,
          phaseBaseStartFrac: s.phaseBaseStart !== undefined ? s.phaseBaseStart / dur : undefined,
          phaseBaseEndFrac: s.phaseBaseEnd !== undefined ? s.phaseBaseEnd / dur : undefined,
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

  function handleMasterSpeedChange(masterSpeed: number) {
    const next = { ...masterSettingsRef.current, masterSpeed };
    setMasterSettings(next);
    multiEngine.setMasterSettings(next);
    saveMasterSpeed(masterSpeed);
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
      // Backups written before master speed existed have no masterSpeed; without this
      // default every rate becomes NaN and all slots go silent.
      const importedMaster = {
        ...data.masterSettings,
        masterSpeed: data.masterSettings.masterSpeed ?? 1,
      };
      setMasterSettings(importedMaster);
      multiEngine.setMasterSettings(importedMaster);
      multiEngine.setThrowSettings(importedMaster.throwSettings);
      saveMasterSpeed(importedMaster.masterSpeed);
      setImportStatus("imported");
      setTimeout(() => setImportStatus("idle"), 2000);
    } catch {
      setImportStatus("error");
      setTimeout(() => setImportStatus("idle"), 2000);
    }
  }

  async function handlePlayAll(instant = false) {
    // With a tempo anchor set the loops share a grid, so starting them all from loop start
    // lands them on one downbeat. Without an anchor there is no shared grid to align to and
    // slots keep resuming from wherever they were parked.
    await multiEngine.play(instant, tempoAnchorIdRef.current !== null);
  }

  function handleStopAll(fade = false) {
    multiEngine.stop(fade);
  }

  function handleClear() {
    // Clearing the rack leaves no loaded session; keeping the label would name a session
    // whose slots are gone.
    setActiveSessionName(null);
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
          {/* Name the loaded session rather than just counting saved ones — with a dozen
              similarly-named sessions, knowing which is live matters more than the total. */}
          {activeSessionName ? (
            <span className="flex items-center gap-1.5">
              <span className="text-foreground/40">Session</span>
              <span className="text-accent normal-case tracking-normal">{activeSessionName}</span>
            </span>
          ) : (
            `Sessions${namedSessions.length > 0 ? ` (${namedSessions.length})` : ""}`
          )}
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
                {renamingSession === s.name ? (
                  <form
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); commitRename(s.name); }}
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(s.name)}
                      onKeyDown={(e) => { if (e.key === "Escape") setRenamingSession(null); }}
                      className="w-full rounded border border-accent/50 bg-background px-1.5 py-0.5 text-sm outline-none"
                    />
                  </form>
                ) : (
                <button
                  type="button"
                  onClick={() => { handleLoadSession(s); setSessionsPanelOpen(false); }}
                  className="truncate text-left text-sm font-medium text-foreground/70 transition hover:text-foreground"
                >
                  {s.name}
                </button>
                )}
                {renamingSession !== s.name && (
                <button
                  type="button"
                  onClick={() => { setRenamingSession(s.name); setRenameDraft(s.name); }}
                  className="text-xs leading-none text-foreground/30 opacity-0 group-hover:opacity-100 transition hover:text-accent pl-3"
                  aria-label="Rename session" title="Rename"
                >✎</button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (entriesRef.current.length > 0) {
                      setNamedSessions(saveNamedSession(s.name, buildSessionSlots(), masterSettings));
                      // Resaving makes this the session the rack belongs to; without this the
                      // header button kept naming whichever session was loaded before.
                      setActiveSessionName(s.name);
                      setSavedFlash(s.name);
                      setTimeout(() => setSavedFlash((n) => (n === s.name ? null : n)), 2000);
                    }
                  }}
                  className={`text-base leading-none transition pl-3 ${
                    savedFlash === s.name
                      ? "text-accent opacity-100"
                      : "text-foreground/30 opacity-0 group-hover:opacity-100 hover:text-accent"
                  }`}
                  aria-label="Resave session" title="Resave with current slots"
                >{savedFlash === s.name ? "✓" : "💾"}</button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => handleDeleteSession(s.name)}
                  className="text-base leading-none text-foreground/30 opacity-0 group-hover:opacity-100 transition hover:text-red-400"
                  aria-label="Delete session" title="Delete session"
                >🗑</button>
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
              {/* Saving clears the input, so keep the button mounted through the flash to show ✓. */}
              {(sessionName.trim() || savedFlash !== null) && (
                <button
                  type="submit"
                  disabled={savedFlash !== null}
                  className={`rounded border px-2 py-1.5 text-xs transition ${
                    savedFlash !== null
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-border bg-muted/50 text-foreground/50 hover:text-foreground"
                  }`}
                >
                  {savedFlash !== null ? "Saved ✓" : "Save"}
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
          onMasterSpeedChange={handleMasterSpeedChange}
          slotCount={entries.length}
          referenceSlotId={referenceSlotId}
          activeSessionName={activeSessionName}
          slotTitles={entries.map((e) => e.title)}
          getSlotsAndBuffers={getSlotsAndBuffers.current}
          onPlayAll={handlePlayAll}
          onStopAll={handleStopAll}
          // One engine call, not a loop of seeks: the engine rewinds every slot on a single
          // timestamp, which is what keeps the downbeats aligned. It also reads each slot's
          // own loopStart, already clamped against buffer duration by addSlot.
          onRewindAll={() => multiEngine.rewindAll()}
          onThrowSettingsChange={handleThrowSettingsChange}
          throwPresets={throwPresets}
          onSaveThrowPreset={handleSaveThrowPreset}
          onDeleteThrowPreset={handleDeleteThrowPreset}
          onApplyThrowPreset={handleApplyThrowPreset}
          isPlaying={isPlayingAll}
          onMatchAll={handleMatchAll}
          onTempoMatchAll={() => { void handleTempoMatchAll(); }}
          gridNote={gridNote}
          onDismissGridNote={() => setGridNote(null)}
          tempoAnchorId={tempoAnchorId}
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
          const isTempoAnchor = entry.slot.id === tempoAnchorId;
          // The anchor itself snaps to its own tempo, so it gets no override.
          const slotAnchorBpm = isTempoAnchor ? undefined : anchorBpm;
          return (
            <SlotStrip
              key={entry.slot.id}
              slot={entry.slot}
              title={entry.title}
              buffer={entry.buffer}
              presets={presets}
              isReference={isReference}
              hasReference={hasReference}
              anchorBpm={slotAnchorBpm}
              tempoStale={staleTempoIds.has(entry.slot.id)}
              isTempoAnchor={isTempoAnchor}
              hasTempoAnchor={tempoAnchorId !== null}
              onSetTempoAnchor={() => handleSetTempoAnchor(entry.slot.id)}
              onTempoMatch={() => {
                // Stretch then quantize, same as the transport's Match Tempos — rate alone
                // still drifts if the loop is not a whole number of the anchor's bars.
                void stretchSlotToTempoAnchor(entry.slot.id).then(() =>
                  quantizeAllToAnchorGrid(entry.slot.id),
                );
              }}
              onStretchChange={(ratio) => { void handleStretchChange(entry.slot.id, ratio); }}
              stretch={entry.stretch}
              stretching={entry.stretching}
              isMatched={!isReference && entry.isMatched}
              matchedBasePitch={entry.matchedBasePitch}
              pitchInterval={entry.pitchInterval}

              onPitchIntervalChange={(n) => setEntries((prev) => prev.map((e) => e.slot.id === entry.slot.id ? { ...e, pitchInterval: n } : e))}
              onRemove={() => handleRemoveSlot(entry.slot.id)}
              onChange={(patch) => handleSlotChange(entry.slot.id, patch)}
              onSetReference={() => handleSetReference(entry.slot.id)}
              onMatch={() => matchSlotToReference(entry.slot.id)}
              masterSpeed={masterSettings.masterSpeed}
              detectedBpm={entry.detectedBpm}
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
