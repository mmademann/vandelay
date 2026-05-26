import { forwardRef, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.js";
import { audioBufferToWav } from "../../audio/wav";
import { Spinner } from "../ui/Spinner";

interface Props {
  buffer: AudioBuffer;
  duration: number;
  loopStart: number;
  loopEnd: number;
  onLoopChange: (start: number, end: number) => void;
  onSeek?: (time: number) => void;
  onReady?: () => void;
}

export const MiniWaveform = forwardRef<HTMLDivElement, Props>(function MiniWaveform(
  { buffer, duration, loopStart, loopEnd, onLoopChange, onSeek, onReady },
  cursorRef,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const regionRef = useRef<Region | null>(null);
  const lastSavedRef = useRef({ start: loopStart, end: loopEnd });
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
  }, [buffer]);

  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#444",
      progressColor: "#444",
      cursorColor: "transparent",
      height: 56,
      interact: true,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      plugins: [regions],
    });

    ws.loadBlob(audioBufferToWav(buffer));

    ws.on("ready", () => {
      const start = Math.min(Math.max(0, lastSavedRef.current.start), duration);
      const end = Math.max(start + 0.05, Math.min(duration, lastSavedRef.current.end));
      const region = regions.addRegion({
        start,
        end,
        color: "rgba(64, 224, 208, 0.22)",
        drag: true,
        resize: true,
      });
      regionRef.current = region;
      region.on("update-end", () => {
        onLoopChange(region.start, region.end);
        lastSavedRef.current = {
          start: region.start,
          end: region.end,
        };
      });
      setReady(true);
      onReadyRef.current?.();
    });

    ws.on("interaction", (time: number) => {
      onSeekRef.current?.(time);
    });

    return () => {
      ws.destroy();
      regionRef.current = null;
    };
  }, [buffer, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    lastSavedRef.current = { start: loopStart, end: loopEnd };
    const r = regionRef.current;
    if (!r) return;
    if (Math.abs(r.start - loopStart) > 0.01 || Math.abs(r.end - loopEnd) > 0.01) {
      r.setOptions({ start: loopStart, end: loopEnd });
    }
  }, [loopStart, loopEnd]);

  return (
    <div className="overflow-hidden rounded-md bg-muted/40 p-1">
      <div className="waveform-viewport relative h-[56px] overflow-hidden">
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
  );
});
