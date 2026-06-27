import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as Tone from "tone";
import { dubEngine, STEM_NAMES, DRY_EFFECTS, type StemName } from "../audio/dubEngine";
import { type EffectsState, EFFECTS_LIMITS } from "../store";
import { History } from "../components/History";
import { Button } from "../components/ui/Button";
import { DubWaveform } from "../components/DubWaveform";
import { cn } from "../lib/cn";
import { loadDubSettings, saveDubSettings, type PerStemSettings } from "../lib/dubSettings";
import { putTrackMeta } from "../lib/trackMetaCache";
import { formatLoopTime, formatTime, parseLoopTime, LOOP_TIME_FORMAT_HINT } from "../lib/format";
import {
  loadDubStemPresets,
  saveDubStemPreset,
  deleteDubStemPreset,
  type DubStemPreset,
} from "../lib/dubStemPresets";

type Phase = "idle" | "loading" | "separating" | "ready" | "error";

const STEM_LABELS: Record<StemName, string> = {
  drums: "Drums",
  bass: "Bass",
  vocals: "Vocals",
  other: "Other",
};

type StemUI = {
  muted: boolean;
  soloed: boolean;
  gainDb: number;
  effects: EffectsState;
  selectedPreset: string | null;
};

function makeInitialStemUI(): Record<StemName, StemUI> {
  return Object.fromEntries(
    STEM_NAMES.map((s) => [s, { muted: false, soloed: false, gainDb: 0, effects: { ...DRY_EFFECTS }, selectedPreset: null }])
  ) as Record<StemName, StemUI>;
}

const VIDEO_ID = /^[a-zA-Z0-9_-]{11,16}$/;

export function StemsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const urlId = searchParams.get("v") ?? "";

  const [urlInput, setUrlInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [loadedId, setLoadedId] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [trackTitle, setTrackTitle] = useState("");
  const [stemUI, setStemUI] = useState<Record<StemName, StemUI>>(makeInitialStemUI);
  const [speed, setSpeed] = useState(1);
  const [seekOffset, setSeekOffset] = useState(0);
  const [audioBuffers, setAudioBuffers] = useState<Record<StemName, AudioBuffer> | null>(null);
  const [presets, setPresets] = useState<DubStemPreset[]>(() => loadDubStemPresets());
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);

  // URL reconciler — fires when ?v= changes
  useEffect(() => {
    const id = VIDEO_ID.test(urlId) ? urlId : "";
    if (!id || id === loadedId) return;

    let cancelled = false;
    setError("");
    setPhase("loading");
    dubEngine.dispose();
    setPlaying(false);
    setSeekOffset(0);
    setAudioBuffers(null);
    setStemUI(makeInitialStemUI());
    setSpeed(1);
    setLoopEnabled(false);
    setLoopStart(0);
    setLoopEnd(0);

    (async () => {
      try {
        // Check if stems are cached — determines whether to show long-wait UI
        const statusRes = await fetch(`/api/stems/${id}/status`);
        if (cancelled) return;
        const { ready } = statusRes.ok ? (await statusRes.json() as { ready: boolean }) : { ready: false };
        if (!ready) setPhase("separating");

        const res = await fetch("/api/stems", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
        });
        const data = await res.json() as { title: string; error?: string };
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? "Server error");

        setTrackTitle(data.title);
        setPhase("loading");

        const buffers = await decodeStemBuffers(id);
        if (cancelled) return;
        await dubEngine.load(buffers);
        putTrackMeta({ id, title: data.title, duration: buffers[STEM_NAMES[0]].duration, addedAt: Date.now() });

        // Restore persisted settings
        const saved = loadDubSettings(id);
        const restoredUI = makeInitialStemUI();
        if (saved) {
          setSpeed(saved.speed);
          dubEngine.setSpeed(saved.speed);
          for (const stem of STEM_NAMES) {
            const s = saved.stems[stem];
            if (s) {
              restoredUI[stem] = { effects: s.effects, muted: s.muted, soloed: s.soloed, gainDb: s.gainDb, selectedPreset: s.selectedPreset ?? null };
              dubEngine.setEffects(stem, s.effects);
              dubEngine.setMute(stem, s.muted);
              dubEngine.setSolo(stem, s.soloed);
              dubEngine.setGain(stem, s.gainDb);
            }
          }
        }
        const duration = buffers[STEM_NAMES[0]].duration;
        const savedLoopEnd = saved?.loopEnd && saved.loopEnd > 0 ? saved.loopEnd : duration;
        const restoredLoopStart = Math.max(0, Math.min(duration, saved?.loopStart ?? 0));
        const restoredLoopEnd = Math.max(restoredLoopStart + 0.1, Math.min(duration, savedLoopEnd));
        const restoredLoopEnabled = saved?.loopEnabled ?? false;
        setLoopStart(restoredLoopStart);
        setLoopEnd(restoredLoopEnd);
        setLoopEnabled(restoredLoopEnabled);
        dubEngine.setLoop(restoredLoopStart, restoredLoopEnd, restoredLoopEnabled);

        setStemUI(restoredUI);
        setAudioBuffers(buffers);
        setLoadedId(id);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error");
        setPhase("error");
      }
    })();

    return () => { cancelled = true; };
  }, [urlId]); // eslint-disable-line react-hooks/exhaustive-deps

  function persist(ui: Record<StemName, StemUI>, spd: number, le = loopEnabled, ls = loopStart, lEnd = loopEnd) {
    if (!loadedId) return;
    saveDubSettings(loadedId, {
      speed: spd,
      loopEnabled: le,
      loopStart: ls,
      loopEnd: lEnd,
      stems: Object.fromEntries(
        STEM_NAMES.map((s) => [s, { effects: ui[s].effects, muted: ui[s].muted, soloed: ui[s].soloed, gainDb: ui[s].gainDb, dubActive: false, selectedPreset: ui[s].selectedPreset }])
      ) as Record<StemName, PerStemSettings>,
    });
  }

  function handleSeparate(e: React.FormEvent) {
    e.preventDefault();
    const raw = urlInput.trim();
    if (!raw) return;
    const idMatch = raw.match(/[?&]v=([a-zA-Z0-9_-]{11,16})/) ?? raw.match(/youtu\.be\/([a-zA-Z0-9_-]{11,16})/);
    const id = idMatch ? idMatch[1] : (VIDEO_ID.test(raw) ? raw : null);
    navigate(id ? `/stems?v=${id}` : `/stems?v=${encodeURIComponent(raw)}`);
  }

  async function handlePlayStop() {
    if (playing) {
      const pos = loopEnabled
        ? loopStart + Tone.getTransport().seconds
        : seekOffset + Tone.getTransport().seconds;
      dubEngine.stop();
      setPlaying(false);
      setSeekOffset(pos);
    } else {
      await dubEngine.play(seekOffset);
      setPlaying(true);
    }
  }

  function handleSeek(seconds: number) {
    const clamped = loopEnabled
      ? Math.max(loopStart, Math.min(loopEnd - 0.01, seconds))
      : seconds;
    if (playing) {
      dubEngine.play(clamped);
    }
    setSeekOffset(clamped);
  }

  function applyLoop(start: number, end: number, enabled: boolean) {
    setLoopStart(start);
    setLoopEnd(end);
    setLoopEnabled(enabled);
    dubEngine.setLoop(start, end, enabled);
    persist(stemUI, speed, enabled, start, end);
  }

  function handleLoopToggle() {
    const next = !loopEnabled;
    applyLoop(loopStart, loopEnd, next);
    if (playing) {
      // Restart with new loop setting from current position
      const pos = loopEnabled
        ? loopStart + Tone.getTransport().seconds
        : seekOffset + Tone.getTransport().seconds;
      dubEngine.play(pos);
    }
  }

  function handleLoopBound(bound: "start" | "end", seconds: number) {
    if (!audioBuffers) return;
    const dur = audioBuffers[STEM_NAMES[0]].duration;
    const newStart = bound === "start" ? Math.max(0, Math.min(loopEnd - 0.1, seconds)) : loopStart;
    const newEnd = bound === "end" ? Math.max(loopStart + 0.1, Math.min(dur, seconds)) : loopEnd;
    applyLoop(newStart, newEnd, loopEnabled);
  }

  function handleEnd() {
    dubEngine.stop();
    setPlaying(false);
    setSeekOffset(0);
  }

  function handleMute(stem: StemName) {
    setStemUI((prev) => {
      const next = { ...prev, [stem]: { ...prev[stem], muted: !prev[stem].muted } };
      dubEngine.setMute(stem, next[stem].muted);
      persist(next, speed);
      return next;
    });
  }

  function handleSolo(stem: StemName) {
    setStemUI((prev) => {
      const next = { ...prev, [stem]: { ...prev[stem], soloed: !prev[stem].soloed } };
      dubEngine.setSolo(stem, next[stem].soloed);
      persist(next, speed);
      return next;
    });
  }

  function handleGain(stem: StemName, db: number) {
    setStemUI((prev) => {
      const next = { ...prev, [stem]: { ...prev[stem], gainDb: db } };
      dubEngine.setGain(stem, db);
      persist(next, speed);
      return next;
    });
  }

  function handleSpeed(v: number) {
    setSpeed(v);
    dubEngine.setSpeed(v);
    persist(stemUI, v);
  }

  function handleReset(stem: StemName) {
    setStemUI((prev) => {
      dubEngine.setEffects(stem, { ...DRY_EFFECTS });
      const next = { ...prev, [stem]: { ...prev[stem], effects: { ...DRY_EFFECTS }, selectedPreset: null } };
      persist(next, speed);
      return next;
    });
  }

  function handleEffect<K extends keyof EffectsState>(stem: StemName, k: K, value: EffectsState[K]) {
    setStemUI((prev) => {
      const nextEffects = { ...prev[stem].effects, [k]: value };
      dubEngine.setEffects(stem, nextEffects);
      const next = { ...prev, [stem]: { ...prev[stem], effects: nextEffects, selectedPreset: null } };
      persist(next, speed);
      return next;
    });
  }

  function handleApplyEffects(stem: StemName, effects: EffectsState, presetName: string | null = null) {
    setStemUI((prev) => {
      dubEngine.setEffects(stem, effects);
      const next = { ...prev, [stem]: { ...prev[stem], effects: { ...effects }, selectedPreset: presetName } };
      persist(next, speed);
      return next;
    });
  }

  function handleSavePreset(stem: StemName, name: string, effects: EffectsState) {
    setPresets(saveDubStemPreset(name, effects));
    // Auto-select the saved preset on the stem it was saved from
    setStemUI((prev) => {
      const next = { ...prev, [stem]: { ...prev[stem], selectedPreset: name } };
      persist(next, speed);
      return next;
    });
  }

  function handleDeletePreset(name: string) {
    setPresets(deleteDubStemPreset(name));
    // Clear selected preset on any stem that was using this preset
    setStemUI((prev) => {
      const next = { ...prev };
      for (const stem of STEM_NAMES) {
        if (next[stem].selectedPreset === name) {
          next[stem] = { ...next[stem], selectedPreset: null };
        }
      }
      persist(next, speed);
      return next;
    });
  }

  const isLoading = phase === "loading" || phase === "separating";
  const anySoloed = STEM_NAMES.some((s) => stemUI[s].soloed);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* URL input */}
      <div className="shrink-0">
        <form onSubmit={handleSeparate} className="flex gap-2">
          <input
            type="text"
            placeholder="Paste a YouTube URL"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            disabled={isLoading}
            className="min-w-0 flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <Button type="submit" disabled={isLoading || !urlInput.trim()} className="shrink-0">
            {isLoading ? "Working…" : "Separate"}
          </Button>
        </form>
      </div>

      {phase === "error" && error && (
        <div className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Mobile recents */}
      <div className="max-h-36 shrink-0 overflow-hidden lg:hidden">
        <History mode="stems" scrollable />
      </div>

      <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto lg:overflow-hidden">
        {/* Sidebar recents */}
        <aside className="hidden min-h-0 w-48 shrink-0 flex-col lg:flex">
          <History mode="stems" scrollable className="min-h-0 flex-1" />
        </aside>

        {/* Main content */}
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {phase === "separating" && (
            <div className="flex flex-1 items-center justify-center rounded-md border border-border bg-muted/30 px-4 py-12 text-center text-sm text-foreground/60">
              <div>
                <div className="mb-1 font-medium text-foreground">Separating stems…</div>
                <div>This takes 2–5 minutes on first run.</div>
                <div className="mt-1 text-xs">Splitting into drums, bass, vocals, and other.</div>
              </div>
            </div>
          )}

          {phase === "loading" && (
            <div className="flex flex-1 items-center justify-center rounded-md border border-border bg-muted/30 py-12 text-sm text-foreground/60">
              Loading stems…
            </div>
          )}

          {phase === "ready" && audioBuffers && (
            <div className="flex flex-col gap-4">
              {/* Transport row */}
              <div className="flex items-center gap-3">
                <Button onClick={handlePlayStop} className="w-20 shrink-0">
                  {playing ? "Stop" : "Play"}
                </Button>
                <PlaybackClock
                  playing={playing}
                  seekOffset={seekOffset}
                  loopEnabled={loopEnabled}
                  loopStart={loopStart}
                />
                {trackTitle && (
                  <div className="min-w-0 truncate text-sm text-foreground/70">{trackTitle}</div>
                )}
              </div>

              {/* Waveform */}
              <DubWaveform
                buffers={audioBuffers}
                playing={playing}
                seekOffset={seekOffset}
                loopEnabled={loopEnabled}
                loopStart={loopStart}
                loopEnd={loopEnd}
                onSeek={handleSeek}
                onEnd={handleEnd}
              />

              {/* Loop controls */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleLoopToggle}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium uppercase tracking-wide transition",
                    loopEnabled
                      ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                      : "bg-muted text-foreground/50 hover:text-foreground/80",
                  )}
                >
                  Loop
                </button>
                {loopEnabled && (
                  <>
                    <LoopTimeField
                      label="Start"
                      seconds={loopStart}
                      max={loopEnd - 0.1}
                      onCommit={(s) => handleLoopBound("start", s)}
                    />
                    <LoopTimeField
                      label="End"
                      seconds={loopEnd}
                      max={audioBuffers ? audioBuffers[STEM_NAMES[0]].duration : loopEnd}
                      onCommit={(s) => handleLoopBound("end", s)}
                    />
                  </>
                )}
              </div>

              {/* Global speed */}
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                <EffectSlider
                  label="Speed / Pitch (all stems)"
                  displayValue={`${Math.round(speed * 100)}%`}
                  value={speed}
                  min={0.5}
                  max={1}
                  step={0.01}
                  onChange={handleSpeed}
                />
              </div>

              {/* Stem strips */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {STEM_NAMES.map((stem) => (
                  <StemStrip
                    key={stem}
                    label={STEM_LABELS[stem]}
                    ui={stemUI[stem]}
                    anySoloed={anySoloed}
                    presets={presets}
                    onMute={() => handleMute(stem)}
                    onSolo={() => handleSolo(stem)}
                    onGain={(db) => handleGain(stem, db)}
                    onReset={() => handleReset(stem)}
                    onEffect={(k, val) => handleEffect(stem, k, val)}
                    onApplyEffects={(effects, name) => handleApplyEffects(stem, effects, name)}
                    onSavePreset={(name, effects) => handleSavePreset(stem, name, effects)}
                    onDeletePreset={handleDeletePreset}
                  />
                ))}
              </div>
            </div>
          )}

          {(phase === "idle" || (!urlId && phase !== "error")) && (
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-foreground/50">
              Paste a YouTube URL and click <strong className="mx-1 text-foreground/70">Separate</strong> to isolate stems. Each stem gets its own reverb, delay, and bass controls. Click <strong className="mx-1 text-foreground/70">Dub</strong> on any stem for a preset dub techno effect.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaybackClock({
  playing,
  seekOffset,
  loopEnabled,
  loopStart,
}: {
  playing: boolean;
  seekOffset: number;
  loopEnabled: boolean;
  loopStart: number;
}) {
  const [display, setDisplay] = useState(() => formatTime(seekOffset));
  const rafRef = useRef(0);
  const playingRef = useRef(playing);
  const seekOffsetRef = useRef(seekOffset);
  const loopEnabledRef = useRef(loopEnabled);
  const loopStartRef = useRef(loopStart);
  playingRef.current = playing;
  seekOffsetRef.current = seekOffset;
  loopEnabledRef.current = loopEnabled;
  loopStartRef.current = loopStart;

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!playing) {
      setDisplay(formatTime(seekOffset));
      return;
    }
    function tick() {
      const t = loopEnabledRef.current
        ? loopStartRef.current + Tone.getTransport().seconds
        : seekOffsetRef.current + Tone.getTransport().seconds;
      setDisplay(formatTime(t));
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, seekOffset, loopEnabled, loopStart]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="shrink-0 tabular-nums text-sm text-foreground/60">{display}</span>
  );
}

function LoopTimeField({
  label,
  seconds,
  max,
  onCommit,
}: {
  label: string;
  seconds: number;
  max: number;
  onCommit: (s: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-foreground/60">
      <span className="uppercase tracking-wide">
        {label}{" "}
        <span className="normal-case text-foreground/40">({LOOP_TIME_FORMAT_HINT})</span>
      </span>
      <input
        key={Math.round(seconds * 100)}
        defaultValue={formatLoopTime(seconds)}
        placeholder="0:00.00"
        onBlur={(e) => {
          const parsed = parseLoopTime(e.target.value);
          if (parsed != null && parsed >= 0 && parsed <= max) onCommit(parsed);
          else e.target.value = formatLoopTime(seconds);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-24 rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground tabular-nums outline-none focus:border-accent"
      />
    </label>
  );
}

function StemStrip({
  label,
  ui,
  anySoloed,
  presets,
  onMute,
  onSolo,
  onGain,
  onReset,
  onEffect,
  onApplyEffects,
  onSavePreset,
  onDeletePreset,
}: {
  label: string;
  ui: StemUI;
  anySoloed: boolean;
  presets: DubStemPreset[];
  onMute: () => void;
  onSolo: () => void;
  onGain: (db: number) => void;
  onReset: () => void;
  onEffect: <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => void;
  onApplyEffects: (effects: EffectsState, name: string | null) => void;
  onSavePreset: (name: string, effects: EffectsState) => void;
  onDeletePreset: (name: string) => void;
}) {
  const { muted, soloed, gainDb, effects } = ui;
  const silenced = anySoloed && !soloed;

  return (
    <div className={cn(
      "flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 transition",
      (muted || silenced) && "opacity-40",
    )}>
      {/* Header */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground/80">{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onReset}
            title="Reset effects to dry"
            className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wide bg-muted text-foreground/40 transition hover:text-foreground/70"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onSolo}
            title="Solo — only this stem plays"
            className={cn(
              "rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition",
              soloed ? "bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/40" : "bg-muted text-foreground/40 hover:text-foreground/70",
            )}
          >
            Solo
          </button>
          <button
            type="button"
            onClick={onMute}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition",
              muted ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-muted text-foreground/40 hover:text-foreground/70",
            )}
          >
            {muted ? "Muted" : "Mute"}
          </button>
        </div>
      </div>

      {/* Gain */}
      <EffectSlider
        label="Volume"
        displayValue={`${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)}dB`}
        value={gainDb}
        min={-24}
        max={6}
        step={0.5}
        onChange={onGain}
      />

      {/* Effect sliders */}
      <div className="flex flex-col gap-2.5 border-t border-border/50 pt-2.5">
        <EffectSlider
          label="Reverb"
          displayValue={`${Math.round(effects.reverbWet * 100)}%`}
          value={effects.reverbWet}
          min={EFFECTS_LIMITS.reverbWet.min}
          max={EFFECTS_LIMITS.reverbWet.max}
          step={0.01}
          onChange={(v) => onEffect("reverbWet", v)}
        />
        <EffectSlider
          label="Reverb decay"
          displayValue={`${effects.reverbDecay.toFixed(1)}s`}
          value={effects.reverbDecay}
          min={EFFECTS_LIMITS.reverbDecay.min}
          max={EFFECTS_LIMITS.reverbDecay.max}
          step={0.1}
          onChange={(v) => onEffect("reverbDecay", v)}
        />
        <EffectSlider
          label="Delay"
          displayValue={`${Math.round(effects.delayWet * 100)}%`}
          value={effects.delayWet}
          min={EFFECTS_LIMITS.delayWet.min}
          max={EFFECTS_LIMITS.delayWet.max}
          step={0.01}
          onChange={(v) => onEffect("delayWet", v)}
        />
        <EffectSlider
          label="Delay time"
          displayValue={`${effects.delayTime.toFixed(2)}s`}
          value={effects.delayTime}
          min={EFFECTS_LIMITS.delayTime.min}
          max={EFFECTS_LIMITS.delayTime.max}
          step={0.01}
          onChange={(v) => onEffect("delayTime", v)}
        />
        <EffectSlider
          label="Delay feedback"
          displayValue={`${Math.round(effects.delayFeedback * 100)}%`}
          value={effects.delayFeedback}
          min={EFFECTS_LIMITS.delayFeedback.min}
          max={EFFECTS_LIMITS.delayFeedback.max}
          step={0.01}
          onChange={(v) => onEffect("delayFeedback", v)}
        />
        <EffectSlider
          label="Bass boost"
          displayValue={`${effects.bassBoost > 0 ? "+" : ""}${effects.bassBoost}dB`}
          value={effects.bassBoost}
          min={EFFECTS_LIMITS.bassBoost.min}
          max={EFFECTS_LIMITS.bassBoost.max}
          step={1}
          onChange={(v) => onEffect("bassBoost", v)}
        />
      </div>

      {/* Presets */}
      <StemPresetBar
        currentEffects={effects}
        presets={presets}
        selectedPreset={ui.selectedPreset}
        onApply={(effects, name) => onApplyEffects(effects, name)}
        onSave={onSavePreset}
        onDelete={onDeletePreset}
      />
    </div>
  );
}

function StemPresetBar({
  currentEffects,
  presets,
  selectedPreset,
  onApply,
  onSave,
  onDelete,
}: {
  currentEffects: EffectsState;
  presets: DubStemPreset[];
  selectedPreset: string | null;
  onApply: (effects: EffectsState, name: string | null) => void;
  onSave: (name: string, effects: EffectsState) => void;
  onDelete: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

  function handleSave() {
    if (!trimmed) return;
    onSave(trimmed, currentEffects);
    setName("");
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2.5">
      <div className="text-[10px] uppercase tracking-wide text-foreground/40">Presets</div>

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <div
              key={p.name}
              className={cn(
                "group flex items-center gap-0.5 rounded border px-1.5 py-0.5 transition",
                selectedPreset === p.name
                  ? "border-accent/50 bg-accent/10"
                  : "border-border bg-muted/50",
              )}
            >
              <button
                type="button"
                onClick={() => onApply(p.effects, p.name)}
                className={cn(
                  "text-[10px] transition hover:text-foreground",
                  selectedPreset === p.name ? "text-accent" : "text-foreground/70",
                )}
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(p.name)}
                className="text-[10px] text-foreground/30 opacity-0 transition hover:text-foreground/70 group-hover:opacity-100"
                aria-label="Delete preset"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="flex gap-1">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Save current as…"
          className="min-w-0 flex-1 rounded border border-border bg-muted px-2 py-0.5 text-[10px] outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!trimmed}
          className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] text-foreground/60 transition hover:text-foreground disabled:opacity-40"
        >
          Save
        </button>
      </form>
    </div>
  );
}

function EffectSlider({
  label,
  displayValue,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  displayValue: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-foreground/50">
        <span>{label}</span>
        <span className="tabular-nums">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  );
}

async function decodeStemBuffers(id: string): Promise<Record<StemName, AudioBuffer>> {
  const ctx = new AudioContext();
  const entries = await Promise.all(
    STEM_NAMES.map(async (stem) => {
      const res = await fetch(`/api/stems/${id}/${stem}`);
      if (!res.ok) throw new Error(`Failed to fetch ${stem} stem`);
      const arrayBuffer = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      return [stem, decoded] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<StemName, AudioBuffer>;
}
