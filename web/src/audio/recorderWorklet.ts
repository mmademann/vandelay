/**
 * AudioWorklet processor that forwards raw stereo samples to the main thread.
 *
 * Loaded via `?url` (see multiRecorder.ts) so Vite emits it as a standalone module —
 * worklet code runs in its own realm and cannot import from the app bundle.
 */
const SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === "start") this.recording = true;
      else if (e.data === "stop") this.recording = false;
    };
  }

  process(inputs) {
    // Output stays silent — it exists only so the node is not pruned for driving nothing.
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // Copy — the underlying buffers are reused by the audio thread on the next quantum.
    // Mono input duplicates into a distinct buffer; transferring the same one twice would throw.
    const left = new Float32Array(input[0]);
    const right = new Float32Array(input.length > 1 ? input[1] : input[0]);
    this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    return true;
  }
}
registerProcessor("recorder-processor", RecorderProcessor);
`;

/** Blob URL for the worklet module — avoids a separate build entry point. */
export const recorderWorkletUrl = URL.createObjectURL(
  new Blob([SOURCE], { type: "application/javascript" }),
);
