// A pretend ELM327 + car, so the app can be tried (and tested) without a vehicle.
// It speaks the same text protocol as a real adapter, including ISO-TP framing.

import { encodeIsoTp } from './isotp.js';

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const VIN = 'WVGZZZ5NZHW000000';

const MODULES = {
  0x7e0: { rx: 0x7e8, part: '04E906027JT', sw: '4517', hw: '04E907309AD', name: 'R4 1.4l TFSI', faults: [[0x02, 0x99, 0x00, 0x09]] },
  0x7e1: { rx: 0x7e9, part: '0CW300050K', sw: '5403', hw: '0AM927769D', name: 'GSG DQ250', faults: [] },
  0x713: { rx: 0x77d, part: '5Q0614517DT', sw: '0421', hw: '5Q0614517AB', name: 'ESC', faults: [[0x40, 0x12, 0x29, 0x08]] },
  0x715: { rx: 0x77f, part: '5Q0959655AT', sw: '0458', hw: '5Q0959655AT', name: 'VW10Airbag', faults: [] },
  0x714: { rx: 0x77e, part: '5NA920750A', sw: '3041', hw: '5NA920750A', name: 'KOMBI', faults: [] },
  0x710: { rx: 0x77a, part: '3Q0907530AQ', sw: '4350', hw: '3Q0907530C', name: 'GW MQB High', faults: [] },
  0x70e: { rx: 0x778, part: '5Q0937084CQ', sw: '0155', hw: '5Q0937084CQ', name: 'BCM MQBAB H', faults: [] },
  0x773: { rx: 0x7dd, part: '5NA035180', sw: '0478', hw: '5NA035180', name: 'MU-S-ND-ER', faults: null },
};

export class SimulatorTransport {
  constructor() {
    this.onData = () => {};
    this.onClose = () => {};
    this.name = 'Demo car';
    this.header = 0x7df;
    this.stored = [[0x02, 0x99]]; // P0299
    this.pending = [[0x01, 0x71]]; // P0171
    this.start = Date.now();
  }

  async open() {}
  async close() {}

  async write(text) {
    const command = text.replace(/[\r\s]/g, '').toUpperCase();
    const reply = this._handle(command).join('\r');
    setTimeout(() => this.onData(reply + '\r\r>'), 5);
  }

  _handle(c) {
    if (c.startsWith('AT')) return [this._at(c.slice(2))];
    const req = [];
    for (let i = 0; i < c.length; i += 2) req.push(parseInt(c.slice(i, i + 2), 16));
    const lines = this.header === 0x7df ? this._obd(req) : this._uds(req);
    return lines.length ? lines : ['NO DATA'];
  }

  _at(c) {
    if (c === 'Z') return 'ELM327 v1.5';
    if (c === 'I') return 'ELM327 v1.5';
    if (c === 'RV') return '14.1V';
    if (c.startsWith('SH')) {
      this.header = parseInt(c.slice(2), 16);
      return 'OK';
    }
    return 'OK';
  }

  _obd(req) {
    const [svc, pid] = req;
    const both = (payload, second) => [
      ...encodeIsoTp(0x7e8, payload),
      ...(second ? encodeIsoTp(0x7e9, second) : []),
    ];
    if (svc === 0x01) {
      const t = (Date.now() - this.start) / 1000;
      const rpm = Math.round((850 + 60 * Math.sin(t)) * 4);
      const table = {
        0x00: [0xbe, 0x1f, 0xa8, 0x13],
        0x20: [0x80, 0x07, 0xa0, 0x01],
        0x40: [0x44, 0x00, 0x00, 0x14],
        0x01: [(this.stored.length ? 0x80 : 0) | this.stored.length, 0x07, 0xe5, this.stored.length ? 0x00 : 0x21],
        0x04: [70 + Math.round(8 * Math.sin(t / 2))],
        0x05: [88 + 40],
        0x06: [128 + Math.round(4 * Math.sin(t))],
        0x07: [133],
        0x0b: [34],
        0x0c: [rpm >> 8, rpm & 0xff],
        0x0d: [Math.max(0, Math.round(48 + 26 * Math.sin(t / 7)))],
        0x0e: [140],
        0x0f: [22 + 40],
        0x10: [0x01, 0x2c],
        0x11: [38],
        0x1f: [Math.floor(t) >> 8, Math.floor(t) & 0xff],
        0x21: [0x00, 0x2a],
        0x2f: [150],
        0x31: [0x1f, 0x40],
        0x33: [101],
        0x42: [0x37, 0x14],
        0x46: [14 + 40],
        0x5c: [92 + 40],
        0x5e: (() => { const raw = Math.round((6 + 3 * Math.sin(t / 5)) * 20); return [raw >> 8, raw & 0xff]; })(),
      };
      if (!table[pid]) return [];
      const gearbox = pid === 0x00 ? [0x41, 0x00, 0x80, 0x00, 0x00, 0x00] : null;
      return both([0x41, pid, ...table[pid]], gearbox);
    }
    if (svc === 0x03) return both([0x43, this.stored.length, ...this.stored.flat()], [0x43, 0x00]);
    if (svc === 0x07) return both([0x47, this.pending.length, ...this.pending.flat()]);
    if (svc === 0x0a) return both([0x4a, 0x00]);
    if (svc === 0x04) {
      this.stored = [];
      this.pending = [];
      MODULES[0x7e0].faults = [];
      return both([0x44]);
    }
    if (svc === 0x09 && pid === 0x02) return both([0x49, 0x02, 0x01, ...ascii(VIN)]);
    return [];
  }

  _uds(req) {
    const m = MODULES[this.header];
    if (!m) return [];
    const [svc, a, b] = req;
    if (svc === 0x22) {
      const did = (a << 8) | b;
      const text = { 0xf187: m.part, 0xf189: m.sw, 0xf191: m.hw, 0xf197: m.name }[did];
      if (!text) return encodeIsoTp(m.rx, [0x7f, 0x22, 0x31]);
      return encodeIsoTp(m.rx, [0x62, a, b, ...ascii(text)]);
    }
    if (svc === 0x19 && a === 0x02) {
      if (m.faults === null) return encodeIsoTp(m.rx, [0x7f, 0x19, 0x7f]);
      return encodeIsoTp(m.rx, [0x59, 0x02, 0xff, ...m.faults.flat()]);
    }
    return encodeIsoTp(m.rx, [0x7f, svc, 0x11]);
  }
}
