import { useEffect, useRef } from "react";
import * as Tone from "tone";
import { STEM_NAMES, type StemName } from "../audio/dubEngine";

const H = 64;

function computePeaks(buffers: Record<StemName, AudioBuffer>, width: number): { pmin: Float32Array; pmax: Float32Array } {
  const totalSamples = buffers[STEM_NAMES[0]].length;
  const step = totalSamples / width;
  const stride = Math.max(1, Math.floor(step / 64));

  const chans = STEM_NAMES.map((s) => {
    const b = buffers[s];
    return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  });
  const totalChans = chans.reduce((sum, c) => sum + c.length, 0);

  const pmin = new Float32Array(width);
  const pmax = new Float32Array(width);

  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * step);
    const end = Math.min(Math.floor((x + 1) * step), totalSamples);
    let lo = 0, hi = 0;
    for (let i = start; i < end; i += stride) {
      let sample = 0;
      for (const stemChans of chans) for (const ch of stemChans) sample += ch[i];
      sample /= totalChans;
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    pmin[x] = lo;
    pmax[x] = hi;
  }

  let peak = 0;
  for (let x = 0; x < width; x++) {
    if (pmax[x] > peak) peak = pmax[x];
    if (-pmin[x] > peak) peak = -pmin[x];
  }
  if (peak > 0) {
    for (let x = 0; x < width; x++) { pmin[x] /= peak; pmax[x] /= peak; }
  }

  return { pmin, pmax };
}

function renderBase(canvas: HTMLCanvasElement, buffers: Record<StemName, AudioBuffer>): ImageData | null {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  if (w === 0) return null;
  canvas.width = w * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, H);

  const { pmin, pmax } = computePeaks(buffers, w);
  const mid = H / 2;
  ctx.fillStyle = "rgba(45, 212, 191, 0.38)";
  for (let x = 0; x < w; x++) {
    const top = mid - pmax[x] * mid;
    const bot = mid - pmin[x] * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function renderFrame(
  canvas: HTMLCanvasElement,
  base: ImageData,
  playRatio: number,
  loopEnabled: boolean,
  loopStartRatio: number,
  loopEndRatio: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(base, 0, 0);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  if (loopEnabled && loopEndRatio > loopStartRatio) {
    const lx = Math.floor(loopStartRatio * w);
    const rx = Math.floor(loopEndRatio * w);
    ctx.fillStyle = "rgba(45, 212, 191, 0.13)";
    ctx.fillRect(lx, 0, rx - lx, h);
    ctx.fillStyle = "rgba(45, 212, 191, 0.55)";
    ctx.fillRect(lx, 0, 2, h);
    ctx.fillRect(rx - 2, 0, 2, h);
  }

  const px = Math.floor(playRatio * w);
  if (!loopEnabled) {
    ctx.fillStyle = "rgba(45, 212, 191, 0.1)";
    ctx.fillRect(0, 0, px, h);
  }
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.fillRect(px, 0, 1, h);
}

export function DubWaveform({
  buffers,
  playing,
  seekOffset,
  loopEnabled,
  loopStart,
  loopEnd,
  onSeek,
  onEnd,
}: {
  buffers: Record<StemName, AudioBuffer>;
  playing: boolean;
  seekOffset: number;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  onSeek: (seconds: number) => void;
  onEnd: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<ImageData | null>(null);
  const rafRef = useRef(0);

  const playingRef = useRef(playing);
  const seekOffsetRef = useRef(seekOffset);
  const loopEnabledRef = useRef(loopEnabled);
  const loopStartRef = useRef(loopStart);
  const loopEndRef = useRef(loopEnd);
  const onEndRef = useRef(onEnd);
  const onSeekRef = useRef(onSeek);
  const durationRef = useRef(buffers[STEM_NAMES[0]].duration);
  playingRef.current = playing;
  seekOffsetRef.current = seekOffset;
  loopEnabledRef.current = loopEnabled;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;
  onEndRef.current = onEnd;
  onSeekRef.current = onSeek;
  durationRef.current = buffers[STEM_NAMES[0]].duration;

  function getPlayRatio(): number {
    const dur = durationRef.current;
    if (dur <= 0) return 0;
    if (loopEnabledRef.current) {
      return Math.min(1, (loopStartRef.current + Tone.getTransport().seconds) / dur);
    }
    return Math.min(1, (seekOffsetRef.current + Tone.getTransport().seconds) / dur);
  }

  function getLoopRatios() {
    const dur = durationRef.current;
    return {
      loopStartRatio: loopStartRef.current / dur,
      loopEndRatio: loopEndRef.current / dur,
    };
  }

  function repaint(playRatio?: number) {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base) return;
    const { loopStartRatio, loopEndRatio } = getLoopRatios();
    renderFrame(canvas, base, playRatio ?? getPlayRatio(), loopEnabledRef.current, loopStartRatio, loopEndRatio);
  }

  function rebuild() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    baseRef.current = renderBase(canvas, buffers);
    repaint(seekOffsetRef.current / durationRef.current);
  }

  useEffect(() => { rebuild(); }, [buffers]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => rebuild());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [buffers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Repaint static frame when loop region changes (while stopped)
  useEffect(() => {
    if (!playing) repaint(seekOffset / durationRef.current);
  }, [loopEnabled, loopStart, loopEnd, playing, seekOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);

    if (!playing) {
      repaint(seekOffsetRef.current / durationRef.current);
      return;
    }

    function tick() {
      const dur = durationRef.current;
      const elapsed = loopEnabledRef.current
        ? loopStartRef.current + Tone.getTransport().seconds
        : seekOffsetRef.current + Tone.getTransport().seconds;
      repaint(Math.min(1, elapsed / dur));
      if (!loopEnabledRef.current && elapsed >= dur) { onEndRef.current(); return; }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, seekOffset, loopEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeekRef.current(ratio * durationRef.current);
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ height: H }}
      className="w-full cursor-pointer rounded-md bg-muted/30"
      onClick={handleClick}
    />
  );
}
