declare module "soundtouchjs" {
  export class SoundTouch {
    tempo: number;
    rate: number;
    pitch: number;
  }
  export class SimpleFilter {
    constructor(
      source: { extract(target: Float32Array, numFrames: number, position: number): number },
      pipe: SoundTouch,
    );
    extract(target: Float32Array, numFrames: number): number;
    clear(): void;
  }
}
