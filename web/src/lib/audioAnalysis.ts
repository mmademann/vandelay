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

export async function preloadEssentia(): Promise<void> {
  await getEssentia();
}

function toMonoFloat32(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i];
  }
  if (n > 1) for (let i = 0; i < mono.length; i++) mono[i] /= n;
  return mono;
}

export async function analyzeAudio(buffer: AudioBuffer): Promise<{ key: string; bpm: number } | null> {
  const essentia = await getEssentia();
  if (!essentia) return null;

  try {
    const mono = toMonoFloat32(buffer);
    const vector = essentia.arrayToVector(mono);
    try {
      const keyResult = essentia.KeyExtractor(
        vector,
        true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate',
        buffer.sampleRate,
      );
      if (keyResult.strength < 0.2) return null;

      const keySuffix = keyResult.strength < 0.5 ? '?' : '';
      const key = `${keyResult.key} ${keyResult.scale}${keySuffix}`;
      const bpmResult = essentia.RhythmExtractor2013(vector);
      return { key, bpm: Math.round(bpmResult.bpm) };
    } finally {
      vector.delete();
    }
  } catch {
    return null;
  }
}
