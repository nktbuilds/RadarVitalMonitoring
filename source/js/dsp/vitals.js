// Vital-sign DSP pipeline.
//
// Consumes per-frame amplitude/phase arrays (one entry per distance bin) and
// maintains the time series needed to estimate breathing and heart rates.
//
// Pipeline per frame:
//   1. Select the target bin (highest amplitude) = the chest.
//   2. Extract and unwrap the phase at that bin.
//   3. Stream the phase through stateful filters (no per-frame reset):
//        breathing band-pass            -> breathing waveform / rate
//        low-band breathing estimate    -> subtracted from the phase
//        heart band-pass on the residual-> heart waveform / rate
//   4. Estimate rates via FFT; suppress breathing harmonics in the heart band.
//   5. Stabilize (median) and gate on confidence.

import { butterBandpass } from './filters.js';
import { spectralRate } from './rate.js';
import { Stabilizer } from './stabilizer.js';

const TWO_PI = 2 * Math.PI;

export const BREATH_BAND = { fmin: 0.2, fmax: 0.5 }; // 12 - 30 rpm
export const HEART_BAND = { fmin: 0.8, fmax: 2.5 }; // 48 - 150 bpm

// Frequencies within this tolerance of a breathing harmonic are suppressed.
const HARMONIC_TOLERANCE = 0.08;
const HARMONIC_WEIGHT = 0.1;
// The comb mask is only trustworthy when the breathing peak is reasonably
// distinct; below this prominence we skip masking rather than risk suppressing
// the real heart peak on the strength of a noisy breathing estimate.
const MASK_MIN_PROMINENCE = 0.5;
// EMA factor for the breathing frequency that drives the harmonic mask.
const BREATH_FREQ_ALPHA = 0.2;
// Resting heart rate is typically a few times the breathing rate. Peaks whose
// HR/BR ratio is far from that are down-weighted (softly) and flagged.
const RATIO_CENTER = 4;
const RATIO_LOG_SIGMA = 0.5;
const RATIO_MIN_WEIGHT = 0.05;

// Subject-loss detection: the target amplitude must fall to this fraction of its
// healthy running average for this many frames before we declare the subject
// gone (and only then blank the readout).
const LOSS_AMP_RATIO = 0.3;
const LOSS_SECONDS = 2;
// Smoothing factor for the healthy-amplitude reference.
const AMP_EMA_ALPHA = 0.05;

export class VitalProcessor {
  constructor({
    updateRate = 20,
    bufferSeconds = 30,
    breathMinSeconds = 6,
    heartMinSeconds = 8,
    targetHold = 20,
  } = {}) {
    this.bufferSeconds = bufferSeconds;
    this.breathMinSeconds = breathMinSeconds;
    this.heartMinSeconds = heartMinSeconds;
    this.targetHold = targetHold;

    this._breathStab = new Stabilizer({ window: 5, minConfidence: 0.03 });
    this._heartStab = new Stabilizer({ window: 5, minConfidence: 0.03 });

    this._design(updateRate);
    this.reset();
  }

  _design(fs) {
    this.fs = fs;
    this.maxLen = Math.max(32, Math.round(this.bufferSeconds * fs));
    this.breathMinSamples = Math.max(16, Math.round(this.breathMinSeconds * fs));
    this.heartMinSamples = Math.max(32, Math.round(this.heartMinSeconds * fs));
    this._warmup = Math.round(fs); // discard 1 s of filter startup from plots

    this._breathFilter = butterBandpass(fs, BREATH_BAND.fmin, BREATH_BAND.fmax, 2);
    this._breathEstimate = butterBandpass(fs, 0.1, 0.6, 2);
    this._heartFilter = butterBandpass(fs, HEART_BAND.fmin, HEART_BAND.fmax, 2);
  }

  setSampleRate(fs) {
    if (!Number.isFinite(fs) || fs <= 0) return;
    if (Math.abs(fs - this.fs) / this.fs < 0.02) return;
    this._design(fs);
    // Recompute filters, but keep the stabilizers so the readout holds through
    // a small rate correction.
    this._resetSignal({ keepStabilizers: true });
  }

  reset() {
    this.targetBin = null;
    this._targetAge = 0;
    this._ampEma = NaN;
    this._lossCount = 0;
    this._rebasePhase = false;
    this.switches = 0;
    this._events = [];
    this._resetSignal();
  }

  _resetSignal({ keepStabilizers = false } = {}) {
    this._prevRawPhase = null;
    this._unwrapped = 0;
    this._samples = 0;
    this.phase = [];
    this.breathing = [];
    this.heart = [];
    this._breathFilter.reset();
    this._breathEstimate.reset();
    this._heartFilter.reset();
    this._breathFreqEma = NaN;
    if (!keepStabilizers) {
      this._breathStab.reset();
      this._heartStab.reset();
    }
  }

  _selectTarget(amplitudes) {
    let best = 0;
    for (let i = 1; i < amplitudes.length; i++) {
      if (amplitudes[i] > amplitudes[best]) best = i;
    }

    if (this.targetBin === null) {
      this.targetBin = best;
      this._targetAge = 0;
      return;
    }

    // Only switch target if the current bin has faded and another is clearly
    // stronger. We do NOT clear the signal buffers: the breathing/heart
    // modulation is the same on the neighbouring bin, and clearing would reset
    // the (8 s) heart window every time the chest drifts. We only rebase the
    // phase unwrap so the bin change does not inject a step.
    const current = amplitudes[this.targetBin] ?? 0;
    this._targetAge++;
    if (this._targetAge > this.targetHold && amplitudes[best] > current * 1.5) {
      this._events.push({ type: 'switch', from: this.targetBin, to: best, fromAmp: current, toAmp: amplitudes[best] });
      this.targetBin = best;
      this._targetAge = 0;
      this.switches++;
      this._rebasePhase = true;
    }
  }

  // Detect a genuine subject loss: the target bin's amplitude collapsing well
  // below its healthy running average for a sustained period. Returns true when
  // the subject should be considered gone.
  _detectLoss(amplitude) {
    if (!Number.isFinite(this._ampEma)) {
      this._ampEma = amplitude;
      this._lossCount = 0;
      return false;
    }
    if (amplitude < this._ampEma * LOSS_AMP_RATIO) {
      this._lossCount++;
      if (this._lossCount >= Math.round(LOSS_SECONDS * this.fs)) return true;
    } else {
      this._lossCount = 0;
      this._ampEma = AMP_EMA_ALPHA * amplitude + (1 - AMP_EMA_ALPHA) * this._ampEma;
    }
    return false;
  }

  async process({ amplitudes, phases }) {
    this._selectTarget(amplitudes);
    const targetBin = this.targetBin;
    const targetAmp = amplitudes[targetBin] ?? 0;

    if (this._detectLoss(targetAmp)) {
      this._events.push({ type: 'lost', bin: targetBin, amp: targetAmp });
      this.targetBin = null;
      this._targetAge = 0;
      this._ampEma = NaN;
      this._lossCount = 0;
      this._resetSignal();
    }

    const raw = phases[targetBin];
    if (this._rebasePhase) {
      // Target bin changed: adopt the new phase reference without moving the
      // unwrapped series, so no artificial step enters the filters.
      this._rebasePhase = false;
    } else if (this._prevRawPhase === null) {
      this._unwrapped = raw;
    } else {
      let delta = raw - this._prevRawPhase;
      if (delta > Math.PI) delta -= TWO_PI;
      else if (delta < -Math.PI) delta += TWO_PI;
      this._unwrapped += delta;
    }
    this._prevRawPhase = raw;

    this.phase.push(this._unwrapped);
    if (this.phase.length > this.maxLen) this.phase.shift();

    // Streaming filters: one new sample each, state carried across frames.
    const breathingSample = this._breathFilter.process(this._unwrapped);
    const breathingEstimate = this._breathEstimate.process(this._unwrapped);
    const residual = this._unwrapped - breathingEstimate;
    const heartSample = this._heartFilter.process(residual);

    this._samples++;
    if (this._samples > this._warmup) {
      this.breathing.push(breathingSample);
      if (this.breathing.length > this.maxLen) this.breathing.shift();
      this.heart.push(heartSample);
      if (this.heart.length > this.maxLen) this.heart.shift();
    }

    const result = {
      targetBin: this.targetBin,
      amplitudes,
      phase: this.phase.slice(),
      breathing: this.breathing.slice(),
      heart: this.heart.slice(),
      heartRateBpm: NaN,
      breathingRateRpm: NaN,
      heartConfidence: 0,
      breathingConfidence: 0,
      heartStale: false,
      breathingStale: false,
      heartHarmonic: false,
      samples: this.phase.length,
      switches: this.switches,
      events: this._events,
    };
    this._events = [];

    let breathSpec = null;
    if (this.breathing.length >= this.breathMinSamples) {
      breathSpec = await spectralRate(
        this.breathing,
        this.fs,
        BREATH_BAND.fmin,
        BREATH_BAND.fmax,
      );
    }

    // Smooth the breathing frequency that drives the harmonic mask, and only
    // trust it while the breathing peak is reasonably distinct. This stops a
    // jittery estimate (irregular breathing) from moving the comb onto the
    // real heart peak.
    if (breathSpec && Number.isFinite(breathSpec.freq) && breathSpec.prominence >= MASK_MIN_PROMINENCE) {
      this._breathFreqEma = Number.isFinite(this._breathFreqEma)
        ? BREATH_FREQ_ALPHA * breathSpec.freq + (1 - BREATH_FREQ_ALPHA) * this._breathFreqEma
        : breathSpec.freq;
    }

    let heartSpec = null;
    if (this.heart.length >= this.heartMinSamples) {
      const fb = this._breathFreqEma;
      const weight = Number.isFinite(fb)
        ? (f) => harmonicWeight(f, fb) * ratioWeight(f, fb)
        : null;
      heartSpec = await spectralRate(
        this.heart,
        this.fs,
        HEART_BAND.fmin,
        HEART_BAND.fmax,
        weight,
      );
    }

    const breathConf = breathSpec ? prominenceConfidence(breathSpec.prominence) : 0;
    const heartConf = heartSpec ? prominenceConfidence(heartSpec.prominence) : 0;

    const breathOut = this._breathStab.push(breathSpec ? breathSpec.ratePerMin : NaN, breathConf);
    const heartOut = this._heartStab.push(heartSpec ? heartSpec.ratePerMin : NaN, heartConf);

    result.breathingRateRpm = breathOut.value;
    result.heartRateBpm = heartOut.value;
    result.breathingConfidence = breathOut.confidence;
    result.heartConfidence = heartOut.confidence;
    result.breathingStale = breathOut.stale;
    result.heartStale = heartOut.stale;
    result.heartHarmonic = heartSpec && Number.isFinite(heartSpec.freq)
      ? harmonicRisk(heartSpec.freq, this._breathFreqEma)
      : false;

    return result;
  }
}

// Down-weight frequencies sitting on any breathing harmonic inside the heart
// band (k = 2 .. top-of-band / breathing frequency). The chest-motion harmonics
// are what produce spurious rates like 120 bpm when breathing at 15 rpm (k=8).
function harmonicWeight(freq, breathingFreq) {
  if (!Number.isFinite(breathingFreq) || breathingFreq <= 0) return 1;
  const kMax = Math.ceil(HEART_BAND.fmax / breathingFreq);
  for (let k = 2; k <= kMax; k++) {
    if (Math.abs(freq - k * breathingFreq) <= HARMONIC_TOLERANCE) return HARMONIC_WEIGHT;
  }
  return 1;
}

// Soft plausibility prior on the heart-to-breathing ratio (log-normal around
// RATIO_CENTER). Peaks at extreme ratios are down-weighted, never removed.
function ratioWeight(freq, breathingFreq) {
  if (!Number.isFinite(breathingFreq) || breathingFreq <= 0) return 1;
  const ratio = freq / breathingFreq;
  const z = Math.log(ratio / RATIO_CENTER) / RATIO_LOG_SIGMA;
  return Math.max(RATIO_MIN_WEIGHT, Math.exp(-0.5 * z * z));
}

// True when a heart peak is (a) sitting on a breathing harmonic or (b) at an
// implausible HR/BR ratio — i.e. it may be a harmonic rather than a heartbeat.
function harmonicRisk(freq, breathingFreq) {
  if (!Number.isFinite(breathingFreq) || breathingFreq <= 0) return false;
  const kMax = Math.ceil(HEART_BAND.fmax / breathingFreq);
  for (let k = 2; k <= kMax; k++) {
    if (Math.abs(freq - k * breathingFreq) <= HARMONIC_TOLERANCE) return true;
  }
  return ratioWeight(freq, breathingFreq) < 0.2;
}

function prominenceConfidence(prominence) {
  if (!Number.isFinite(prominence) || prominence <= 0) return 0;
  // A prominence of ~4x the in-band mean is treated as a confident detection.
  return Math.max(0, Math.min(1, prominence / 4));
}
