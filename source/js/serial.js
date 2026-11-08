// Web Serial transport for the Acconeer Exploration Server.
//
// Responsibilities:
//   - Request/open/close the serial port.
//   - Switch baud rate after the server acknowledges a set_uart_baudrate command.
//   - Frame the mixed JSON-header + binary-payload stream.
//
// NOTE: navigator.serial is only available on the main thread (not in Workers),
// which is why serial I/O lives here and DSP is delegated to a Worker.

import { END_SEQUENCE, classifyMessage, decodeHeader } from './protocol.js';

const RX_BUFFER_SIZE = 1 << 20; // 1 MiB

class ByteReader {
  constructor() {
    this._buf = new Uint8Array(0);
    this._waiter = null;
    this._closed = false;
  }

  push(chunk) {
    if (this._closed) return;
    const next = new Uint8Array(this._buf.length + chunk.length);
    next.set(this._buf, 0);
    next.set(chunk, this._buf.length);
    this._buf = next;
    this._signal();
  }

  close() {
    this._closed = true;
    this._signal();
  }

  get buffered() {
    return this._buf.length;
  }

  _signal() {
    if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      waiter();
    }
  }

  _wait() {
    return new Promise((resolve) => {
      this._waiter = resolve;
    });
  }

  async recv(numBytes) {
    while (this._buf.length < numBytes) {
      if (this._closed) throw new Error('Serial port closed while reading payload');
      await this._wait();
    }
    const out = this._buf.slice(0, numBytes);
    this._buf = this._buf.slice(numBytes);
    return out;
  }

  async recvUntil(byte) {
    for (;;) {
      const idx = this._buf.indexOf(byte);
      if (idx !== -1) {
        const out = this._buf.slice(0, idx);
        this._buf = this._buf.slice(idx + 1);
        return out;
      }
      if (this._closed) throw new Error('Serial port closed while reading header');
      await this._wait();
    }
  }
}

export class RadarSerial {
  constructor({ onMessage, onLog, onError }) {
    this._onMessage = onMessage || (() => {});
    this._onLog = onLog || (() => {});
    this._onError = onError || (() => {});

    this._port = null;
    this._reader = null;
    this._writer = null;
    this._bytes = new ByteReader();
    this._running = false;
    this._readLoopPromise = null;
    this._frameLoopPromise = null;
  }

  get isOpen() {
    return this._port !== null;
  }

  get baudRate() {
    return this._port ? this._port.baudRate : null;
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // Ports the user has already granted access to in a previous session.
  static async listPorts() {
    if (!RadarSerial.supported()) return [];
    return navigator.serial.getPorts();
  }

  async open(baudRate, port = null) {
    if (!RadarSerial.supported()) {
      throw new Error('Web Serial API is not available. Use Chrome/Edge on localhost or HTTPS.');
    }

    this._port = port;
    if (!this._port) {
      try {
        this._port = await navigator.serial.requestPort();
      } catch (err) {
        if (err.name === 'NotFoundError') {
          throw new Error('No port selected (chooser cancelled or no device available).');
        }
        throw err;
      }
    }

    try {
      await this._port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: RX_BUFFER_SIZE,
      });
    } catch (err) {
      this._port = null;
      if (err.name === 'InvalidStateError') {
        throw new Error('Port is already open in another tab or application.');
      }
      if (err.name === 'NetworkError' || /access denied|permission/i.test(err.message)) {
        throw new Error(
          `${err.message} — on Linux add your user to the 'dialout' group and log out/in.`,
        );
      }
      throw err;
    }

    this._writer = this._port.writable.getWriter();
    this._bytes = new ByteReader();
    this._running = true;

    this._readLoopPromise = this._readLoop();
    this._frameLoopPromise = this._frameLoop();

    const info = this._port.getInfo ? this._port.getInfo() : {};
    this._onLog('info', `Port opened at ${baudRate} baud`);
    if (info && info.usbVendorId != null) {
      this._onLog(
        'info',
        `USB VID:PID = ${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId
          .toString(16)
          .padStart(4, '0')}`,
      );
    }
  }

  async setBaudRate(baudRate) {
    if (!this._port) throw new Error('Port is not open');
    // SerialPort.baudRate is writable while open in Chromium, but the change is
    // applied asynchronously. Give the platform time to switch before we write
    // again; otherwise the next command goes out at the old rate and the server
    // discards it as garbage.
    this._port.baudRate = baudRate;
    await new Promise((resolve) => setTimeout(resolve, 250));
    this._onLog('info', `Local baud rate set to ${baudRate}`);
  }

  async write(bytes) {
    if (!this._writer) throw new Error('Port is not open');
    await this._writer.write(bytes);
  }

  async _readLoop() {
    const reader = this._port.readable.getReader();
    this._reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this._bytes.push(value);
      }
    } catch (err) {
      if (this._running) this._onError(err);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  async _frameLoop() {
    try {
      for (;;) {
        const headerBytes = await this._bytes.recvUntil(END_SEQUENCE);
        if (headerBytes.length === 0) continue;

        let header;
        try {
          header = decodeHeader(headerBytes);
        } catch {
          this._onLog('warn', `Dropped malformed header: ${new TextDecoder().decode(headerBytes).slice(0, 120)}`);
          continue;
        }

        let payload = null;
        if (typeof header.payload_size === 'number' && header.payload_size > 0) {
          payload = await this._bytes.recv(header.payload_size);
        }

        const message = classifyMessage(header, payload);
        this._onMessage(message);
      }
    } catch (err) {
      if (this._running) this._onError(err);
    }
  }

  async close() {
    this._running = false;

    try {
      if (this._reader) await this._reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      if (this._writer) this._writer.releaseLock();
    } catch {
      /* ignore */
    }

    this._bytes.close();

    try {
      if (this._port) await this._port.close();
    } catch (err) {
      this._onLog('warn', `Error while closing port: ${err.message}`);
    }

    this._port = null;
    this._reader = null;
    this._writer = null;

    await Promise.allSettled([this._readLoopPromise, this._frameLoopPromise]);
    this._readLoopPromise = null;
    this._frameLoopPromise = null;

    this._onLog('info', 'Port closed');
  }
}
