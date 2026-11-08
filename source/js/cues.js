// Time-based hysteresis for UI cues.
//
// A cue state only changes once the target has differed from the current state
// for `delayMs`. Brief blips (e.g. a single frame where the heart peak lands on
// a breathing harmonic) do not flip the cue, so indicators do not flicker.

export const CUE_DELAY_MS = 2000;

export class Hysteresis {
  constructor(initial = 'ok', delayMs = CUE_DELAY_MS) {
    this.value = initial;
    this.delayMs = delayMs;
    this._since = null;
  }

  update(target, now) {
    if (target === this.value) {
      this._since = null;
      return this.value;
    }
    if (this._since === null) {
      this._since = now;
      return this.value;
    }
    if (now - this._since >= this.delayMs) {
      this.value = target;
      this._since = null;
    }
    return this.value;
  }

  reset(value = 'ok') {
    this.value = value;
    this._since = null;
  }
}
