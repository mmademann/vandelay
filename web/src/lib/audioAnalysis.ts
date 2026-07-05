import type { AnalysisResponse } from '../workers/audioAnalysisWorker';

const NOTE_SEMITONES: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8,
  Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export function rootSemitone(key: string): number | null {
  const root = key.trim().split(/\s+/)[0];
  const s = NOTE_SEMITONES[root];
  return s !== undefined ? s : null;
}

let worker: Worker | null = null;
const pending = new Map<string, (result: AnalysisResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/audioAnalysisWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data);
      }
    };
    worker.onerror = (e) => {
      console.error('[audioAnalysis] worker error', e);
    };
  }
  return worker;
}

export async function preloadEssentia(): Promise<void> {
  // Spin up the worker so WASM loading begins immediately
  getWorker();
}

export async function analyzeAudio(buffer: AudioBuffer): Promise<{ key: string; bpm: number } | null> {
  const id = crypto.randomUUID();
  const w = getWorker();

  // Extract channel data as transferable buffers
  const channelData: Float32Array[] = [];
  const transferList: ArrayBuffer[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c).slice(0);
    channelData.push(ch);
    transferList.push(ch.buffer);
  }

  return new Promise<{ key: string; bpm: number } | null>((resolve) => {
    pending.set(id, (result) => {
      if (!result.key) {
        resolve(null);
      } else {
        resolve({ key: result.key, bpm: result.bpm ?? 0 });
      }
    });
    w.postMessage({ id, channelData, sampleRate: buffer.sampleRate }, transferList);
  });
}
