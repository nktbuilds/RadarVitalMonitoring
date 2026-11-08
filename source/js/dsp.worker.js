// DSP Web Worker (module worker).
//
// Keeps the heavy per-frame work off the main thread. The main thread forwards
// raw binary payloads (transferred ArrayBuffers) plus frame metadata; the worker
// decodes the int16 I/Q pairs and runs the vital-sign pipeline.

import { VitalProcessor } from './dsp/vitals.js';

const TICK_LIMIT = 2 ** 32;

let processor = new VitalProcessor();

let ticksPerSecond = 1000;
let lastTick = null;
let lastUnwrappedTick = null;
let tickBase = 0;
let measuredFs = null;

self.onmessage = async (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'config':
      if (msg.ticksPerSecond) ticksPerSecond = msg.ticksPerSecond;
      processor.setSampleRate(msg.updateRate);
      resetTickTracking();
      self.postMessage({ type: 'ready', updateRate: msg.updateRate });
      break;

    case 'reset':
      processor.reset();
      resetTickTracking();
      break;

    case 'frame':
      await handleFrame(msg);
      break;

    default:
      break;
  }
};

function resetTickTracking() {
  lastTick = null;
  lastUnwrappedTick = null;
  tickBase = 0;
  measuredFs = null;
}

// Estimate the true frame rate from the server's tick counter (which wraps at
// 2^32). This keeps the FFT frequency axis correct even if frames are dropped
// or arrive irregularly.
function updateMeasuredFs(tick) {
  if (tick == null) return;
  if (lastTick !== null && tick < lastTick) tickBase += TICK_LIMIT;
  const unwrapped = tickBase + tick;

  if (lastUnwrappedTick !== null) {
    const dt = (unwrapped - lastUnwrappedTick) / ticksPerSecond;
    if (dt > 0) {
      const instant = 1 / dt;
      measuredFs = measuredFs === null ? instant : 0.9 * measuredFs + 0.1 * instant;
    }
  }

  lastTick = tick;
  lastUnwrappedTick = unwrapped;
}

async function handleFrame({ payload, sweepsPerFrame, numPoints, tick }) {
  updateMeasuredFs(tick);
  if (measuredFs !== null) processor.setSampleRate(measuredFs);

  const { amplitudes, phases } = decodeIQ(payload, sweepsPerFrame, numPoints);
  const result = await processor.process({ amplitudes, phases });
  result.type = 'result';
  result.measuredFs = measuredFs;
  self.postMessage(result);
}

// Decode interleaved little-endian int16 [I, Q] pairs.
// Layout is sweep-major then distance: index = sweep * numPoints + bin.
function decodeIQ(buffer, sweepsPerFrame, numPoints) {
  const view = new DataView(buffer);
  const amplitudes = new Float64Array(numPoints);
  const phases = new Float64Array(numPoints);

  for (let sweep = 0; sweep < sweepsPerFrame; sweep++) {
    for (let bin = 0; bin < numPoints; bin++) {
      const offset = (sweep * numPoints + bin) * 4;
      const i = view.getInt16(offset, true);
      const q = view.getInt16(offset + 2, true);
      amplitudes[bin] += Math.hypot(i, q) / sweepsPerFrame;
      if (sweep === 0) phases[bin] = Math.atan2(q, i);
    }
  }

  return { amplitudes: Array.from(amplitudes), phases: Array.from(phases) };
}
