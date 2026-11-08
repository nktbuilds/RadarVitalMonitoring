// FFT wrapper.
//
// Primary implementation is the fft.js library loaded from a CDN. A small
// self-contained radix-2 fallback with the same API is used if the CDN is
// unavailable, so the DSP pipeline never hard-fails.

const FFT_CDN = 'https://cdn.jsdelivr.net/npm/fft.js@4.0.4/+esm';

class FallbackFFT {
  constructor(size) {
    this.size = size;
  }

  createComplexArray() {
    return new Float64Array(this.size * 2);
  }

  realTransform(out, data) {
    const n = this.size;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = data[i] || 0;

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    // Iterative Cooley-Tukey.
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1;
        let curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe;
          im[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      out[2 * i] = re[i];
      out[2 * i + 1] = im[i];
    }
  }
}

let FFTImpl = null;

export async function loadFFT() {
  if (FFTImpl) return FFTImpl;
  try {
    const mod = await import(/* @vite-ignore */ FFT_CDN);
    FFTImpl = mod.default || mod.FFT || FallbackFFT;
  } catch {
    FFTImpl = FallbackFFT;
  }
  return FFTImpl;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

// Compute a single-sided magnitude spectrum of `signal` sampled at `fs` Hz.
// The signal is Hann-windowed and zero-padded for a smooth, high-resolution peak.
export async function magnitudeSpectrum(signal, fs, minNfft = 4096) {
  const FFT = await loadFFT();
  const n = signal.length;
  const nfft = Math.max(minNfft, nextPow2(n));
  const win = hannWindow(n);

  const input = new Float64Array(nfft);
  for (let i = 0; i < n; i++) input[i] = signal[i] * win[i];

  const fft = new FFT(nfft);
  const out = fft.createComplexArray();
  fft.realTransform(out, input);

  const bins = nfft / 2;
  const mags = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const re = out[2 * k];
    const im = out[2 * k + 1];
    mags[k] = Math.hypot(re, im);
  }

  return { mags, nfft, df: fs / nfft, bins };
}

// Find the dominant frequency within [fmin, fmax] using parabolic interpolation.
// An optional `weight(freq)` function scales each bin's score, allowing callers
// to suppress bins (e.g. breathing harmonics).
export function peakFrequency(spectrum, fmin, fmax, weight = null) {
  const { mags, df } = spectrum;
  const kMin = Math.max(1, Math.ceil(fmin / df));
  const kMax = Math.min(mags.length - 2, Math.floor(fmax / df));
  if (kMax <= kMin) return { freq: NaN, magnitude: 0 };

  let peak = kMin;
  let bestScore = -Infinity;
  for (let k = kMin; k <= kMax; k++) {
    const score = weight ? mags[k] * weight(k * df) : mags[k];
    if (score > bestScore) {
      bestScore = score;
      peak = k;
    }
  }

  const a = mags[peak - 1];
  const b = mags[peak];
  const c = mags[peak + 1];
  const denom = a - 2 * b + c;
  let delta = 0;
  if (Math.abs(denom) > 1e-12) delta = (0.5 * (a - c)) / denom;
  if (delta > 0.5) delta = 0.5;
  if (delta < -0.5) delta = -0.5;

  return { freq: (peak + delta) * df, magnitude: b };
}
