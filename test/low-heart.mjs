import { VitalProcessor } from '../source/js/dsp/vitals.js';

// The heart band now starts at 0.8 Hz = 48 bpm. Check that a low (bradycardic)
// heart rate is detected, both when it is clear of breathing harmonics and when
// it sits exactly on one (where it should still show but be flagged).
const fs = 20;
const numPoints = 15;
const targetBin = 9;

async function run({ breathF, heartF, heartAmp, harmonicScale = 1, seconds = 45 }) {
  const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 40 });
  const h = [0, 0, 0.3, 0.25, 0.2, 0.15].map((a) => a * harmonicScale);
  let last = null;
  for (let n = 0; n < seconds * fs; n++) {
    const t = n / fs;
    let phase = 1.5 * Math.sin(2 * Math.PI * breathF * t);
    for (let k = 2; k <= 5; k++) phase += h[k] * Math.sin(2 * Math.PI * k * breathF * t);
    phase += heartAmp * Math.sin(2 * Math.PI * heartF * t);
    const amplitudes = new Array(numPoints).fill(500);
    amplitudes[targetBin] = 8000;
    const phases = new Array(numPoints).fill(0);
    phases[targetBin] = phase;
    last = await proc.process({ amplitudes, phases });
  }
  return last;
}

// 18 rpm breathing: 0.8 Hz (48 bpm) is clear of all breathing harmonics.
const a = await run({ breathF: 0.3, heartF: 0.8, heartAmp: 0.3 });
console.log(
  `48 bpm clear    -> breath ${a.breathingRateRpm.toFixed(1)} rpm | ` +
    `heart ${a.heartRateBpm.toFixed(1)} bpm (expect ~48) | harmonic=${a.heartHarmonic}`,
);

// 12 rpm breathing: 0.8 Hz is exactly the 4th harmonic -> still detected, flagged.
const b = await run({ breathF: 0.2, heartF: 0.8, heartAmp: 0.5, harmonicScale: 0.1 });
console.log(
  `48 bpm harmonic -> breath ${b.breathingRateRpm.toFixed(1)} rpm | ` +
    `heart ${b.heartRateBpm.toFixed(1)} bpm (expect ~48) | harmonic=${b.heartHarmonic}`,
);

const ok =
  Math.abs(a.heartRateBpm - 48) < 8 &&
  a.heartHarmonic === false &&
  Math.abs(b.heartRateBpm - 48) < 10 &&
  b.heartHarmonic === true;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
