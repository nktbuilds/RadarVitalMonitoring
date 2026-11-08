import { VitalProcessor } from '../source/js/dsp/vitals.js';

// Irregular breathing: the rate slowly wobbles (FM) and the amplitude varies,
// which spreads the breathing spectral peak and used to blank the readouts.
const fs = 20;
const numPoints = 15;
const targetBin = 9;
const heartF = 1.35; // 81 bpm

async function run({ seconds = 45, jitter = 0.06, seed = 1 } = {}) {
  const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 40, heartMinSeconds: 15 });
  const frames = seconds * fs;

  let breathPhase = 0;
  let rng = seed;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) % 4294967296;
    return rng / 4294967296 - 0.5;
  };

  let hrNaN = 0;
  let rrNaN = 0;
  let hrStale = 0;
  let rrStale = 0;
  let counted = 0;
  let last = null;
  let hrSeen = false;
  let rrSeen = false;
  const hrBlankTimes = [];

  for (let n = 0; n < frames; n++) {
    const t = n / fs;
    const dt = 1 / fs;
    // Breathing rate wobbles around 0.3 Hz (18 rpm) plus per-breath randomness.
    const breathF = 0.3 + jitter * Math.sin(2 * Math.PI * 0.02 * t) + 0.03 * rand();
    breathPhase += 2 * Math.PI * breathF * dt;
    const breathAmp = 1.5 * (1 + 0.35 * Math.sin(2 * Math.PI * 0.05 * t));

    const phase = breathAmp * Math.sin(breathPhase) + 0.08 * Math.sin(2 * Math.PI * heartF * t);

    const amplitudes = new Array(numPoints).fill(500);
    amplitudes[targetBin] = 8000;
    const phases = new Array(numPoints).fill(0);
    phases[targetBin] = phase;
    last = await proc.process({ amplitudes, phases });

    if (t >= 15) {
      counted++;
      if (Number.isFinite(last.heartRateBpm)) hrSeen = true;
      if (Number.isFinite(last.breathingRateRpm)) rrSeen = true;
      // Blanking only counts as a failure once a valid estimate has appeared;
      // the first frames after the analysis window fills have empty history.
      if (hrSeen && !Number.isFinite(last.heartRateBpm)) hrNaN++;
      if (rrSeen && !Number.isFinite(last.breathingRateRpm)) rrNaN++;
      if (last.heartStale) hrStale++;
      if (last.breathingStale) rrStale++;
      if (hrSeen && !Number.isFinite(last.heartRateBpm)) hrBlankTimes.push(+t.toFixed(2));
    }
  }

  return { last, counted, hrNaN, rrNaN, hrStale, rrStale, hrBlankTimes };
}

const r = await run();
console.log(
  `irregular FM -> breath ${r.last.breathingRateRpm.toFixed(1)} rpm (expect ~18) | ` +
    `heart ${r.last.heartRateBpm.toFixed(1)} bpm (expect ~81)`,
);
console.log(
  `frames>=15s: ${r.counted} | heart blanked ${r.hrNaN} (stale ${r.hrStale}) | ` +
    `breath blanked ${r.rrNaN} (stale ${r.rrStale})`,
);
console.log(`heart blank times: ${r.hrBlankTimes.slice(0, 40).join(', ')}`);

// --- Direct Stabilizer unit checks (deterministic) -------------------------
import { Stabilizer } from '../source/js/dsp/stabilizer.js';

// 1) A single noisy frame must not gate the readout (confidence EMA).
const s1 = new Stabilizer({ window: 5, minConfidence: 0.03, confAlpha: 0.3 });
for (let i = 0; i < 5; i++) s1.push(80 + i * 0.1, 0.9);
const oneNoisy = s1.push(81, 0.0);
const emaOk = Number.isFinite(oneNoisy.value) && !oneNoisy.stale;

// 2) Once locked, sustained low confidence holds the value forever (stale),
//    and never blanks until an explicit reset.
const s2 = new Stabilizer({ window: 5, minConfidence: 0.03, confAlpha: 0.3 });
for (let i = 0; i < 5; i++) s2.push(80, 0.9);
let held = 0;
let blanked = 0;
for (let i = 0; i < 100; i++) {
  const o = s2.push(NaN, 0.0);
  if (o.stale) held++;
  if (!Number.isFinite(o.value)) blanked++;
}
const holdOk = held === 100 && blanked === 0;
s2.reset();
const afterReset = s2.push(NaN, 0.9);
const resetOk = !Number.isFinite(afterReset.value);
console.log(
  `stabilizer: single-noisy-frame held=${emaOk} | sustained held ${held} blanked ${blanked} | reset blanks=${resetOk}`,
);

// --- Full-pipeline subject loss: blanks only after the target collapses ----
const procLoss = new VitalProcessor({ updateRate: fs, bufferSeconds: 30 });
let beforeLossNaN = 0;
let afterLossNaN = 0;
let lastLoss = null;
for (let n = 0; n < 35 * fs; n++) {
  const t = n / fs;
  const alive = t < 25;
  const phase = alive ? 1.5 * Math.sin(2 * Math.PI * 0.3 * t) + 0.08 * Math.sin(2 * Math.PI * heartF * t) : 0;
  const amplitudes = new Array(numPoints).fill(500);
  amplitudes[targetBin] = alive ? 8000 : 50; // target collapses
  const phases = new Array(numPoints).fill(0);
  phases[targetBin] = phase;
  lastLoss = await procLoss.process({ amplitudes, phases });
  if (t >= 15 && t < 25 && !Number.isFinite(lastLoss.heartRateBpm)) beforeLossNaN++;
  if (t >= 27 && !Number.isFinite(lastLoss.heartRateBpm)) afterLossNaN++;
}
const lossOk = beforeLossNaN === 0 && afterLossNaN > 0;
console.log(
  `subject loss: blanked before=${beforeLossNaN} (want 0), after=${afterLossNaN} (want >0), ` +
    `final=${Number.isFinite(lastLoss.heartRateBpm) ? lastLoss.heartRateBpm.toFixed(1) : '--'}`,
);

const ok =
  r.hrNaN === 0 &&
  r.rrNaN === 0 &&
  Math.abs(r.last.breathingRateRpm - 18) < 4 &&
  Math.abs(r.last.heartRateBpm - 81) < 12 &&
  emaOk &&
  holdOk &&
  resetOk &&
  lossOk;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
