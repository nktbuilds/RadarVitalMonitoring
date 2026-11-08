// Application entry point: connection state machine, handshake, and UI wiring.

import { RadarSerial } from './serial.js';
import { commands, buildSetupCommand } from './protocol.js';
import { DEFAULTS, HANDSHAKE_BAUD, MAX_STABLE_BAUD, readConfigFromForm, validateConfig, describePortInfo, HELP, VITALS_PRESET, computeRangeWindow } from './config.js';
import { BarChart, LineChart } from './charts.js';
import { Hysteresis } from './cues.js';

const els = {
  form: document.getElementById('config-form'),
  connectBtn: document.getElementById('connect-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  demoBtn: document.getElementById('demo-btn'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  hr: document.getElementById('hr-value'),
  rr: document.getElementById('rr-value'),
  hrConf: document.getElementById('hr-confidence'),
  rrConf: document.getElementById('rr-confidence'),
  hrCue: document.getElementById('hr-cue'),
  rrCue: document.getElementById('rr-cue'),
  target: document.getElementById('target-info'),
  stats: document.getElementById('stats'),
  lockInfo: document.getElementById('lock-info'),
  portList: document.getElementById('port-list'),
  addPortBtn: document.getElementById('add-port-btn'),
  presetBtn: document.getElementById('preset-btn'),
  rangeInfo: document.getElementById('range-info'),
  popover: document.getElementById('help-popover'),
  helpButtons: Array.from(document.querySelectorAll('.help-btn')),
  recordBtn: document.getElementById('record-btn'),
  exportBtn: document.getElementById('export-btn'),
  replayInput: document.getElementById('replay-input'),
};

const charts = {
  amplitude: new BarChart(document.getElementById('amplitude-chart')),
  phase: new LineChart(document.getElementById('phase-chart'), { color: '#8ab4ff', fill: 'rgba(79,156,255,0.12)' }),
  breathing: new LineChart(document.getElementById('breathing-chart'), { color: '#4fd1a5', fill: 'rgba(79,209,165,0.12)' }),
  heart: new LineChart(document.getElementById('heart-chart'), { color: '#ff8a8a', fill: 'rgba(255,107,107,0.12)' }),
};

const state = {
  streaming: false,
  demo: false,
  frames: 0,
  fps: 0,
  _fpsTimer: 0,
  _lastFrameTs: 0,
  metadata: null,
  config: { ...DEFAULTS },
  ports: [],
  ticksPerSecond: 1000,
  recording: false,
  recordingFrames: [],
  recordingStart: 0,
  _pending: null,
  _demoTimer: null,
  _lastChartDraw: 0,
  _hrCue: new Hysteresis('ok'),
  _rrCue: new Hysteresis('ok'),
};

const worker = new Worker(new URL('./dsp.worker.js', import.meta.url), { type: 'module' });

const serial = new RadarSerial({
  onMessage: handleMessage,
  onLog: (level, text) => log(level, text),
  onError: (err) => {
    log('error', err.message || String(err));
    if (state._pending) {
      state._pending.reject(err);
      state._pending = null;
    }
  },
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, text) {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${text}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.childElementCount > 300) els.log.removeChild(els.log.firstChild);
}

function setStatus(text, kind = 'idle') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function setConnected(connected) {
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
  els.demoBtn.disabled = connected;
  els.presetBtn.disabled = connected;
  for (const el of Array.from(els.form.elements)) {
    if (!el.classList.contains('help-btn')) el.disabled = connected;
  }
}

// ---------------------------------------------------------------------------
// Serial port list
// ---------------------------------------------------------------------------

async function refreshPorts() {
  if (!RadarSerial.supported()) return;
  let ports = [];
  try {
    ports = await RadarSerial.listPorts();
  } catch (err) {
    log('warn', `Could not enumerate ports: ${err.message}`);
    return;
  }
  state.ports = ports;
  const previous = els.portList.value;
  els.portList.innerHTML = '<option value="">— choose on Connect —</option>';
  ports.forEach((port, index) => {
    const info = port.getInfo ? port.getInfo() : {};
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `Port ${index + 1} — ${describePortInfo(info)}`;
    els.portList.appendChild(option);
  });
  if (previous !== '' && Number(previous) < ports.length) els.portList.value = previous;
}

async function addPort() {
  try {
    const port = await navigator.serial.requestPort();
    await refreshPorts();
    const index = state.ports.indexOf(port);
    if (index >= 0) els.portList.value = String(index);
    log('info', 'Serial port access granted');
  } catch (err) {
    if (err.name === 'NotFoundError') log('warn', 'No port selected');
    else log('error', err.message);
  }
}

function selectedPort() {
  if (els.portList.value === '') return null;
  return state.ports[Number(els.portList.value)] || null;
}

// ---------------------------------------------------------------------------
// Settings help popovers, live range readout, presets
// ---------------------------------------------------------------------------

function showHelp(button) {
  const key = button.dataset.help;
  const info = HELP[key];
  if (!info) return;

  els.popover.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'popover-title';
  title.textContent = info.title;
  const text = document.createElement('div');
  text.textContent = info.text;
  els.popover.append(title, text);

  if (info.recommended) {
    const rec = document.createElement('div');
    rec.className = 'popover-rec';
    rec.textContent = `Recommended: ${info.recommended}`;
    els.popover.appendChild(rec);
  }

  els.popover.hidden = false;
  const rect = button.getBoundingClientRect();
  const popRect = els.popover.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  els.popover.style.left = `${Math.max(8, left)}px`;
  els.popover.style.top = `${Math.max(8, top)}px`;
}

function hideHelp() {
  els.popover.hidden = true;
}

function updateRangeInfo() {
  const cfg = readConfigFromForm(els.form);
  const win = computeRangeWindow(cfg);
  if (!win.valid) {
    els.rangeInfo.textContent = 'Invalid step length — must divide or be a multiple of 24.';
    els.rangeInfo.classList.add('invalid');
    return;
  }
  els.rangeInfo.classList.remove('invalid');
  els.rangeInfo.textContent =
    `Window ${win.nearM.toFixed(2)}–${win.farM.toFixed(2)} m · ` +
    `${win.binCount} bins · ${(win.spacingM * 1000).toFixed(0)} mm spacing`;
}

function applyVitalsPreset() {
  for (const [name, value] of Object.entries(VITALS_PRESET)) {
    const input = els.form.elements[name];
    if (input) input.value = value;
  }
  updateRangeInfo();
  log('info', 'Applied vitals preset');
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {
    case 'log': {
      const d = msg.data;
      log((d.level || 'info').toLowerCase(), `${d.module || 'server'}: ${d.log}`);
      return;
    }
    case 'error':
      log('error', `server error: ${msg.data}`);
      if (state._pending) {
        state._pending.reject(new Error(msg.data));
        state._pending = null;
      }
      return;
    default:
      break;
  }

  if (state._pending && msg.type === state._pending.type) {
    state._pending.resolve(msg);
    return;
  }

  if (msg.type === 'result') {
    handleResult(msg);
  } else if (msg.type === 'unknown') {
    log('warn', `unhandled message: ${JSON.stringify(msg.header).slice(0, 120)}`);
  }
}

function awaitMessage(type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state._pending = null;
      reject(new Error(`Timeout waiting for '${type}' response`));
    }, timeoutMs);
    state._pending = {
      type,
      resolve: (msg) => {
        clearTimeout(timer);
        state._pending = null;
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        state._pending = null;
        reject(err);
      },
    };
  });
}

function handleResult(msg) {
  if (!state.streaming) return;
  const payload = msg.payload;
  if (!payload) return;

  const meta = state.metadata;
  const sweepsPerFrame = meta.sweepsPerFrame;
  const numPoints = state.config.numPoints;
  const tick = msg.header?.result_info?.[0]?.[0]?.tick ?? null;

  if (state.recording) {
    recordFrame(tick, payload);
  }

  worker.postMessage(
    { type: 'frame', payload: payload.buffer, sweepsPerFrame, numPoints, tick },
    [payload.buffer],
  );

  state.frames++;
}

worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'result') {
    logProcessorEvents(msg.events);
    updateDisplay(msg);
  }
};

function logProcessorEvents(events) {
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    if (ev.type === 'switch') {
      log('info', `Target switch bin ${ev.from} → ${ev.to} (amp ${Math.round(ev.fromAmp)} → ${Math.round(ev.toAmp)})`);
    } else if (ev.type === 'lost') {
      log('warn', `Target lost (bin ${ev.bin}, amp ${Math.round(ev.amp)}) — re-locking`);
    }
  }
}

// ---------------------------------------------------------------------------
// Connection handshake
// ---------------------------------------------------------------------------

async function connect() {
  const config = readConfigFromForm(els.form);
  const errors = validateConfig(config);
  if (errors.length) {
    for (const e of errors) log('error', e);
    setStatus('Invalid configuration', 'error');
    return;
  }
  state.config = config;

  setStatus('Requesting port…', 'busy');
  try {
    await serial.open(HANDSHAKE_BAUD, selectedPort());
    await refreshPorts();
  } catch (err) {
    log('error', err.message);
    setStatus('Connection failed', 'error');
    return;
  }

  setConnected(true);

  try {
    worker.postMessage({ type: 'reset' });
    setStatus('Reading system info…', 'busy');
    await serial.write(commands.getSystemInfo());
    const sysMsg = await awaitMessage('system_info');
    const info = sysMsg.data;
    state.ticksPerSecond = info.ticks_per_second || 1000;
    log('info', `RSS ${info.rss_version}, sensor ${info.sensor}, ${info.ticks_per_second} ticks/s`);

    await serial.write(commands.getSensorInfo());
    await awaitMessage('sensor_info');

    const maxBaud = info.max_baudrate || MAX_STABLE_BAUD;
    const targetBaud = Math.min(config.baudRate, maxBaud, MAX_STABLE_BAUD);
    if (targetBaud > HANDSHAKE_BAUD) {
      setStatus(`Switching to ${targetBaud} baud…`, 'busy');
      await serial.write(commands.setBaudrate(targetBaud));
      await awaitMessage('set_baudrate');
      await serial.setBaudRate(targetBaud);

      // Resync at the new baud rate. After a rate change the server commonly
      // reports "garbage from input buffer removed"; a known command confirms
      // the link is healthy before we send the (larger) setup payload.
      await sleep(200);
      try {
        await serial.write(commands.getSystemInfo());
        await awaitMessage('system_info', 3000);
        log('info', `Link verified at ${targetBaud} baud`);
      } catch {
        log('warn', `No response after baud switch; continuing at ${targetBaud} baud`);
      }
    } else {
      log('info', `Staying at ${HANDSHAKE_BAUD} baud`);
    }

    setStatus('Configuring radar…', 'busy');
    let setupMsg = null;
    for (let attempt = 1; attempt <= 2 && !setupMsg; attempt++) {
      await serial.write(buildSetupCommand(config));
      try {
        setupMsg = await awaitMessage('setup', 4000);
      } catch (err) {
        if (attempt === 1) log('warn', 'No setup response, resending setup…');
        else throw err;
      }
    }
    state.metadata = extractMetadata(setupMsg.header);
    log('info', `Setup ok: frame=${state.metadata.frameDataLength} samples, base step ${state.metadata.baseStepLengthM.toFixed(4)} m`);

    worker.postMessage({ type: 'config', updateRate: config.updateRate, ticksPerSecond: state.ticksPerSecond });

    setStatus('Starting stream…', 'busy');
    await serial.write(commands.startStreaming());
    await awaitMessage('start_streaming');

    state.streaming = true;
    state.frames = 0;
    state._fpsTimer = performance.now();
    setStatus('Streaming', 'ok');
    log('info', 'Streaming started');
  } catch (err) {
    log('error', `Handshake failed: ${err.message}`);
    setStatus('Handshake failed', 'error');
    await disconnect();
  }
}

function extractMetadata(header) {
  const group = header.metadata[0][0];
  const sweepsPerFrame = Math.round(group.frame_data_length / group.sweep_data_length);
  return {
    frameDataLength: group.frame_data_length,
    sweepDataLength: group.sweep_data_length,
    sweepsPerFrame,
    baseStepLengthM: group.base_step_length_m,
    tickPeriod: header.tick_period,
  };
}

async function disconnect() {
  stopDemo();
  if (state.streaming && serial.isOpen) {
    try {
      await serial.write(commands.stopStreaming());
      await awaitMessage('stop_streaming', 2000);
    } catch (err) {
      log('warn', `stop_streaming: ${err.message}`);
    }
  }
  state.streaming = false;

  if (serial.isOpen) {
    await serial.close();
  }
  worker.postMessage({ type: 'reset' });
  blankReadouts();
  setConnected(false);
  setStatus('Disconnected', 'idle');
}

function blankReadouts() {
  els.hr.textContent = '--';
  els.rr.textContent = '--';
  els.hr.classList.remove('stale');
  els.rr.classList.remove('stale');
  els.hrCue.className = 'cue';
  els.rrCue.className = 'cue';
  state._hrCue.reset('none');
  state._rrCue.reset('none');
  els.hrConf.textContent = 'no signal';
  els.rrConf.textContent = 'no signal';
  els.target.textContent = '--';
  els.lockInfo.textContent = '--';
}

// ---------------------------------------------------------------------------
// Display updates
// ---------------------------------------------------------------------------

function updateDisplay(result) {
  const now = performance.now();
  if (now - state._lastChartDraw < 60) return; // cap chart redraw at ~16 fps
  state._lastChartDraw = now;

  const stepMeters = state.metadata
    ? state.metadata.baseStepLengthM * state.config.stepLength
    : 0;

  charts.amplitude.setData(result.amplitudes, { stepMeters });
  charts.phase.setData(result.phase, {});
  charts.breathing.setData(result.breathing, {});
  charts.heart.setData(result.heart, {});

  const hrFinite = Number.isFinite(result.heartRateBpm);
  const rrFinite = Number.isFinite(result.breathingRateRpm);

  // Debounced cues: a state must persist ~2 s before the indicator changes, so
  // a single harmonic-landing frame cannot make the dot/text flicker.
  const hrTarget = hrFinite
    ? result.heartHarmonic ? 'harm' : result.heartStale ? 'held' : 'ok'
    : 'none';
  const rrTarget = rrFinite
    ? result.breathingStale ? 'held' : 'ok'
    : 'none';
  const hrCue = hrFinite ? state._hrCue.update(hrTarget, now) : 'none';
  const rrCue = rrFinite ? state._rrCue.update(rrTarget, now) : 'none';
  if (!hrFinite) state._hrCue.reset('none');
  if (!rrFinite) state._rrCue.reset('none');

  const hrDim = hrCue === 'harm' || hrCue === 'held';
  const rrDim = rrCue === 'held';

  els.hr.textContent = hrFinite ? result.heartRateBpm.toFixed(1) : '--';
  els.rr.textContent = rrFinite ? result.breathingRateRpm.toFixed(1) : '--';
  els.hr.classList.toggle('stale', hrDim);
  els.rr.classList.toggle('stale', rrDim);

  els.hrCue.className = hrCue === 'none' ? 'cue' : `cue ${hrCue}`;
  els.rrCue.className = rrCue === 'none' ? 'cue' : `cue ${rrCue}`;

  const hrConfText = hrCue === 'harm'
    ? 'likely breathing harmonic'
    : hrCue === 'held'
      ? 'held · low signal'
      : `${Math.round(result.heartConfidence * 100)}% confidence`;
  const rrConfText = rrCue === 'held'
    ? 'held · low signal'
    : `${Math.round(result.breathingConfidence * 100)}% confidence`;
  els.hrConf.textContent = hrFinite ? hrConfText : 'no signal';
  els.rrConf.textContent = rrFinite ? rrConfText : 'no signal';

  const dist = state.metadata && result.targetBin != null
    ? (state.config.startPoint + result.targetBin * state.config.stepLength) * state.metadata.baseStepLengthM
    : null;
  els.target.textContent = result.targetBin != null
    ? `bin ${result.targetBin} · ${dist.toFixed(2)} m`
    : 'no target';

  const hrState = hrCue === 'harm' ? 'harm?' : hrCue === 'held' ? 'held' : 'ok';
  const rrState = rrCue === 'held' ? 'held' : 'ok';
  const hops = Number.isFinite(result.switches) ? result.switches : 0;
  els.lockInfo.textContent =
    `HR ${Math.round(result.heartConfidence * 100)}% ${hrState} · ` +
    `RR ${Math.round(result.breathingConfidence * 100)}% ${rrState} · ` +
    `${hops} hop${hops === 1 ? '' : 's'}`;

  const elapsed = (now - state._fpsTimer) / 1000;
  if (elapsed >= 1) {
    state.fps = state.frames / elapsed;
    state.frames = 0;
    state._fpsTimer = now;
  }
  const fsText = Number.isFinite(result.measuredFs) ? ` · ${result.measuredFs.toFixed(1)} Hz` : '';
  els.stats.textContent = `${state.fps.toFixed(1)} fps${fsText} · ${result.samples} samples buffered`;
}

// ---------------------------------------------------------------------------
// Demo mode (synthetic data, no hardware)
// ---------------------------------------------------------------------------

function startDemo() {
  const config = readConfigFromForm(els.form);
  const errors = validateConfig(config);
  if (errors.length) {
    for (const e of errors) log('error', e);
    return;
  }
  state.config = config;
  state.metadata = {
    sweepsPerFrame: 1,
    baseStepLengthM: 0.0025,
    tickPeriod: 0,
  };
  state.demo = true;
  state.streaming = true;
  state.frames = 0;
  state._fpsTimer = performance.now();
  setConnected(true);
  els.demoBtn.disabled = false;
  setStatus('Demo streaming (synthetic)', 'ok');
  log('info', 'Demo mode started — no hardware required');

  state.ticksPerSecond = 1000;
  worker.postMessage({ type: 'config', updateRate: config.updateRate, ticksPerSecond: state.ticksPerSecond });

  const dt = 1 / config.updateRate;
  const t0 = performance.now();
  let t = 0;
  let tick = 0;
  state._demoTimer = setInterval(() => {
    t = (performance.now() - t0) / 1000;
    const buffer = synthesizeFrame(config.numPoints, t);
    tick = Math.round(t * state.ticksPerSecond);
    if (state.recording) recordFrame(tick, new Uint8Array(buffer));
    worker.postMessage(
      { type: 'frame', payload: buffer, sweepsPerFrame: 1, numPoints: config.numPoints, tick },
      [buffer],
    );
    state.frames++;
  }, dt * 1000);
}

function stopDemo() {
  if (state._demoTimer) {
    clearInterval(state._demoTimer);
    state._demoTimer = null;
  }
  state.demo = false;
}

// Build a synthetic int16 I/Q frame with a breathing + heart phase modulation.
function synthesizeFrame(numPoints, t) {
  const targetBin = Math.min(numPoints - 1, Math.floor(numPoints * 0.6));
  const breathing = 1.2 * Math.sin(2 * Math.PI * 0.3 * t);
  const heart = 0.12 * Math.sin(2 * Math.PI * 1.3 * t);
  const phase = breathing + heart;
  const buffer = new ArrayBuffer(numPoints * 4);
  const view = new DataView(buffer);

  for (let bin = 0; bin < numPoints; bin++) {
    let amp;
    if (bin === targetBin) amp = 8000;
    else amp = 2000 * Math.exp(-Math.abs(bin - targetBin));
    amp += (Math.random() - 0.5) * 100;

    const p = bin === targetBin ? phase : 0;
    const i = Math.round(amp * Math.cos(p));
    const q = Math.round(amp * Math.sin(p));
    view.setInt16(bin * 4, clampInt16(i), true);
    view.setInt16(bin * 4 + 2, clampInt16(q), true);
  }
  return buffer;
}

function clampInt16(v) {
  return Math.max(-32768, Math.min(32767, v));
}

// ---------------------------------------------------------------------------
// Record / export / replay
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function recordFrame(tick, payload) {
  state.recordingFrames.push({ tick, bytes: payload.slice() });
}

function toggleRecording() {
  state.recording = !state.recording;
  if (state.recording) {
    state.recordingFrames = [];
    state.recordingStart = performance.now();
    els.recordBtn.textContent = 'Stop';
    els.recordBtn.classList.add('recording');
    log('info', 'Recording started');
  } else {
    els.recordBtn.textContent = 'Record';
    els.recordBtn.classList.remove('recording');
    const seconds = ((performance.now() - state.recordingStart) / 1000).toFixed(1);
    log('info', `Recording stopped: ${state.recordingFrames.length} frames (${seconds}s)`);
  }
  els.exportBtn.disabled = state.recordingFrames.length === 0;
}

function exportRecording() {
  if (state.recordingFrames.length === 0) return;
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    config: state.config,
    metadata: state.metadata,
    ticksPerSecond: state.ticksPerSecond,
    frames: state.recordingFrames.map((f) => ({ tick: f.tick, payload: bytesToBase64(f.bytes) })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xm125-recording-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log('info', `Exported ${state.recordingFrames.length} frames`);
}

async function replayFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    log('error', `Could not read recording: ${err.message}`);
    return;
  }
  if (!data.frames || !data.frames.length) {
    log('error', 'Recording contains no frames');
    return;
  }

  stopDemo();
  state.config = { ...DEFAULTS, ...(data.config || {}) };
  state.metadata = data.metadata || { sweepsPerFrame: 1, baseStepLengthM: 0.0025 };
  state.ticksPerSecond = data.ticksPerSecond || 1000;
  state.streaming = true;
  state.frames = 0;
  state._fpsTimer = performance.now();
  setConnected(true);
  els.demoBtn.disabled = false;
  setStatus('Replaying recording', 'ok');
  log('info', `Replaying ${data.frames.length} frames`);

  worker.postMessage({
    type: 'config',
    updateRate: state.config.updateRate,
    ticksPerSecond: state.ticksPerSecond,
  });
  worker.postMessage({ type: 'reset' });

  const dtMs = 1000 / (state.config.updateRate || 20);
  let index = 0;
  state._demoTimer = setInterval(() => {
    if (index >= data.frames.length) {
      clearInterval(state._demoTimer);
      state._demoTimer = null;
      log('info', 'Replay finished');
      return;
    }
    const frame = data.frames[index++];
    const bytes = base64ToBytes(frame.payload);
    const buffer = bytes.buffer;
    worker.postMessage(
      {
        type: 'frame',
        payload: buffer,
        sweepsPerFrame: state.metadata.sweepsPerFrame || 1,
        numPoints: state.config.numPoints,
        tick: frame.tick,
      },
      [buffer],
    );
    state.frames++;
  }, dtMs);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.connectBtn.addEventListener('click', connect);
els.disconnectBtn.addEventListener('click', disconnect);
els.addPortBtn.addEventListener('click', addPort);
els.presetBtn.addEventListener('click', applyVitalsPreset);
els.recordBtn.addEventListener('click', toggleRecording);
els.exportBtn.addEventListener('click', exportRecording);
els.replayInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) replayFile(file);
  event.target.value = '';
});

for (const button of els.helpButtons) {
  button.addEventListener('mouseenter', () => showHelp(button));
  button.addEventListener('focus', () => showHelp(button));
  button.addEventListener('mouseleave', hideHelp);
  button.addEventListener('blur', hideHelp);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (els.popover.hidden) showHelp(button);
    else hideHelp();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideHelp();
});
els.form.addEventListener('input', updateRangeInfo);
window.addEventListener('resize', hideHelp);
window.addEventListener('scroll', hideHelp, true);
els.demoBtn.addEventListener('click', () => {
  if (state.demo) {
    stopDemo();
    state.streaming = false;
    setConnected(false);
    setStatus('Disconnected', 'idle');
  } else {
    startDemo();
  }
});

window.addEventListener('beforeunload', () => {
  stopDemo();
  if (serial.isOpen) serial.close();
});

if (!RadarSerial.supported()) {
  setStatus('Web Serial unsupported — use Chrome/Edge on localhost or HTTPS', 'error');
  els.connectBtn.disabled = true;
  els.addPortBtn.disabled = true;
} else {
  setStatus('Ready', 'idle');
  refreshPorts();
  navigator.serial.addEventListener('connect', refreshPorts);
  navigator.serial.addEventListener('disconnect', refreshPorts);
}

log('info', 'XM125 Web Serial Vital Signs Monitor ready');

updateRangeInfo();
const confTip = 'Spectral peak prominence: 100% means the dominant peak is ≥4× the average in-band energy.';
els.hrConf.title = confTip;
els.rrConf.title = confTip;
