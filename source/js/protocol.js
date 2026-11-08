// Acconeer Exploration Server protocol: command builders and response framing.
//
// Wire format (mirrors the official Python SDK's MessageStream):
//   - Every command is ASCII JSON terminated by "\n".
//   - Every response starts with a JSON header line terminated by "\n".
//   - If the header contains "payload_size", exactly that many raw bytes follow.

export const END_SEQUENCE = 0x0a; // '\n'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeCommand(obj) {
  return encoder.encode(JSON.stringify(obj) + '\n');
}

export const commands = {
  getSystemInfo: () => encodeCommand({ cmd: 'get_system_info' }),
  getSensorInfo: () => encodeCommand({ cmd: 'get_sensor_info' }),
  setBaudrate: (baudrate) => encodeCommand({ cmd: 'set_uart_baudrate', baudrate }),
  startStreaming: () => encodeCommand({ cmd: 'start_streaming' }),
  stopStreaming: () => encodeCommand({ cmd: 'stop_streaming' }),
};

// Translate the flat UI config into the exact JSON the Exploration Server expects.
// Reference: acconeer exptool ExplorationProtocol.setup_command / SensorConfig.to_dict.
export function buildSetupCommand(cfg) {
  const config = {
    sweep_rate: 0.0,
    frame_rate: 0.0,
    continuous_sweep_mode: false,
    double_buffering: false,
    inter_frame_idle_state: 'ready',
    inter_sweep_idle_state: 'ready',
    sweeps_per_frame: 1,
    subsweeps: [
      {
        start_point: cfg.startPoint,
        num_points: cfg.numPoints,
        step_length: cfg.stepLength,
        profile: cfg.profile,
        hwaas: cfg.hwaas,
        receiver_gain: cfg.receiverGain,
        enable_tx: true,
        enable_loopback: false,
        phase_enhancement: false,
        iq_imbalance_compensation: false,
        prf: '15_6_MHz',
      },
    ],
  };

  const setup = {
    groups: [[{ sensor_id: 1, config }]],
    update_rate: cfg.updateRate,
    cmd: 'setup',
  };

  return encodeCommand(setup);
}

// Classify a decoded header (and optional payload) into a typed message.
// Order matters and mirrors ExplorationProtocol.parse_message.
export function classifyMessage(header, payload) {
  if (header.payload_size === 0 && Array.isArray(header.result_info) && header.result_info.length === 0) {
    return { type: 'empty_result', header, payload };
  }
  if (header.status === 'ok' && header.message === 'set baudrate') {
    return { type: 'set_baudrate', header, payload };
  }
  if (header.status === 'start') {
    return { type: 'start_streaming', header, payload };
  }
  if (header.status === 'stop') {
    return { type: 'stop_streaming', header, payload };
  }
  if (header.status === 'error') {
    return { type: 'error', data: header.message, header, payload };
  }
  if (header.status === 'log') {
    return { type: 'log', data: header, header, payload };
  }
  if (header.system_info) {
    return { type: 'system_info', data: header.system_info, header, payload };
  }
  if (header.sensor_info) {
    return { type: 'sensor_info', data: header.sensor_info, header, payload };
  }
  if (header.metadata) {
    return { type: 'setup', data: header, header, payload };
  }
  if (header.result_info) {
    return { type: 'result', header, payload };
  }
  return { type: 'unknown', header, payload };
}

export function decodeHeader(bytes) {
  return JSON.parse(decoder.decode(bytes));
}

export function decodeText(bytes) {
  return decoder.decode(bytes);
}
