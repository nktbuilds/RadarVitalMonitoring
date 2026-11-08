// Temporal stabilizer for rate estimates.
//
// Reports the median of the last few valid estimates, which rejects single-frame
// spikes (e.g. a breathing harmonic briefly dominating the heart band).
//
// Once an estimate has been established the stabilizer HOLDS it indefinitely
// (flagged `stale` while confidence is low) rather than blanking, so irregular
// breathing does not make the readout flicker. It only returns NaN when it has
// no history at all — i.e. before the first lock, or after an explicit reset
// (subject lost / stream restarted).

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

export class Stabilizer {
  constructor({ window = 5, minConfidence = 0.03, confAlpha = 0.3 } = {}) {
    this.window = window;
    this.minConfidence = minConfidence;
    this.confAlpha = confAlpha;
    this.reset();
  }

  reset() {
    this.history = [];
    this._smoothedConf = 0;
  }

  push(value, confidence) {
    const conf = Number.isFinite(confidence) ? confidence : 0;
    // EMA of confidence so a single noisy frame cannot change the stale cue.
    this._smoothedConf = this._smoothedConf === 0
      ? conf
      : this.confAlpha * conf + (1 - this.confAlpha) * this._smoothedConf;

    if (Number.isFinite(value)) {
      this.history.push(value);
      if (this.history.length > this.window) this.history.shift();
    }

    if (this.history.length === 0) {
      return { value: NaN, confidence: this._smoothedConf, stable: false, stale: false };
    }

    const confident = this._smoothedConf >= this.minConfidence && Number.isFinite(value);
    return {
      value: median(this.history),
      confidence: this._smoothedConf,
      stable: this.history.length >= 3 && confident,
      stale: !confident,
    };
  }
}
