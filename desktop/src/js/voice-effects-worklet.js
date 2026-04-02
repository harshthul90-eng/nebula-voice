/**
 * voice-effects-worklet.js — Real-time ring modulation AudioWorklet.
 * Registered as 'voice-ring-mod'.
 * Multiplies the signal by a sine carrier wave at a configurable frequency.
 */
class RingModProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.freq  = 50;  // carrier frequency in Hz
    this.mix   = 1.0; // 1.0 = full ring-mod, 0.0 = dry pass-through

    this.port.onmessage = ({ data }) => {
      if (data.freq !== undefined) this.freq = Math.max(1, Math.min(2000, data.freq));
      if (data.mix  !== undefined) this.mix  = Math.max(0, Math.min(1, data.mix));
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    const twoPi = 2 * Math.PI;
    const freq  = this.freq;
    const mix   = this.mix;

    for (let i = 0; i < inp.length; i++) {
      this.phase += twoPi * freq / sampleRate;
      if (this.phase >= twoPi) this.phase -= twoPi;
      const dry = inp[i];
      const wet = inp[i] * Math.sin(this.phase);
      out[i] = dry * (1 - mix) + wet * mix;
    }
    return true;
  }
}

registerProcessor('voice-ring-mod', RingModProcessor);
