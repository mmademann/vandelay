// @breezystack/lamejs is the maintained ESM-correct fork. Upstream lamejs@1.2.1 declares
// MPEGMode/Lame/BitStream as bare top-level vars, which throws "MPEGMode is not defined"
// once bundled as a module. Same API.
import * as lamejs from "@breezystack/lamejs";
import { audioBufferToWav } from "./wav";
import {
  EXPORT_PRESETS,
  type ExportEncodeOptions,
  type ExportFormat,
} from "./exportOptions";

const MP3_BLOCK = 1152;

async function resampleBuffer(buffer: AudioBuffer, sampleRate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate) return buffer;
  const length = Math.max(1, Math.ceil(buffer.duration * sampleRate));
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    length,
    sampleRate,
  );
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

function downmixToMonoBuffer(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const mono = new AudioBuffer({
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    numberOfChannels: 1,
  });
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  const out = mono.getChannelData(0);
  for (let i = 0; i < buffer.length; i++) out[i] = (l[i] + r[i]) * 0.5;
  return mono;
}

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function bufferToChannelArrays(
  buffer: AudioBuffer,
  channels: 1 | 2,
): Float32Array[] {
  if (channels === 1) {
    const mono = buffer.numberOfChannels === 1
      ? buffer.getChannelData(0)
      : downmixToMonoBuffer(buffer).getChannelData(0);
    return [mono];
  }
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return [left, right];
}

function encodeMp3(
  channelData: Float32Array[],
  sampleRate: number,
  kbps: number,
): Blob {
  const channels = channelData.length;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const pcm = channelData.map(floatToInt16);
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < pcm[0].length; i += MP3_BLOCK) {
    const left = pcm[0].subarray(i, i + MP3_BLOCK);
    let block: Uint8Array;
    if (channels === 2) {
      const right = pcm[1].subarray(i, i + MP3_BLOCK);
      block = encoder.encodeBuffer(left, right);
    } else {
      block = encoder.encodeBuffer(left);
    }
    if (block.length > 0) chunks.push(block);
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
}

/** Resample / downmix after render — render always uses the source buffer's sample rate. */
export async function encodeExport(
  rendered: AudioBuffer,
  opts: ExportEncodeOptions,
): Promise<Blob> {
  const preset = EXPORT_PRESETS[opts.quality];
  let buffer = await resampleBuffer(rendered, preset.sampleRate);
  if (preset.channels === 1) {
    buffer = downmixToMonoBuffer(buffer);
  }

  const channels = bufferToChannelArrays(buffer, preset.channels);

  if (opts.format === "mp3") {
    return encodeMp3(channels, buffer.sampleRate, preset.mp3Kbps);
  }

  return audioBufferToWav(buffer);
}

export function exportMimeType(format: ExportFormat): string {
  return format === "mp3" ? "audio/mpeg" : "audio/wav";
}
