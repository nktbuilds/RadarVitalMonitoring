import { VitalProcessor } from '../source/js/dsp/vitals.js';

// The strongest distance bin hops every few seconds (chest drifts as you
// breathe/move). A hop must NOT blank the readout: the stabilizer holds the
// last value while the signal quietly re-locks, and the switch is counted.
const fs = 20;
const numPoints = 15;
const heartF = 1.35; // 81 bpm

const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 30 });
const seconds = 45;
let nanAfterLock = 0;
let lockSeen = false;
let last = null;

for (let n = 0; n < seconds * fs; n++) {
  const t = n / fs;
  const activeBin = Math.floor(t / 5) % 2 === 0 ? 9 : 10;
  const phase = 1.5 * Math.sin(2 * Math.PI * 0.3 * t) + 0.08 * Math.sin(2 * Math.PI * heartF * t);
  const amplitudes = new Array(numPoints).fill(500);
  amplitudes[activeBin] = 8000;
  const phases = new Array(numPoints).fill(0);
  phases[activeBin] = phase;
  last = await proc.process({ amplitudes, phases });

  if (Number.isFinite(last.heartRateBpm)) lockSeen = true;
  if (lockSeen && !Number.isFinite(last.heartRateBpm)) nanAfterLock++;
}

console.log(
  `bin hops -> breath ${last.breathingRateRpm.toFixed(1)} rpm (expect ~18) | ` +
    `heart ${last.heartRateBpm.toFixed(1)} bpm (expect ~81) | switches ${last.switches}`,
);
console.log(`blanked after first lock: ${nanAfterLock} (want 0)`);

const ok =
  last.switches >= 5 &&
  nanAfterLock === 0 &&
  Math.abs(last.breathingRateRpm - 18) < 5 &&
  Math.abs(last.heartRateBpm - 81) < 15;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
