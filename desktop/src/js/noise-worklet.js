'use strict';
/**
 * noise-worklet.js — AudioWorklet: Spectral Subtraction Noise Canceller (~25 dB)
 * Algorithm: Modified Berouti spectral subtraction + noise gate
 * FFT size: 512 | Hop: 128 (75% overlap) | Latency: ~10ms at 48kHz
 */
class NoiseSuppressor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N   = 512;
    this.hop = 128;  // 75% overlap — run FFT every 128 samples
    this.M   = this.N >> 1;

    // Sliding input frame
    this.frame = new Float32Array(this.N);

    // Overlap-add output buffer
    this.ola = new Float32Array(this.N + this.hop);

    // Hann window
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++)
      this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N);

    // Noise spectrum estimate
    this.noisePow  = new Float32Array(this.M + 1).fill(1e-10);
    this.smoothPow = new Float32Array(this.M + 1).fill(1e-10);

    // Calibration (first ~0.5 s)
    this.calibAccum   = new Float32Array(this.M + 1).fill(0);
    this.calibFrames  = 0;
    this.calibTarget  = 120; // ~120 hops × 128/48000 ≈ 0.32 s
    this.isCalibrated = false;

    // FFT workspace
    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);
    this._buildTables(this.N);

    // Gate state
    this.gateGain = 1.0;

    this.port.onmessage = ({ data }) => {
      if (data === 'recalibrate') {
        this.calibFrames = 0;
        this.calibAccum.fill(0);
        this.isCalibrated = false;
      }
    };
  }

  _buildTables(N) {
    const LOG2N = Math.round(Math.log2(N));
    this.bitrev = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      let rev = 0, x = i;
      for (let b = 0; b < LOG2N; b++) { rev = (rev << 1) | (x & 1); x >>= 1; }
      this.bitrev[i] = rev;
    }
    const nh = N >> 1;
    this.twRe = new Float32Array(nh);
    this.twIm = new Float32Array(nh);
    for (let i = 0; i < nh; i++) {
      const a = -2 * Math.PI * i / N;
      this.twRe[i] = Math.cos(a);
      this.twIm[i] = Math.sin(a);
    }
  }

  _fft(re, im) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      const j = this.bitrev[i];
      if (i < j) { let t = re[i]; re[i]=re[j]; re[j]=t; t=im[i]; im[i]=im[j]; im[j]=t; }
    }
    let step = N >> 1;
    for (let size = 2; size <= N; size <<= 1, step >>= 1) {
      const half = size >> 1;
      for (let s = 0; s < N; s += size) {
        for (let k = 0; k < half; k++) {
          const p = s + k, q = p + half;
          const wr = this.twRe[k * step], wi = this.twIm[k * step];
          const tr = re[q]*wr - im[q]*wi, ti = re[q]*wi + im[q]*wr;
          re[q] = re[p]-tr; im[q] = im[p]-ti;
          re[p] += tr;      im[p] += ti;
        }
      }
    }
  }

  _ifft(re, im) {
    const N = this.N;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this._fft(re, im);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
  }

  _processFrame() {
    const N = this.N, M = this.M;
    const re = this.fftRe, im = this.fftIm;

    // Windowed analysis
    for (let i = 0; i < N; i++) { re[i] = this.frame[i] * this.win[i]; im[i] = 0; }
    this._fft(re, im);

    // Power spectrum
    const pow = new Float32Array(M + 1);
    for (let i = 0; i <= M; i++) pow[i] = re[i]*re[i] + im[i]*im[i];

    // Temporal smoothing
    for (let i = 0; i <= M; i++)
      this.smoothPow[i] = 0.7 * this.smoothPow[i] + 0.3 * pow[i];

    // === Calibration phase ===
    if (!this.isCalibrated) {
      for (let i = 0; i <= M; i++) this.calibAccum[i] += this.smoothPow[i];
      if (++this.calibFrames >= this.calibTarget) {
        for (let i = 0; i <= M; i++)
          this.noisePow[i] = this.calibAccum[i] / this.calibTarget;
        this.isCalibrated = true;
        this.port.postMessage({ type: 'calibrated' });
      }
      // Pass through during calibration
      this._fft(re, im); // already computed, just IFFT
      this._addOLA(re);
      return;
    }

    // === Adaptive noise floor tracking ===
    for (let i = 0; i <= M; i++) {
      const r = this.smoothPow[i] / (this.noisePow[i] + 1e-20);
      // If looks quiet (close to noise), update faster; if speech, very slow
      const lr = r < 2.0 ? 0.04 : 0.001;
      this.noisePow[i] = (1 - lr) * this.noisePow[i] + lr * this.smoothPow[i];
    }

    // === Modified Berouti Spectral Subtraction (~25 dB) ===
    // G(k) = max(FLOOR, sqrt(max(0, 1 - OVERSUB * noisePow/sigPow)))
    // Target: reduce noise amplitude by 10^(25/20) ≈ 17.8× → FLOOR = 1/17.8 ≈ 0.056
    const FLOOR   = 0.056;  // –25 dB floor
    const OVERSUB = 3.5;    // over-subtraction (compensates for estimation error)

    for (let i = 0; i <= M; i++) {
      const g2 = 1 - OVERSUB * this.noisePow[i] / (pow[i] + 1e-20);
      const gain = g2 > FLOOR * FLOOR ? Math.sqrt(g2) : FLOOR;
      re[i] *= gain;
      im[i] *= gain;
    }

    // Mirror negative frequencies
    for (let i = M + 1; i < N; i++) { re[i] = re[N-i]; im[i] = -im[N-i]; }

    // IFFT
    this._ifft(re, im);
    this._addOLA(re);
  }

  _addOLA(re) {
    // Weighted overlap-add (synthesis Hann) + normalization for 75% overlap
    // 75% overlap: 4 frames per output sample → normalization ≈ 4 × 0.375 = 1.5
    const scale = 2.67 / this.N;  // tuned: 2/(N × 0.75)
    for (let i = 0; i < this.N; i++)
      this.ola[i] += re[i] * this.win[i] * scale;
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    const BLOCK = inp.length; // 128

    // === Noise gate ===
    let ss = 0;
    for (let i = 0; i < BLOCK; i++) ss += inp[i] * inp[i];
    const rms = Math.sqrt(ss / BLOCK);
    this.gateGain = 0.92 * this.gateGain + 0.08 * (rms > 0.003 ? 1 : 0);

    // === Slide input frame ===
    this.frame.copyWithin(0, BLOCK);
    this.frame.set(inp, this.N - BLOCK);

    // === Run spectral suppression every hop=128 samples ===
    this._processFrame();

    // === Output first BLOCK samples from OLA ===
    for (let i = 0; i < BLOCK; i++)
      out[i] = this.ola[i] * this.gateGain;

    // Shift OLA by BLOCK
    this.ola.copyWithin(0, BLOCK);
    this.ola.fill(0, this.N);

    return true;
  }
}

registerProcessor('noise-suppressor', NoiseSuppressor);
