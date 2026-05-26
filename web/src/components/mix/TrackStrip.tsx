import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMixStore, type MixTrack } from "../../mixStore";
import { appliedAudioEffects, type AudioTrackSettings } from "../../lib/mixSettings";
import { mixEngine } from "../../audio/mixEngine";
import { formatLoopTime, LOOP_TIME_FORMAT_HINT, parseLoopTime, setPlayheadLeft } from "../../lib/format";
import { cn } from "../../lib/cn";
import { MiniWaveform } from "./MiniWaveform";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { ReverbControls } from "../ReverbControls";

interface Props {
  track: MixTrack;
}

export function TrackStrip({ track }: Props) {
  const rawSettings = useMixStore((s) => s.settings[track.id]);
  const settings = rawSettings?.type === "audio" ? (rawSettings as AudioTrackSettings) : undefined;
  const paused = useMixStore((s) => s.pausedIds.has(track.id));
  const isPlaying = useMixStore((s) => s.isPlaying);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const setLoopRegion = useMixStore((s) => s.setLoopRegion);
  const setEffect = useMixStore((s) => s.setEffect);
  const setEffectsEnabled = useMixStore((s) => s.setEffectsEnabled);
  const setVolume = useMixStore((s) => s.setVolume);
  const setMuted = useMixStore((s) => s.setMuted);
  const togglePaused = useMixStore((s) => s.togglePaused);
  const resetTrackEffects = useMixStore((s) => s.resetTrackEffects);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [readyTrackId, setReadyTrackId] = useState<string | null>(null);
  const waveformReady = readyTrackId === track.id;

  useEffect(() => {
    setReadyTrackId(null);
  }, [track.id]);

  useEffect(() => {
    if (!settings) return;
    mixEngine.setLoop(track.id, settings.loopStart, settings.loopEnd);
    mixEngine.applyEffects(
      track.id,
      appliedAudioEffects(settings),
      settings.volumeDb,
      settings.muted,
    );
  }, [settings, track.id]);

  useEffect(() => {
    mixEngine.setPaused(track.id, paused);
  }, [paused, track.id]);

  useEffect(() => {
    function tick() {
      const pos = mixEngine.getPosition(track.id);
      setPlayheadLeft(cursorRef.current, pos, track.duration);
      if (timeReadoutRef.current) {
        timeReadoutRef.current.textContent = formatLoopTime(pos);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [track.id, track.duration]);

  useEffect(() => {
    if (!timeReadoutRef.current || isPlaying) return;
    timeReadoutRef.current.textContent = formatLoopTime(mixEngine.getPosition(track.id));
  }, [settings?.loopStart, settings?.loopEnd, isPlaying, track.id]);

  function handleRemove() {
    const ids = (searchParams.get("v") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((id) => id && id !== track.id);
    navigate(ids.length > 0 ? `/mix?v=${ids.join(",")}` : "/mix");
  }

  function applyTimes(start: number, end: number) {
    const clampedStart = Math.max(0, Math.min(track.duration, start));
    const clampedEnd = Math.max(clampedStart + 0.05, Math.min(track.duration, end));
    setLoopRegion(track.id, clampedStart, clampedEnd);
  }

  if (!settings) return null;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">{track.title}</div>
          <div className="text-xs text-foreground/50 tabular-nums">
            <span ref={timeReadoutRef} className="text-accent">{formatLoopTime(settings.loopStart)}</span>
            {" / "}
            {formatLoopTime(track.duration)}
            {" · "}
            {formatLoopTime(settings.loopStart)}–{formatLoopTime(settings.loopEnd)}
            {paused && <span className="ml-2 text-foreground/40">· paused</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={paused ? "primary" : "secondary"}
            onClick={() => togglePaused(track.id)}
            className="px-3 py-1 text-xs"
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" onClick={handleRemove} className="px-3 py-1 text-xs text-foreground/60">
            Remove
          </Button>
        </div>
      </div>

      <div className="mb-3">
        <MiniWaveform
          ref={cursorRef}
          buffer={track.buffer}
          duration={track.duration}
          loopStart={settings.loopStart}
          loopEnd={settings.loopEnd}
          onLoopChange={(s, e) => setLoopRegion(track.id, s, e)}
          onSeek={(time) => mixEngine.seek(track.id, time)}
          onReady={() => setReadyTrackId(track.id)}
        />
      </div>

      {waveformReady && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <TimeField
            label="Start"
            seconds={settings.loopStart}
            max={track.duration}
            onCommit={(s) => applyTimes(s, settings.loopEnd)}
          />
          <TimeField
            label="End"
            seconds={settings.loopEnd}
            max={track.duration}
            onCommit={(e) => applyTimes(settings.loopStart, e)}
          />
        </div>
      )}

      {waveformReady && (
        <Field label={`Volume: ${settings.muted ? "muted" : `${settings.volumeDb.toFixed(0)} dB`}`}
          right={
            <div className="flex items-center gap-2 text-xs text-foreground/60">
              mute
              <Switch checked={settings.muted} onChange={(b) => setMuted(track.id, b)} />
            </div>
          }
        >
          <Slider
            value={settings.volumeDb}
            onChange={(v) => setVolume(track.id, v)}
            min={-30}
            max={6}
            step={0.5}
            className={settings.muted ? "opacity-40 pointer-events-none" : ""}
          />
        </Field>
      )}

      {waveformReady && (
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-foreground/60">Effects</span>
            <div className="flex items-center gap-2 text-xs text-foreground/70">
              <span>{settings.effectsEnabled !== false ? "On" : "Off"}</span>
              <Switch
                checked={settings.effectsEnabled !== false}
                onChange={(b) => setEffectsEnabled(track.id, b)}
              />
            </div>
          </div>
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2",
              settings.effectsEnabled === false ? "pointer-events-none opacity-40" : undefined,
            )}
          >
        <Field label={`Speed: ${settings.effects.speed.toFixed(2)}×`}>
          <Slider
            value={settings.effects.speed}
            onChange={(v) => setEffect(track.id, "speed", v)}
            min={0.5}
            max={1.0}
          />
        </Field>

        <Field
          label={`Pitch: ${settings.effects.linkPitch ? "linked" : `${settings.effects.pitch >= 0 ? "+" : ""}${settings.effects.pitch} st`}`}
          right={
            <div className="flex items-center gap-2 text-xs text-foreground/60">
              link
              <Switch
                checked={settings.effects.linkPitch}
                onChange={(b) => setEffect(track.id, "linkPitch", b)}
              />
            </div>
          }
        >
          <Slider
            value={settings.effects.pitch}
            onChange={(v) => setEffect(track.id, "pitch", Math.round(v))}
            min={-12}
            max={12}
            step={1}
            className={settings.effects.linkPitch ? "opacity-40 pointer-events-none" : ""}
          />
        </Field>

        <ReverbControls
          effects={settings.effects}
          onChange={(key, value) => setEffect(track.id, key, value)}
          labelClassName="flex items-center justify-between"
        />

        <Field label={`Delay mix: ${(settings.effects.delayWet * 100).toFixed(0)}%`}>
          <Slider value={settings.effects.delayWet} onChange={(v) => setEffect(track.id, "delayWet", v)} min={0} max={1} />
        </Field>

        <Field label={`Delay time: ${settings.effects.delayTime.toFixed(2)}s`}>
          <Slider value={settings.effects.delayTime} onChange={(v) => setEffect(track.id, "delayTime", v)} min={0.01} max={4} step={0.01} />
        </Field>

        <Field label={`Delay feedback: ${(settings.effects.delayFeedback * 100).toFixed(0)}%`}>
          <Slider value={settings.effects.delayFeedback} onChange={(v) => setEffect(track.id, "delayFeedback", v)} min={0} max={0.95} step={0.01} />
        </Field>

        <Field label={`Bass boost: ${settings.effects.bassBoost >= 0 ? "+" : ""}${settings.effects.bassBoost.toFixed(0)} dB`}>
          <Slider value={settings.effects.bassBoost} onChange={(v) => setEffect(track.id, "bassBoost", v)} min={-20} max={20} step={1} />
        </Field>

        <Field label={`Gain: ${(settings.effects.gain * 100).toFixed(0)}%`}>
          <Slider value={settings.effects.gain} onChange={(v) => setEffect(track.id, "gain", v)} min={0} max={3} step={0.01} />
        </Field>
          </div>
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" onClick={() => resetTrackEffects(track.id)} className="text-xs text-foreground/50">
              Reset effects
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TimeFieldProps {
  label: string;
  seconds: number;
  max: number;
  onCommit: (seconds: number) => void;
}

function TimeField({ label, seconds, max, onCommit }: TimeFieldProps) {
  return (
    <label className="flex flex-col gap-1 text-xs text-foreground/60">
      <span className="uppercase tracking-wide">
        {label}{" "}
        <span className="normal-case text-foreground/40">({LOOP_TIME_FORMAT_HINT})</span>
      </span>
      <input
        key={Math.round(seconds * 100)}
        placeholder="3:21.50"
        defaultValue={formatLoopTime(seconds)}
        onBlur={(e) => {
          const parsed = parseLoopTime(e.target.value);
          if (parsed != null && parsed <= max) onCommit(parsed);
          else e.target.value = formatLoopTime(seconds);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-28 rounded-md border border-border bg-muted px-2 py-1 text-sm text-foreground tabular-nums outline-none focus:border-accent"
      />
    </label>
  );
}

function Field({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-foreground/60">
        <span>{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

