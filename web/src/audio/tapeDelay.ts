import * as Tone from "tone";

/**
 * RE-201-style tape delay.
 *
 * Topology:
 *   input ──► dryGain ──► output
 *         └──► Delay ──► wetGain ──► output
 *                  ↑
 *             feedback: Filter → Distortion → feedbackGain ──► Delay input
 *         LFO → delayTime
 *
 * At wow=0: filter open, saturation=0, LFO amplitude=0 → clean digital delay.
 */
export class TapeDelay {
  private _inputNode: Tone.Gain;
  private _delay: Tone.Delay;
  private _dryGain: Tone.Gain;
  private _wetGain: Tone.Gain;
  private _feedbackGain: Tone.Gain;
  private _feedbackFilter: Tone.Filter;
  private _feedbackDist: Tone.Distortion;
  private _lfo: Tone.LFO;
  private _delayTimeSec: number;

  readonly delayTime: { value: number };
  readonly feedback: { value: number };
  readonly wet: { value: number };

  constructor(output: Tone.ToneAudioNode, options?: { delayTime?: number; feedback?: number; wet?: number }) {
    const dt = options?.delayTime ?? 0.25;
    const fb = options?.feedback ?? 0.3;
    const w = options?.wet ?? 0;
    this._delayTimeSec = dt;

    this._delay = new Tone.Delay({ delayTime: dt, maxDelay: 4 });
    this._dryGain = new Tone.Gain(1 - w).connect(output);
    this._wetGain = new Tone.Gain(w).connect(output);

    // Input fan-out: dry bypass + into delay
    this._inputNode = new Tone.Gain(1);
    this._inputNode.connect(this._dryGain);
    this._inputNode.connect(this._delay);

    // Feedback path: delay out → filter → distortion → gain → back into delay
    this._feedbackFilter = new Tone.Filter({ type: "lowpass", frequency: 20000, rolloff: -12 });
    this._feedbackDist = new Tone.Distortion({ distortion: 0, wet: 0 });
    this._feedbackGain = new Tone.Gain(fb);

    this._delay.connect(this._feedbackFilter);
    this._feedbackFilter.connect(this._feedbackDist);
    this._feedbackDist.connect(this._feedbackGain);
    this._feedbackGain.connect(this._delay);

    // Delay wet output
    this._delay.connect(this._wetGain);

    // LFO for wow/flutter
    this._lfo = new Tone.LFO({ frequency: 0.9, min: dt - 0.001, max: dt + 0.001, amplitude: 0 });
    this._lfo.connect(this._delay.delayTime);
    this._lfo.start();

    const self = this;
    this.delayTime = {
      get value() { return self._delayTimeSec; },
      set value(v: number) {
        self._delayTimeSec = v;
        self._delay.delayTime.value = v;
        self._lfo.min = v - 0.001;
        self._lfo.max = v + 0.001;
      },
    };
    this.feedback = {
      get value() { return self._feedbackGain.gain.value; },
      set value(v: number) { self._feedbackGain.gain.value = v; },
    };
    this.wet = {
      get value() { return self._wetGain.gain.value; },
      set value(v: number) {
        self._wetGain.gain.value = v;
        self._dryGain.gain.value = 1 - v;
      },
    };
  }

  get input(): Tone.ToneAudioNode {
    return this._inputNode;
  }

  connect(destination: Tone.ToneAudioNode): void {
    this._dryGain.connect(destination);
    this._wetGain.connect(destination);
  }

  setWow(amount: number): void {
    const cutoff = 20000 * Math.pow(1500 / 20000, amount);
    this._feedbackFilter.frequency.value = cutoff;
    this._feedbackDist.wet.value = amount * 0.6;
    this._feedbackDist.distortion = amount * 0.5;
    const dt = this._delayTimeSec;
    const wobble = amount * 0.022;
    this._lfo.min = Math.max(0.001, dt - wobble);
    this._lfo.max = dt + wobble;
    this._lfo.amplitude.value = amount > 0 ? 1 : 0;
  }

  dispose(): void {
    this._lfo.stop();
    this._lfo.dispose();
    this._inputNode.disconnect();
    this._inputNode.dispose();
    this._delay.disconnect();
    this._delay.dispose();
    this._dryGain.disconnect();
    this._dryGain.dispose();
    this._wetGain.disconnect();
    this._wetGain.dispose();
    this._feedbackGain.disconnect();
    this._feedbackGain.dispose();
    this._feedbackFilter.disconnect();
    this._feedbackFilter.dispose();
    this._feedbackDist.disconnect();
    this._feedbackDist.dispose();
  }
}
