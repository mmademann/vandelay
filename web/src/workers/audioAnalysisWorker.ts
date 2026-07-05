// eslint-disable-next-line @typescript-eslint/no-explicit-any
let essentiaPromise: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getEssentia(): Promise<any | null> {
  if (!essentiaPromise) {
    essentiaPromise = (async () => {
      try {
        const [wasmMod, coreMod] = await Promise.all([
          import('essentia.js/dist/essentia-wasm.web.js'),
          import('essentia.js/dist/essentia.js-core.es.js'),
        ]);
        const EssentiaWASM = wasmMod.default ?? wasmMod.EssentiaWASM ?? wasmMod;
        const essentiaModule = await EssentiaWASM({
          locateFile: (path: string) => path.endsWith('.wasm') ? '/essentia-wasm.web.wasm' : path,
        });
        return new coreMod.default(essentiaModule);
      } catch {
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
}

export interface AnalysisResponse {
  id: string;
  key: string | null;
  bpm: number | undefined;
  error?: string;
}

self.onmessage = async (e: MessageEvent<AnalysisRequest>) => {
  const { id, channelData, sampleRate } = e.data;

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

    const vector = essentia.arrayToVector(mono);
    try {
      const keyResult = essentia.KeyExtractor(
        vector,
        true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate',
        sampleRate,
      );
      if (keyResult.strength < 0.2) {
        self.postMessage({ id, key: null, bpm: undefined } satisfies AnalysisResponse);
        return;
      }

      const keySuffix = keyResult.strength < 0.5 ? '?' : '';
      const key = `${keyResult.key} ${keyResult.scale}${keySuffix}`;
      const bpmResult = essentia.RhythmExtractor2013(vector);
      self.postMessage({ id, key, bpm: Math.round(bpmResult.bpm) } satisfies AnalysisResponse);
    } finally {
      vector.delete();
    }
  } catch (err) {
    self.postMessage({ id, key: null, bpm: undefined, error: String(err) } satisfies AnalysisResponse);
  }
};
