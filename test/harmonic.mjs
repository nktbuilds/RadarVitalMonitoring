import { VitalProcessor } from '../source/js/dsp/vitals.js';

const fs = 20;
const numPoints = 15;
const targetBin = 9;
const breathF = 0.3;      // 18 rpm
const heartF = 1.35;      // 81 bpm

async function run({ withHarmonics, dropFactor = 1, seconds = 40 }) {
  const proc = new VitalProcessor({ updateRate: fs / dropFactor, bufferSeconds: 40, heartMinSeconds: 15 });
  const frames = seconds * fs;
  let last = null;
  for (let n = 0; n < frames; n++) {
    if (n % dropFactor !== 0) continue;
    const t = n / fs;
    let phase = 1.5 * Math.sin(2 * Math.PI * breathF * t);
    if (withHarmonics) {
      phase += 0.5 * Math.sin(2 * Math.PI * 2 * breathF * t)
             + 0.35 * Math.sin(2 * Math.PI * 3 * breathF * t)
             + 0.25 * Math.sin(2 * Math.PI * 4 * breathF * t)
             + 0.15 * Math.sin(2 * Math.PI * 5 * breathF * t)
             + 0.10 * Math.sin(2 * Math.PI * 6 * breathF * t);
    }
    phase += 0.08 * Math.sin(2 * Math.PI * heartF * t);
    const amplitudes = new Array(numPoints).fill(500);
    amplitudes[targetBin] = 8000;
    const phases = new Array(numPoints).fill(0);
    phases[targetBin] = phase;
    last = await proc.process({ amplitudes, phases });
  }
  return last;
}

const h = await run({ withHarmonics: true });
console.log('harmonics    -> breath', h.breathingRateRpm.toFixed(1), 'rpm | heart', h.heartRateBpm.toFixed(1), 'bpm (expect ~81)');
const p = await run({ withHarmonics: false });
console.log('clean        -> breath', p.breathingRateRpm.toFixed(1), 'rpm | heart', p.heartRateBpm.toFixed(1), 'bpm (expect ~81)');
const d = await run({ withHarmonics: true, dropFactor: 2 });
console.log('dropped x2   -> breath', d.breathingRateRpm.toFixed(1), 'rpm | heart', d.heartRateBpm.toFixed(1), 'bpm (expect ~81)');
