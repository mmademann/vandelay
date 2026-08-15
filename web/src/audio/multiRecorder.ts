import * as Tone from "tone";
import { multiEngine } from "./multiEngine";
import { encodeExport } from "./encodeExport";
import type { ExportEncodeOptions } from "./exportOptions";
import { recorderWorkletUrl } from "./recorderWorklet";

/**
 * Captures the multi engine's master output as raw float samples.
 *
 * Raw capture rather than MediaRecorder: MediaRecorder only emits WebM/Opus, which would add a
 * lossy stage before the final encode. Chunks are held in memory (~10MB/min stereo at 44.1k) and
 * stitched into an AudioBuffer on stop, then handed to the same encodeExport() the export path
 * uses — so recordings and exports produce identical formats.
 */
class MultiRecorder {
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: { left: Float32Array; right: Float32Array }[] = [];
  private frames = 0;
  private recording = false;
  private startedAt = 0;
  private sampleRate = 44100;
  private workletLoaded = false;

  isRecording(): boolean { return this.recording; }

  /** Seconds elapsed since start, or 0 when idle. */
  elapsed(): number {
    if (!this.recording) return 0;
    return Math.max(0, Tone.now() - this.startedAt);
  }

  async start(): Promise<void> {
    if (this.recording) return;

    const master = multiEngine.getMasterNode();
    if (!master) throw new Error("Nothing to record — load a slot first.");

    await Tone.start();
    await Tone.getContext().resume();

    // Tone's own worklet helpers — rawContext is Tone's wrapper, not a native BaseAudioContext,
    // so `new AudioWorkletNode(rawContext, …)` throws.
    const ctx = Tone.getContext();
    if (!this.workletLoaded) {
      await ctx.addAudioWorkletModule(recorderWorkletUrl);
      this.workletLoaded = true;
    }

    this.chunks = [];
    this.frames = 0;
    this.sampleRate = ctx.sampleRate;

    // One output (kept silent) rather than zero — a node driving nothing can be pruned.
    this.node = ctx.createAudioWorkletNode("recorder-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    const native = ctx.rawContext as unknown as BaseAudioContext;
    this.sink = native.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink);
    this.sink.connect(native.destination);
    this.node.port.onmessage = (e: MessageEvent) => {
      const { left, right } = e.data as { left: Float32Array; right: Float32Array };
      this.chunks.push({ left, right });
      this.frames += left.length;
    };

    // Tap the master without disturbing its existing connection to destination.
    // Connect via the native node — Tone's connect() does not accept a raw AudioWorkletNode.
    (master.output as unknown as AudioNode).connect(this.node);
    this.node.port.postMessage("start");
    this.recording = true;
    this.startedAt = Tone.now();
  }

  /** Stops capture and encodes. Returns null if nothing was captured. */
  async stop(opts: ExportEncodeOptions): Promise<Blob | null> {
    if (!this.recording || !this.node) return null;
    this.recording = false;

    this.node.port.postMessage("stop");
    const node = this.node;
    const master = multiEngine.getMasterNode();
    try { (master?.output as unknown as AudioNode | undefined)?.disconnect(node); }
    catch { /* master may be gone */ }
    node.port.onmessage = null;
    node.disconnect();
    this.sink?.disconnect();
    this.sink = null;
    this.node = null;

    const chunks = this.chunks;
    this.chunks = [];
    if (this.frames === 0) return null;

    const buffer = new AudioBuffer({
      length: this.frames,
      sampleRate: this.sampleRate,
      numberOfChannels: 2,
    });
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let offset = 0;
    for (const chunk of chunks) {
      left.set(chunk.left, offset);
      right.set(chunk.right, offset);
      offset += chunk.left.length;
    }
    this.frames = 0;

    return encodeExport(buffer, opts);
  }

  /** Abandons an in-flight recording without encoding. */
  cancel(): void {
    if (!this.node) return;
    this.node.port.postMessage("stop");
    const master = multiEngine.getMasterNode();
    try { (master?.output as unknown as AudioNode | undefined)?.disconnect(this.node); }
    catch { /* master may be gone */ }
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.sink?.disconnect();
    this.sink = null;
    this.node = null;
    this.chunks = [];
    this.frames = 0;
    this.recording = false;
  }
}

export const multiRecorder = new MultiRecorder();
