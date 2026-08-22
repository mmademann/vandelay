// SoundTouch is a buffer processor, not a streaming filter: you feed it a whole source
// and pull until it drains. Running it inside a worklet means the player's feed rate and
// SoundTouch's output rate never reconcile, so the stretch is baked into the buffer up
// front instead of applied live.
import { SoundTouch, SimpleFilter } from "soundtouchjs";

/** How much silence to serve past the end so SoundTouch flushes its internal window. */
const FLUSH_PAD_SEC = 0.5;
const CHUNK = 8192;

/**
 * Serves a decoded AudioBuffer to SimpleFilter, which pulls interleaved stereo frames.
 *
 * Reads past the end return silence rather than stopping: SoundTouch holds roughly a
 * window of audio internally and stops emitting once the source runs dry, which loses
 * the tail (~8% of the buffer). The padding pushes that remainder out; it is trimmed
 * from the result afterwards.
 */
class BufferSource {
  private left: Float32Array;
  private right: Float32Array;
  private padFrames: number;

  constructor(buffer: AudioBuffer, padFrames: number) {
    this.left = buffer.getChannelData(0);
    this.right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : this.left;
    this.padFrames = padFrames;
  }

  extract(target: Float32Array, numFrames: number, position: number): number {
    const limit = this.left.length + this.padFrames;
    const available = Math.max(0, Math.min(numFrames, limit - position));
    for (let i = 0; i < available; i++) {
      const p = position + i;
      const inRange = p < this.left.length;
      target[i * 2] = inRange ? this.left[p] : 0;
      target[i * 2 + 1] = inRange ? this.right[p] : 0;
    }
    return available;
  }
}

/**
 * Return a copy of `buffer` lengthened by `stretch` (2 = twice as long) with pitch
 * unchanged. Always stretches from the original source, so repeated calls do not
 * compound artifacts.
 */
export function stretchBuffer(buffer: AudioBuffer, stretch: number): AudioBuffer {
  if (!Number.isFinite(stretch) || Math.abs(stretch - 1) < 0.001) return buffer;

  const soundtouch = new SoundTouch();
  // tempo < 1 plays back longer. A stretch of 1.25 means "25% longer", so invert.
  soundtouch.tempo = 1 / stretch;

  const padFrames = Math.ceil(buffer.sampleRate * FLUSH_PAD_SEC);
  const filter = new SimpleFilter(new BufferSource(buffer, padFrames), soundtouch);

  // What the output should be, so the flushed tail can be trimmed back to length.
  const expectedFrames = Math.round(buffer.length * stretch);
  // Generous ceiling; guards against a non-terminating pull.
  const maxFrames = Math.ceil(buffer.length * stretch * 1.5) + CHUNK;

  const scratch = new Float32Array(CHUNK * 2);
  const chunks: { l: Float32Array; r: Float32Array }[] = [];
  let total = 0;

  for (;;) {
    const got = filter.extract(scratch, CHUNK);
    if (got <= 0) break;
    const l = new Float32Array(got);
    const r = new Float32Array(got);
    for (let i = 0; i < got; i++) {
      l[i] = scratch[i * 2];
      r[i] = scratch[i * 2 + 1];
    }
    chunks.push({ l, r });
    total += got;
    if (total >= maxFrames) break;
  }

  const finalFrames = Math.max(1, Math.min(total, expectedFrames));
  const out = new AudioBuffer({
    length: finalFrames,
    numberOfChannels: 2,
    sampleRate: buffer.sampleRate,
  });
  const outL = out.getChannelData(0);
  const outR = out.getChannelData(1);

  let offset = 0;
  for (const { l, r } of chunks) {
    if (offset >= finalFrames) break;
    const room = finalFrames - offset;
    const cl = l.length <= room ? l : l.subarray(0, room);
    const cr = r.length <= room ? r : r.subarray(0, room);
    outL.set(cl, offset);
    outR.set(cr, offset);
    offset += cl.length;
  }

  return out;
}
