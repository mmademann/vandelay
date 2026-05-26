import { deleteCachedAudio, getCachedAudio, putCachedAudio } from "./audioCache";

const bufferCache = new Map<string, AudioBuffer>();
let sharedContext: AudioContext | null = null;

function getContext(): AudioContext {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

async function fetchAudioBytes(id: string): Promise<ArrayBuffer> {
  const cached = await getCachedAudio(id);
  if (cached) return cached;

  const res = await fetch(`/api/audio/${id}`);
  if (!res.ok) throw new Error("Audio file not found in cache");
  const buf = await res.arrayBuffer();
  putCachedAudio(id, buf.slice(0));
  return buf;
}

export async function loadAudioBuffer(id: string): Promise<AudioBuffer> {
  const existing = bufferCache.get(id);
  if (existing) return existing;
  const arrayBuffer = await fetchAudioBytes(id);
  const buffer = await getContext().decodeAudioData(arrayBuffer.slice(0));
  bufferCache.set(id, buffer);
  return buffer;
}

export function evictBuffer(id: string): void {
  bufferCache.delete(id);
  deleteCachedAudio(id);
}
