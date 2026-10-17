import type { AnalysisResponse } from '../workers/audioAnalysisWorker';

const NOTE_SEMITONES: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8,
  Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/**
 * The semitone two keys must share to be in key with each other.
 *
 * A minor key is folded to its RELATIVE MAJOR — A minor and C major contain exactly the
 * same notes, so they need no transposition at all. Reading only the letter, as this used
 * to, made them look nine semitones apart: the A-minor stem was shifted down nine, landing
 * in C minor against a C major reference, which clashes on the third. Roughly half of all
 * pairs are a major against a minor, so half of all key matches were wrong in that way.
 *
 * This is the same fold Camelot / Open Key wheels use, for the same reason.
 *
 * Returns null for anything unparseable, and for a low-confidence detection — Essentia
 * marks those with a trailing `?`, and a guess should not drive a real pitch shift. That
 * rule was written down but never implemented.
 */
export function rootSemitone(key: string): number | null {
  const parts = key.trim().split(/\s+/);
  const root = parts[0];
  const scale = (parts[1] ?? "").toLowerCase();
  if (scale.endsWith("?")) return null;
  const s = NOTE_SEMITONES[root];
  if (s === undefined) return null;
  return scale.startsWith("min") ? (s + 3) % 12 : s;
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


/**
 * Key AND tempo from one region, in a single pass.
 *
 * Both matchers want the loop measured rather than the middle of the file, and running them
 * separately would analyse every slot twice — Lock All does keys then tempos, so that is two
 * Essentia passes per slot where one will do. Key extraction is the expensive half, so the
 * saving is most of the cost.
 */
export async function analyzeRegion(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
): Promise<{ key: string | null; bpm: number | undefined } | null> {
  return runAnalysis(buffer, { region: { startSec, endSec } });
}

export async function analyzeAudio(buffer: AudioBuffer): Promise<{ key: string | null; bpm: number | undefined } | null> {
  return runAnalysis(buffer, {});
}

async function runAnalysis(
  buffer: AudioBuffer,
  opts: { region?: { startSec: number; endSec: number }; tempoOnly?: boolean },
): Promise<{ key: string | null; bpm: number | undefined } | null> {
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

  return new Promise<{ key: string | null; bpm: number | undefined } | null>((resolve) => {
    pending.set(id, (result) => {
      // A null key no longer discards the result: unpitched material (drums) legitimately
      // has no key but still has a tempo, which the loop snapper needs.
      if (!result.key && result.bpm === undefined) {
        resolve(null);
      } else {
        resolve({ key: result.key, bpm: result.bpm });
      }
    });
    w.postMessage({ id, channelData, sampleRate: buffer.sampleRate, ...opts }, transferList);
  });
}
