import { VitalProcessor } from '../source/js/dsp/vitals.js';
const fs=20, numPoints=15, targetBin=9;
const proc = new VitalProcessor({ updateRate: fs, bufferSeconds: 30 });
let last=null;
for (let n=0;n<60*fs;n++){
  const t=n/fs;
  const phase=1.5*Math.sin(2*Math.PI*0.3*t)+0.08*Math.sin(2*Math.PI*1.35*t);
  const amplitudes=new Array(numPoints).fill(500); amplitudes[targetBin]=8000;
  const phases=new Array(numPoints).fill(0); phases[targetBin]=phase;
  last=await proc.process({amplitudes,phases});
}
const b=last.breathing;
const rms=(a)=>Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length);
const head=rms(b.slice(0,20)), tail=rms(b.slice(-200));
console.log('breathing series length:', b.length);
console.log('RMS first 20 (oldest):', head.toFixed(4));
console.log('RMS last 200 (newest):', tail.toFixed(4));
console.log('head/tail ratio:', (head/tail).toFixed(2), '(≈1 means no left-edge spike)');
