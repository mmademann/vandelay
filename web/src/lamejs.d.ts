// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "essentia.js/dist/essentia-wasm.es.js" { const m: any; export = m; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "essentia.js/dist/essentia-wasm.web.js" { const m: any; export = m; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "essentia.js/dist/essentia.js-core.es.js" { const m: any; export = m; }

declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}
