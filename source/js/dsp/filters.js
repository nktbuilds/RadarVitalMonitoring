// Biquad filters for the vital-sign DSP pipeline.
//
// Filters are *streaming* and *stateful*: each filter keeps its Direct-Form-I
// state across calls, so it can process one new sample per frame without the
// startup transient that appears when a whole buffer is re-filtered from zero.
//
// Butterworth low/high/band-pass are built from RBJ cookbook biquad sections.

export class Biquad {
  constructor({ b0, b1, b2, a1, a2 }) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    this.reset();
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const y =
      this.b0 * x +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// A cascade of biquad sections processed in series.
export class FilterChain {
  constructor(stages = []) {
    this.stages = stages;
  }

  reset() {
    for (const stage of this.stages) stage.reset();
  }

  process(x) {
    let y = x;
    for (const stage of this.stages) y = stage.process(y);
    return y;
  }
}

// Butterworth Q values for an even-order prototype (order / 2 sections).
function butterworthQs(order) {
  const sections = order / 2;
  const qs = [];
  for (let k = 0; k < sections; k++) {
    qs.push(1 / (2 * Math.sin(((2 * k + 1) * Math.PI) / (2 * order))));
  }
  return qs;
}

function lowpassBiquad(fs, fc, q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const b0 = (1 - cosW0) / 2;
  const b1 = 1 - cosW0;
  const b2 = (1 - cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return new Biquad({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
}

function highpassBiquad(fs, fc, q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return new Biquad({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
}

// Butterworth low-pass of the given (even) order.
export function butterLowpass(fs, fc, order = 2) {
  return new FilterChain(butterworthQs(order).map((q) => lowpassBiquad(fs, fc, q)));
}

// Butterworth high-pass of the given (even) order.
export function butterHighpass(fs, fc, order = 2) {
  return new FilterChain(butterworthQs(order).map((q) => highpassBiquad(fs, fc, q)));
}

// Butterworth band-pass formed by cascading a high-pass at f1 and a low-pass at
// f2. `order` is the order of each half (must be even); total order = 2*order.
export function butterBandpass(fs, f1, f2, order = 2) {
  const stages = [
    ...butterHighpass(fs, f1, order).stages,
    ...butterLowpass(fs, f2, order).stages,
  ];
  return new FilterChain(stages);
}
