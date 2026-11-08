// Rate estimation from a filtered physiological waveform.
//
// The primary estimator is the dominant frequency in the FFT spectrum.
// A peak-counting estimator runs alongside as a cross-check / confidence signal.

import { magnitudeSpectrum, peakFrequency } from './fft.js';

export async function spectralRate(signal, fs, fmin, fmax, weight = null) {
  const spectrum = await magnitudeSpectrum(signal, fs);
  const { freq, magnitude } = peakFrequency(spectrum, fmin, fmax, weight);
  if (!Number.isFinite(freq)) return { ratePerMin: NaN, freq: NaN, magnitude: 0, prominence: 0 };

  // Prominence = peak height relative to the mean magnitude inside the band.
  const { mags, df } = spectrum;
  const kMin = Math.max(1, Math.ceil(fmin / df));
  const kMax = Math.min(mags.length - 1, Math.floor(fmax / df));
  let sum = 0;
  let count = 0;
  for (let k = kMin; k <= kMax; k++) {
    sum += mags[k];
    count++;
  }
  const bandMean = count > 0 ? sum / count : 0;
  const prominence = bandMean > 0 ? magnitude / bandMean : 0;

  return { ratePerMin: freq * 60, freq, magnitude, prominence };
}

// Count peaks separated by at least one period of `fmax`, return rate in /min.
export function peakRate(signal, fs, fmin, fmax) {
  const n = signal.length;
  if (n < 3) return { ratePerMin: NaN, peaks: 0 };

  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    if (signal[i] > max) max = signal[i];
    if (signal[i] < min) min = signal[i];
  }
  const threshold = min + 0.5 * (max - min);
  const minDistance = Math.max(1, Math.floor(fs / fmax));

  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] >= signal[i + 1] && signal[i] > threshold) {
      if (peaks.length > 0 && i - peaks[peaks.length - 1] < minDistance) {
        if (signal[i] > signal[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      } else {
        peaks.push(i);
      }
    }
  }

  if (peaks.length < 2) return { ratePerMin: NaN, peaks: peaks.length };

  const periodS = (peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1) / fs;
  if (periodS <= 0) return { ratePerMin: NaN, peaks: peaks.length };
  return { ratePerMin: 60 / periodS, peaks: peaks.length };
}
