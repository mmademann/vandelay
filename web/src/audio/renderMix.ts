import * as Tone from "tone";
import type { MixTrack } from "../mixStore";
import {
  appliedAudioEffects,
  type AudioTrackSettings,
  type MixTrackSettings,
  type DrumTrackSettings,
  DRUM_TRACK_ID,
} from "../lib/mixSettings";
import { playbackRateForEffects } from "./engine";
import { encodeExport } from "./encodeExport";
import { createOfflineEqChain, ensureImpulseLoaded, reverbExportTailSec } from "./reverbSlot";
import type { ExportEncodeOptions } from "./exportOptions";

interface RenderOptions {
  tracks: MixTrack[];
  settings: Record<string, MixTrackSettings>;
  masterGain: number;
  loopCount: number;
  pausedIds?: ReadonlySet<string>;
  export: ExportEncodeOptions;
}

function drumBarDurationSec(drums: DrumTrackSettings): number {
  return (60 / drums.bpm) * 4;
}

function getDrums(settings: Record<string, MixTrackSettings>): DrumTrackSettings | null {
  const d = settings[DRUM_TRACK_ID];
  return d?.type === "drums" ? d : null;
}

function drumsExportActive(drums: DrumTrackSettings | null): drums is DrumTrackSettings {
  return !!drums && drums.pattern !== "off" && !drums.muted;
}

function isAudioTrackExportable(
  track: MixTrack,
  settings: Record<string, MixTrackSettings>,
  pausedIds: ReadonlySet<string>,
): boolean {
  if (pausedIds.has(track.id)) return false;
  const cfg = settings[track.id];
  return !!cfg && cfg.type === "audio" && !cfg.muted;
}

/** Wall-clock mix export length (seconds), matching renderMix. */
export function computeMixExportDuration(opts: {
  tracks: MixTrack[];
  settings: Record<string, MixTrackSettings>;
  loopCount: number;
  pausedIds?: ReadonlySet<string>;
}): number {
  const pausedIds = opts.pausedIds ?? new Set<string>();
  const drums = getDrums(opts.settings);
  let longest = 0;
  for (const track of opts.tracks) {
    if (!isAudioTrackExportable(track, opts.settings, pausedIds)) continue;
    const cfg = opts.settings[track.id] as AudioTrackSettings;
    const seg =
      (cfg.loopEnd - cfg.loopStart) / playbackRateForEffects(appliedAudioEffects(cfg));
    longest = Math.max(longest, seg);
  }
  if (longest === 0 && drumsExportActive(drums)) {
    longest = drumBarDurationSec(drums);
  }
  return longest * opts.loopCount;
}

export function canExportMix(opts: {
  tracks: MixTrack[];
  settings: Record<string, MixTrackSettings>;
  pausedIds?: ReadonlySet<string>;
}): boolean {
  const pausedIds = opts.pausedIds ?? new Set<string>();
  if (drumsExportActive(getDrums(opts.settings))) return true;
  return opts.tracks.some((t) => isAudioTrackExportable(t, opts.settings, pausedIds));
}

export async function renderMix(opts: RenderOptions): Promise<Blob> {
  const { tracks, settings, masterGain, loopCount, export: exportOpts } = opts;
  const pausedIds = opts.pausedIds ?? new Set<string>();
  const drums = getDrums(settings);
  const exportTracks = tracks.filter((t) =>
    isAudioTrackExportable(t, settings, pausedIds),
  );

  if (exportTracks.length === 0 && !drumsExportActive(drums)) {
    throw new Error("No tracks to render");
  }

  const longestSegment = computeMixExportDuration({
    tracks,
    settings,
    loopCount: 1,
    pausedIds,
  });
  const totalDuration = longestSegment * loopCount;
  const tailSources: number[] = exportTracks.map((t) => {
    const cfg = settings[t.id];
    return cfg?.type === "audio" ? reverbExportTailSec(appliedAudioEffects(cfg)) : 0;
  });
  if (drumsExportActive(drums)) {
    tailSources.push(
      reverbExportTailSec(drums.effects),
      reverbExportTailSec(drums.hatEffects),
    );
  }
  const tail = Math.min(Math.max(0, ...tailSources), 8);

  const sampleRate = Math.max(
    ...exportTracks.map((t) => t.buffer.sampleRate),
    44100,
  );

  await ensureImpulseLoaded();

  const rendered = await Tone.Offline(async ({ transport }) => {
    const master = new Tone.Gain(masterGain).toDestination();

    for (const track of exportTracks) {
      const cfg = settings[track.id];
      if (!cfg || cfg.type !== "audio") continue;

      const applied = appliedAudioEffects(cfg);
      const volume = new Tone.Volume(cfg.volumeDb).connect(master);
      const eq = await createOfflineEqChain(applied, volume);

      const channels: Float32Array[] = [];
      for (let c = 0; c < track.buffer.numberOfChannels; c++) {
        channels.push(track.buffer.getChannelData(c));
      }
      const toneBuffer = new Tone.ToneAudioBuffer().fromArray(channels);

      const rate = playbackRateForEffects(applied);
      const span = cfg.loopEnd - cfg.loopStart;
      const segmentDuration = span / rate;

      const player = new Tone.Player(toneBuffer).connect(eq);
      player.loop = false;
      player.playbackRate = rate;

      for (let i = 0; i < loopCount; i++) {
        player.start(i * segmentDuration, cfg.loopStart, span);
      }
    }

    if (drumsExportActive(drums)) {
      transport.bpm.value = drums.bpm;

      const drumVolume = new Tone.Volume(drums.volumeDb).connect(master);
      const kickEq = await createOfflineEqChain(drums.effects, drumVolume);
      const hatEq = await createOfflineEqChain(drums.hatEffects, drumVolume);

      const kickGain = new Tone.Gain(drums.kickVolume).connect(kickEq);
      const kick = new Tone.MembraneSynth({
        pitchDecay: drums.kickDecay * 0.3,
        octaves: drums.kickPunch,
        envelope: { attack: 0.001, decay: drums.kickDecay, sustain: 0, release: 0.5 },
      }).connect(kickGain);

      const hatGain = new Tone.Gain(drums.hatVolume).connect(hatEq);
      const hat = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 0.1, release: 0.01 },
        harmonicity: 5.1,
        modulationIndex: 32,
        resonance: 4000,
        octaves: 1.5,
      }).connect(hatGain);
      hat.frequency.value = 400;

      const stepDuration = (60 / drums.bpm) / 4;
      const totalSteps = Math.ceil(totalDuration / stepDuration);
      const hatAudible = drums.hatVolume > 0;
      for (let i = 0; i < totalSteps; i++) {
        const stepIndex = i % 16;
        const time = i * stepDuration;
        if (drums.kickSteps[stepIndex]) {
          kick.triggerAttackRelease(drums.kickTone, "8n", time);
        }
        if (hatAudible && drums.hatSteps[stepIndex]) {
          hat.triggerAttackRelease("16n", time);
        }
      }
    }

    transport.start();
  }, totalDuration + tail, 2, sampleRate);

  return encodeExport(rendered.get() as AudioBuffer, exportOpts);
}
