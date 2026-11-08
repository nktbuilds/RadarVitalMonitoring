import { VitalProcessor } from '../source/js/dsp/vitals.js';

const fs = 20;
const numPoints = 15;
const targetBin = 9;
const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 20, minSeconds: 8 });

const breathHz = 0.3; // 18 rpm
const heartHz = 1.3; // 78 bpm
const duration = 25;
const frames = duration * fs;

let last = null;
for (let n = 0; n < frames; n++) {
  const t = n / fs;
  const phase = 1.2 * Math.sin(2 * Math.PI * breathHz * t) + 0.12 * Math.sin(2 * Math.PI * heartHz * t);
  const amplitudes = new Array(numPoints).fill(500);
  amplitudes[targetBin] = 8000;
  const phases = new Array(numPoints).fill(0);
  phases[targetBin] = phase;
  last = await proc.process({ amplitudes, phases });
}

console.log('targetBin      :', last.targetBin, '(expected', targetBin + ')');
console.log('breathing RPM  :', last.breathingRateRpm.toFixed(2), '(expected 18)');
console.log('heart BPM      :', last.heartRateBpm.toFixed(2), '(expected 78)');
console.log('breath conf    :', last.breathingConfidence.toFixed(2));
console.log('heart conf     :', last.heartConfidence.toFixed(2));
console.log('samples        :', last.samples);
