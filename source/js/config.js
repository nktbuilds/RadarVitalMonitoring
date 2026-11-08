// Central configuration defaults, allowed ranges and validation.

export const BAUD_RATES = [115200, 256000, 460800, 576000];

// The SparkFun XM125 board has no hardware flow control; higher rates
// overflow the RX buffer and corrupt the JSON header stream.
export const MAX_STABLE_BAUD = 460800;
export const HANDSHAKE_BAUD = 115200;

export const DEFAULTS = {
  baudRate: MAX_STABLE_BAUD,
  startPoint: 80,
  numPoints: 15,
  stepLength: 8,
  profile: 3,
  hwaas: 32,
  receiverGain: 16,
  updateRate: 20,
};

export const LIMITS = {
  startPoint: { min: -275, max: 1000, step: 1 },
  numPoints: { min: 1, max: 160, step: 1 },
  stepLength: { min: 1, max: 48, step: 1 },
  profile: { min: 1, max: 5, step: 1 },
  hwaas: { min: 1, max: 511, step: 1 },
  receiverGain: { min: 0, max: 23, step: 1 },
  updateRate: { min: 1, max: 100, step: 1 },
};

// Sparse IQ requires step_length to divide or be a multiple of 24.
export const SPARSE_IQ_PPC = 24;

export function isValidStepLength(step) {
  if (!Number.isInteger(step) || step < 1) return false;
  return SPARSE_IQ_PPC % step === 0 || step % SPARSE_IQ_PPC === 0;
}

export function validateConfig(cfg) {
  const errors = [];

  if (!BAUD_RATES.includes(cfg.baudRate)) {
    errors.push(`Baud rate ${cfg.baudRate} is not supported.`);
  }
  if (cfg.baudRate > MAX_STABLE_BAUD) {
    errors.push(`Baud rate above ${MAX_STABLE_BAUD} is unstable without flow control.`);
  }
  if (!isValidStepLength(cfg.stepLength)) {
    errors.push(`Step length must divide or be a multiple of ${SPARSE_IQ_PPC}.`);
  }
  for (const key of Object.keys(LIMITS)) {
    const { min, max } = LIMITS[key];
    const value = cfg[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${key} must be between ${min} and ${max}.`);
    }
  }
  if (cfg.updateRate <= 0) {
    errors.push('Update rate must be positive.');
  }

  return errors;
}

export function readConfigFromForm(form) {
  const get = (name) => Number(form.elements[name].value);
  return {
    baudRate: get('baudRate'),
    startPoint: get('startPoint'),
    numPoints: get('numPoints'),
    stepLength: get('stepLength'),
    profile: get('profile'),
    hwaas: get('hwaas'),
    receiverGain: get('receiverGain'),
    updateRate: get('updateRate'),
  };
}

// Nominal base step of the A121 discrete distance scale (~2.5 mm).
// The exact value is reported by the server as base_step_length_m once connected.
export const NOMINAL_BASE_STEP_M = 0.0025;

export function computeRangeWindow(cfg) {
  const base = NOMINAL_BASE_STEP_M;
  const spacingM = cfg.stepLength * base;
  const nearM = cfg.startPoint * base;
  const farM = (cfg.startPoint + (cfg.numPoints - 1) * cfg.stepLength) * base;
  return {
    nearM,
    farM,
    spacingM,
    binCount: cfg.numPoints,
    valid: isValidStepLength(cfg.stepLength),
  };
}

// Recommended starting configuration for a seated subject ~0.3-0.6 m away.
export const VITALS_PRESET = {
  startPoint: 120,
  numPoints: 15,
  stepLength: 8,
  profile: 3,
  hwaas: 32,
  receiverGain: 16,
  updateRate: 20,
};

// Explanatory text for the settings help popovers.
export const HELP = {
  startPoint: {
    title: 'Start point',
    text: 'Distance of the first measured bin, in discrete steps of ~2.5 mm. Shifts the whole range window. May be negative (down to -275) to begin before the antenna plane.',
    recommended: '120 (≈0.30 m) for a seated subject',
  },
  numPoints: {
    title: 'Number of points',
    text: 'How many bins are measured across the window. More bins cover a wider range but use more memory and time. Window length = (num_points - 1) × step_length.',
    recommended: '10–15',
  },
  stepLength: {
    title: 'Step length',
    text: 'Spacing between bins, in ~2.5 mm units (e.g. 8 = 20 mm). Must divide or be a multiple of 24. Too large risks "blind spots" where a target falls between bins.',
    recommended: '4–8 (10–20 mm)',
  },
  profile: {
    title: 'Profile (1–5)',
    text: 'Pulse length. Lower profiles give better range resolution and can measure closer (smaller close-in distance) but have less gain; higher profiles give more SNR at the cost of resolution and a larger close-in distance.',
    recommended: '3 (use 4–5 if the subject is far)',
  },
  hwaas: {
    title: 'HWAAS',
    text: 'Hardware Accelerated Average Samples: each point is averaged this many times by the sensor. Higher values raise SNR but increase measurement time linearly, lowering the achievable frame rate.',
    recommended: '32–64',
  },
  receiverGain: {
    title: 'Receiver gain (0–23)',
    text: 'Front-end gain. Too low causes quantization; too high saturates the signal and corrupts the phase.',
    recommended: '16',
  },
  updateRate: {
    title: 'Update rate',
    text: 'Frame-rate limiter, which sets the phase sampling rate (fs). Must be well above twice the heart band (≥5 Hz); 20 Hz gives good margin and keeps serial traffic low.',
    recommended: '20 Hz',
  },
};

// Friendly names for common USB-serial bridges and Acconeer native USB IDs.
// The SparkFun XM125 uses a USB-serial bridge (e.g. CH340 / CP210x); the exact
// ID depends on the board revision.
export const USB_BRIDGES = {
  '0483:a41d': 'Acconeer XC120',
  '0483:a42c': 'Acconeer XC120',
  '0483:a42d': 'Acconeer XC120',
  '0483:a449': 'Acconeer XC120',
  'acc0:e121': 'Acconeer XV12X',
  '10c4:ea60': 'Silicon Labs CP210x',
  '10c4:ea70': 'Silicon Labs CP2105',
  '1a86:7523': 'WCH CH340',
  '1a86:55d4': 'WCH CH9102',
  '0403:6001': 'FTDI FT232',
  '0403:6015': 'FTDI FT231X',
  '2341:0043': 'Arduino',
};

export function describePortInfo(info) {
  if (!info || info.usbVendorId == null || info.usbProductId == null) {
    return 'unknown device';
  }
  const vid = info.usbVendorId.toString(16).padStart(4, '0');
  const pid = info.usbProductId.toString(16).padStart(4, '0');
  const key = `${vid}:${pid}`;
  const name = USB_BRIDGES[key];
  return name ? `${name} (${key})` : `USB device (${key})`;
}
