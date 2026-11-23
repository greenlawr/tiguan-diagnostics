// ELM327 command layer: one command at a time, each ends when the adapter prints '>'.

import { parseCanLines, elmError } from './isotp.js';

export class ElmError extends Error {}

export class Elm {
  /**
   * @param transport {open(), close(), write(text), onData: fn(text), onClose: fn()}
   * @param log optional fn(direction, text)
   */
  constructor(transport, log = () => {}) {
    this.transport = transport;
    this.log = log;
    this.buffer = '';
    this.waiter = null;
    this.queue = Promise.resolve();
    this.target = null;
    this.info = {};
    transport.onData = (text) => this._onData(text);
  }

  _onData(text) {
    this.buffer += text;
    const end = this.buffer.indexOf('>');
    if (end === -1 || !this.waiter) return;
    const body = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve(body);
  }

  /** Send one command, resolve with the non-empty response lines. */
  cmd(command, timeout = 6000) {
    const run = async () => {
      this.buffer = '';
      this.log('tx', command);
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new ElmError(`Adapter did not answer "${command}" in time`));
        }, timeout);
        this.waiter = { resolve, timer };
      });
      try {
        await this.transport.write(command + '\r');
      } catch (e) {
        if (this.waiter) clearTimeout(this.waiter.timer);
        this.waiter = null;
        response.catch(() => {});
        throw e;
      }
      const body = await response;
      const lines = body
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l && l.toUpperCase() !== command.toUpperCase() && !/^SEARCHING/i.test(l));
      this.log('rx', lines.join(' | ') || '(empty)');
      return lines;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Reset the adapter and lock it to CAN 11-bit / 500 kbit, which every 2017 VW uses. */
  async init() {
    await this.transport.open();
    await this.cmd('ATZ', 8000).catch(() => this.cmd('ATZ', 8000));
    const id = await this.cmd('ATI');
    this.info.adapter = id.find((l) => /ELM|STN|OBD/i.test(l)) || id[0] || 'Unknown adapter';
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATAT1', 'ATSP6']) await this.cmd(c);
    this.target = null;
    await this.setTarget(OBD_FUNCTIONAL);
    const probe = await this.cmd('0100', 12000);
    const err = elmError(probe);
    if (err && !parseCanLines(probe).size) {
      throw new ElmError(
        `Adapter is working but the car did not answer (${err}). Turn the ignition on and try again.`
      );
    }
  }

  /** Point requests at a CAN address. `rx` narrows the receive filter for single-module UDS. */
  async setTarget(target) {
    if (this.target && this.target.tx === target.tx && this.target.rx === target.rx) return;
    const tx = target.tx.toString(16).toUpperCase().padStart(3, '0');
    await this.cmd(`ATSH${tx}`);
    if (target.rx) {
      const rx = target.rx.toString(16).toUpperCase().padStart(3, '0');
      await this.cmd(`ATCRA${rx}`);
      // Explicit flow control so long answers arrive in full. Cheap clones may
      // reject these; short answers still work without them.
      await this.cmd(`ATFCSH${tx}`);
      await this.cmd('ATFCSD300000');
      await this.cmd('ATFCSM1');
    } else {
      await this.cmd('ATFCSM0');
      await this.cmd('ATAR');
    }
    this.target = target;
  }

  /**
   * Send a diagnostic request (hex string) and return responses by CAN id.
   * @returns {Promise<{messages: Map<number, number[][]>, error: string|null}>}
   */
  async request(target, hexRequest, timeout = 8000) {
    await this.setTarget(target);
    const lines = await this.cmd(hexRequest, timeout);
    const messages = parseCanLines(lines);
    return { messages, error: messages.size ? null : elmError(lines) || 'NO DATA' };
  }

  async batteryVoltage() {
    const lines = await this.cmd('ATRV');
    const m = lines.join(' ').match(/(\d+(\.\d+)?)\s*V?/i);
    return m ? parseFloat(m[1]) : null;
  }

  async close() {
    try {
      await this.transport.close();
    } catch {
      /* already gone */
    }
  }
}

export const OBD_FUNCTIONAL = { tx: 0x7df, rx: null };
