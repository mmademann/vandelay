import { EFFECTS_LIMITS } from "../store";

// Returns true if the buffer has enough meaningful audio to be worth using in a random session.
// Checks what fraction of 100ms frames have RMS above -48 dBFS; viable if >8% are active.
export function computeStemViability(buffer: AudioBuffer): boolean {
  const frameSize = Math.round(buffer.sampleRate * 0.1); // 100ms
  const threshold = Math.pow(10, -48 / 20); // -48 dBFS ≈ 0.004
  let activeFrames = 0;
  let totalFrames = 0;
  const ch = buffer.getChannelData(0); // mono check is sufficient
  for (let start = 0; start + frameSize <= ch.length; start += frameSize) {
    let sumSq = 0;
    for (let i = start; i < start + frameSize; i++) sumSq += ch[i] * ch[i];
    if (Math.sqrt(sumSq / frameSize) > threshold) activeFrames++;
    totalFrames++;
  }
  return totalFrames === 0 ? false : activeFrames / totalFrames > 0.08;
}

export function computeAutoGain(buffer: AudioBuffer, targetDb = -18): number {
  let sumSq = 0;
  let count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      sumSq += data[i] * data[i];
      count++;
    }
  }
  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
  if (rms < 1e-10) return 0;
  const rmsDb = 20 * Math.log10(rms);
  const gainNeeded = targetDb - rmsDb;
  if (gainNeeded < 0) return 0; // track is already louder than target — don't auto-attenuate
  return Math.min(gainNeeded, EFFECTS_LIMITS.gain.max);
}
