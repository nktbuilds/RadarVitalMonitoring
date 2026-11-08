import { VitalProcessor } from '../source/js/dsp/vitals.js';

// Breathing at 15 rpm (0.25 Hz) puts its 8th harmonic at 2.0 Hz = 120 bpm.
// A strong harmonic artifact must not be reported as the heart rate when a real
// (smaller) heart peak exists at 66 bpm.
const fs = 20;
const numPoints = 15;
const targetBin = 9;
const breathF = 0.25; // 15 rpm

async function run({ heartF, heartAmp, eighthAmp, scale = 1, seconds = 45 }) {
  const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 40 });
  const h = [0, 0, 0.3, 0.25, 0.2, 0.15, 0.12, 0.1].map((a) => a * scale);
  let last = null;
  for (let n = 0; n < seconds * fs; n++) {
    const t = n / fs;
    let phase = 1.5 * Math.sin(2 * Math.PI * breathF * t);
    for (let k = 2; k <= 7; k++) phase += h[k] * Math.sin(2 * Math.PI * k * breathF * t);
    phase += eighthAmp * Math.sin(2 * Math.PI * 8 * breathF * t); // 120 bpm artifact
    phase += heartAmp * Math.sin(2 * Math.PI * heartF * t); // true heart
    const amplitudes = new Array(numPoints).fill(500);
    amplitudes[targetBin] = 8000;
    const phases = new Array(numPoints).fill(0);
    phases[targetBin] = phase;
    last = await proc.process({ amplitudes, phases });
  }
  return last;
}

// Real heart well clear of any harmonic: 66 bpm (ratio 4.4), with a large
// 120 bpm (8th-harmonic) artifact present.
const a = await run({ heartF: 1.1, heartAmp: 0.08, eighthAmp: 1.5 });
console.log(
  `8th-harmonic artifact -> breath ${a.breathingRateRpm.toFixed(1)} rpm | ` +
    `heart ${a.heartRateBpm.toFixed(1)} bpm (expect ~66, NOT 120) | harmonic=${a.heartHarmonic}`,
);

// Real heart sitting exactly on a harmonic: 90 bpm = 6 x 15 rpm, dominant over
// the weak breathing harmonics. Soft masking must still detect it, but flag it.
const b = await run({ heartF: 1.5, heartAmp: 0.5, eighthAmp: 0, scale: 0.15 });
console.log(
  `heart on harmonic      -> breath ${b.breathingRateRpm.toFixed(1)} rpm | ` +
    `heart ${b.heartRateBpm.toFixed(1)} bpm (expect ~90) | harmonic=${b.heartHarmonic}`,
);

const ok =
  Math.abs(a.heartRateBpm - 66) < 10 &&
  a.heartHarmonic === false &&
  Math.abs(b.heartRateBpm - 90) < 12 &&
  b.heartHarmonic === true;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
