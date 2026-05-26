import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.js";
import { effectiveEffects, sanitizeLoopRegion, useStore } from "../store";
import { engine } from "../audio/engine";
import { audioBufferToWav } from "../audio/wav";
import { formatLoopTime, LOOP_TIME_FORMAT_HINT, parseLoopTime, setPlayheadLeft } from "../lib/format";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";

interface Props {
  onReady?: (trackId: string) => void;
}

export function WaveformPlayer({ onReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const regionRef = useRef<Region | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const timeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const track = useStore((s) => s.track);
  const isPlaying = useStore((s) => s.isPlaying);
  const setIsPlaying = useStore((s) => s.setIsPlaying);
  const setLoopRegion = useStore((s) => s.setLoopRegion);
  const loopStart = useStore((s) => s.loopStart);
  const loopEnd = useStore((s) => s.loopEnd);
  const effects = useStore((s) => s.effects);
  const effectsEnabled = useStore((s) => s.effectsEnabled);
  const applied = effectiveEffects(effects, effectsEnabled);

  const [readyId, setReadyId] = useState<string | null>(null);
  const ready = readyId === track?.id;

  useEffect(() => {
    setReadyId(null);
  }, [track?.id]);

  useEffect(() => {
    if (!containerRef.current || !track) return;

    let cancelled = false;
    const trackId = track.id;
    const duration = track.buffer.duration;
    const setLoopRegionSnapshot = useStore.getState().setLoopRegion;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#444",
      progressColor: "#444",
      cursorColor: "transparent",
      height: 96,
      interact: true,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      plugins: [regions],
    });

    ws.loadBlob(audioBufferToWav(track.buffer));

    ws.on("ready", () => {
      if (cancelled || useStore.getState().track?.id !== trackId) return;

      const { loopStart: savedStart, loopEnd: savedEnd } = useStore.getState();
      const loop = sanitizeLoopRegion(
        savedStart,
        savedEnd > savedStart ? savedEnd : duration,
        duration,
      );
      const region = regions.addRegion({
        start: loop.loopStart,
        end: loop.loopEnd,
        color: "rgba(64, 224, 208, 0.22)",
        drag: true,
        resize: true,
      });
      regionRef.current = region;
      setLoopRegionSnapshot(loop.loopStart, loop.loopEnd);
      engine.setLoop(loop.loopStart, loop.loopEnd);
      region.on("update-end", () => {
        const loop = sanitizeLoopRegion(region.start, region.end, duration);
        setLoopRegionSnapshot(loop.loopStart, loop.loopEnd);
        engine.setLoop(loop.loopStart, loop.loopEnd);
      });
      setReadyId(trackId);
      onReadyRef.current?.(trackId);
    });

    ws.on("interaction", (time: number) => {
      void engine.seek(time);
    });

    return () => {
      cancelled = true;
      ws.destroy();
      regionRef.current = null;
      setReadyId(null);
    };
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready || !regionRef.current || !track) return;
    const region = regionRef.current;
    if (
      Math.abs(region.start - loopStart) < 0.001
      && Math.abs(region.end - loopEnd) < 0.001
    ) {
      return;
    }
    region.setOptions({ start: loopStart, end: loopEnd });
    engine.setLoop(loopStart, loopEnd);
  }, [loopStart, loopEnd, ready, track?.id]);

  useEffect(() => {
    if (!ready || !track) return;
    function tick() {
      const pos = engine.getPosition();
      setPlayheadLeft(cursorRef.current, pos, track!.duration);
      if (timeReadoutRef.current) {
        timeReadoutRef.current.textContent = formatLoopTime(pos);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [ready, track?.id]);

  useEffect(() => {
    if (!ready || !timeReadoutRef.current) return;
    if (isPlaying) return;
    timeReadoutRef.current.textContent = formatLoopTime(engine.getPosition());
  }, [loopStart, loopEnd, ready, isPlaying, track?.id]);

  async function togglePlay() {
    if (isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      await engine.play(engine.getPosition());
      engine.setLoop(loopStart, loopEnd);
      engine.applyEffects(applied);
      setIsPlaying(true);
    }
  }

  function applyTimes(start: number, end: number) {
    if (!track) return;
    const loop = sanitizeLoopRegion(start, end, track.duration);
    setLoopRegion(loop.loopStart, loop.loopEnd);
    engine.setLoop(loop.loopStart, loop.loopEnd);
    regionRef.current?.setOptions({ start: loop.loopStart, end: loop.loopEnd });
  }

  if (!track) return null;

  return (
    <div className="flex flex-col gap-3">
      {ready ? (
        <div className="flex items-baseline justify-between">
          <div className="text-sm text-foreground/70">{track.title}</div>
          <div className="text-xs tabular-nums text-foreground/50">
            <span ref={timeReadoutRef} className="text-accent">{formatLoopTime(loopStart)}</span>
            {" / "}
            {formatLoopTime(track.duration)}
            {" · "}
            {formatLoopTime(loopStart)}–{formatLoopTime(loopEnd)}
          </div>
        </div>
      ) : (
        <div className="text-sm text-foreground/70">{track.title}</div>
      )}

      <div className="overflow-hidden rounded-md bg-muted/40 p-2">
        <div className="waveform-viewport relative h-[96px] overflow-hidden">
          <div ref={containerRef} className="h-full w-full" />
          {ready && (
            <div
              ref={cursorRef}
              className="pointer-events-none absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-accent"
              style={{ left: "0%" }}
            />
          )}
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-foreground/60">
              <Spinner />
            </div>
          )}
        </div>
      </div>

      {ready && (
        <div className="flex flex-wrap items-end gap-3">
          <Button onClick={togglePlay}>{isPlaying ? "Stop" : "Play loop"}</Button>
          <TimeField
            label="Start"
            seconds={loopStart}
            max={track.duration}
            onCommit={(s) => applyTimes(s, loopEnd)}
          />
          <TimeField
            label="End"
            seconds={loopEnd}
            max={track.duration}
            onCommit={(e) => applyTimes(loopStart, e)}
          />
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
