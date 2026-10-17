// eslint-disable-next-line @typescript-eslint/no-explicit-any
let essentiaPromise: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getEssentia(): Promise<any | null> {
  if (!essentiaPromise) {
    essentiaPromise = (async () => {
      try {
        // Emscripten decides where it is running by probing for `importScripts`. A MODULE
        // worker does not have it (that is a classic-worker API), so it concludes it must be
        // on a page and reaches for `document.currentScript` to find its own URL — and a
        // worker has no document either. It threw on the very first line of loading, the
        // bare catch below swallowed it, and every track in the app came back with no key
        // and no tempo in about 50ms. That is the whole reason key and tempo matching did
        // nothing: not detection quality, not file length — Essentia never loaded at all.
        //
        // A stub is enough: the only thing read is `currentScript`, and we override the wasm
        // path with locateFile anyway. vite.config's worker.format "es" is load-bearing
        // (invariant 27), so becoming a classic worker is not an option.
        const g = globalThis as unknown as { document?: { currentScript: null } };
        if (typeof g.document === 'undefined') g.document = { currentScript: null };

        const [wasmMod, coreMod] = await Promise.all([
          import('essentia.js/dist/essentia-wasm.web.js'),
          import('essentia.js/dist/essentia.js-core.es.js'),
        ]);
        const EssentiaWASM = wasmMod.default ?? wasmMod.EssentiaWASM ?? wasmMod;
        const essentiaModule = await EssentiaWASM({
          locateFile: (path: string) => path.endsWith('.wasm') ? '/essentia-wasm.web.wasm' : path,
        });
        return new coreMod.default(essentiaModule);
      } catch (err) {
        // Loudly. A bare catch here meant the entire analysis feature could be dead — every
        // track returning no key and no tempo in 50ms — and nothing anywhere said so.
        console.error('[analysis] Essentia failed to load:', err);
        essentiaPromise = null;
        return null;
      }
    })();
  }
  return essentiaPromise;
}

export interface AnalysisRequest {
  id: string;
  channelData: Float32Array[];
  sampleRate: number;
  /** Seconds to centre the tempo window on. Omitted means the middle of the whole track. */
  region?: { startSec: number; endSec: number };
  /** Skip key extraction — a re-detect from the loop only wants the tempo. */
  tempoOnly?: boolean;
}

export interface AnalysisResponse {
  id: string;
  key: string | null;
  bpm: number | undefined;
  error?: string;
}

/** Control-flow marker for "caller asked for tempo only", not an error condition. */
class SkipKey extends Error {}

/** Seconds of audio the tempo pass looks at. Tempo does not change, so more buys nothing. */
const RHYTHM_WINDOW_SEC = 60;
/**
 * Floor for that window when the caller names a region.
 *
 * A four-bar loop is about eight seconds, and rhythm extraction gets unreliable below
 * roughly this much audio — it returns 0 rather than a wrong answer, which reads as "no
 * tempo". So a short loop is treated as a centre point to grow around, not a hard boundary.
 */
const RHYTHM_MIN_SEC = 20;

/**
 * Tempo for one track.
 *
 * Runs on a slice from the middle, NOT the whole file. RhythmExtractor2013 in its default
 * multifeature mode is the heaviest algorithm here, and handing it a five-minute stem —
 * thirteen million samples — exhausted the WASM heap every time. It threw, the throw was
 * swallowed by a bare catch, and every track in the app silently fell back to the rough
 * onset estimate in loopSnap. Keys worked throughout, because KeyExtractor is far cheaper,
 * which is exactly why the failure went unnoticed for so long.
 *
 * The middle of the track rather than the start: intros are often sparse or beatless.
 *
 * Percival is the fallback. It is cheaper and less accurate, but a second opinion beats
 * nothing, and the two disagreeing is itself worth knowing.
 */
/**
 * The window both passes analyse: centred on the region when there is one, on the track
 * otherwise. Width is the region's own length, floored at RHYTHM_MIN_SEC and capped at
 * RHYTHM_WINDOW_SEC, then clamped to what the track actually has.
 *
 * The middle rather than the start, because intros are often sparse or beatless.
 */
function sliceAround(
  mono: Float32Array,
  sampleRate: number,
  region?: { startSec: number; endSec: number },
): Float32Array {
  const regionLen = region ? Math.max(0, region.endSec - region.startSec) * sampleRate : 0;
  const wanted = region
    ? Math.min(RHYTHM_WINDOW_SEC * sampleRate, Math.max(RHYTHM_MIN_SEC * sampleRate, regionLen))
    : RHYTHM_WINDOW_SEC * sampleRate;
  const want = Math.min(mono.length, Math.round(wanted));
  const centre = region ? ((region.startSec + region.endSec) / 2) * sampleRate : mono.length / 2;
  const start = Math.max(0, Math.min(mono.length - want, Math.floor(centre - want / 2)));
  return mono.subarray(start, start + want);
}

function estimateTempo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  essentia: any,
  mono: Float32Array,
  sampleRate: number,
  region?: { startSec: number; endSec: number },
): { bpm: number | undefined; bpmError?: string } {
  const slice = sliceAround(mono, sampleRate, region);

  // Essentia returns 0 when it finds no pulse at all, so the range check is load-bearing.
  const usable = (v: number) => Number.isFinite(v) && v >= 40 && v <= 250;
  const vector = essentia.arrayToVector(slice);
  try {
    let firstError = '';
    try {
      const v = Math.round(essentia.RhythmExtractor2013(vector).bpm);
      if (usable(v)) return { bpm: v };
      firstError = `RhythmExtractor2013 returned ${v}`;
    } catch (err) {
      firstError = `RhythmExtractor2013 threw: ${String(err)}`;
    }
    try {
      const v = Math.round(
        essentia.PercivalBpmEstimator(vector, 1024, 2048, 128, 128, 210, 50, sampleRate).bpm,
      );
      if (usable(v)) return { bpm: v };
      return { bpm: undefined, bpmError: `${firstError}; Percival returned ${v}` };
    } catch (err) {
      return { bpm: undefined, bpmError: `${firstError}; Percival threw: ${String(err)}` };
    }
  } finally {
    vector.delete();
  }
}

self.onmessage = async (e: MessageEvent<AnalysisRequest>) => {
  const { id, channelData, sampleRate, region, tempoOnly } = e.data;

  const essentia = await getEssentia();
  if (!essentia) {
    self.postMessage({ id, key: null, bpm: undefined, error: 'Essentia failed to load' } satisfies AnalysisResponse);
    return;
  }

  try {
    const len = channelData[0].length;
    const mono = new Float32Array(len);
    for (const ch of channelData) {
      for (let i = 0; i < len; i++) mono[i] += ch[i];
    }
    if (channelData.length > 1) {
      for (let i = 0; i < len; i++) mono[i] /= channelData.length;
    }

    // Key and tempo are independent. Drums are unpitched, so key detection is expected to
    // fail on them — bailing out on that also threw away the BPM, which is the one thing
    // rhythm extraction gets right on a drum stem.
    let key: string | null = null;
    // Same slice the tempo pass uses, and for the same reason. KeyExtractor averages chroma
    // across everything it is given, so a whole multi-minute track — intro, breakdown,
    // outro, key change — flattens into a profile with no clear winner. It did not crash
    // the way rhythm extraction did; it just returned a strength below the 0.2 floor and
    // the result was discarded. Every stem in the library came back with no key at all.
    const keySlice = tempoOnly ? null : sliceAround(mono, sampleRate, region);
    const keyVector = keySlice ? essentia.arrayToVector(keySlice) : null;
    try {
      if (!keyVector) throw new SkipKey();
      const keyResult = essentia.KeyExtractor(
        keyVector,
        true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate',
        sampleRate,
      );
      if (keyResult.strength >= 0.2) {
        const keySuffix = keyResult.strength < 0.5 ? '?' : '';
        key = `${keyResult.key} ${keyResult.scale}${keySuffix}`;
      }
    } catch (err) {
      if (!(err instanceof SkipKey)) throw err;
    } finally {
      // Freed before the rhythm pass rather than at the end of both: holding two copies of a
      // multi-minute track in the WASM heap at once is most of the reason this used to die.
      keyVector?.delete();
    }

    const { bpm, bpmError } = estimateTempo(essentia, mono, sampleRate, region);
    if (bpmError) console.warn(`[analysis] no BPM for ${id}: ${bpmError}`);

    self.postMessage({ id, key, bpm, error: bpmError } satisfies AnalysisResponse);
  } catch (err) {
    self.postMessage({ id, key: null, bpm: undefined, error: String(err) } satisfies AnalysisResponse);
  }
};
