// Standard OBD-II services (the legally mandated, emissions-related set).

import { OBD_FUNCTIONAL } from './elm.js';
import { hex } from './isotp.js';

const SYSTEM = ['P', 'C', 'B', 'U'];

/** Two bytes -> "P0299". */
export function decodeDtc(hi, lo) {
  return SYSTEM[hi >> 6] + ((hi >> 4) & 0x3).toString(16) + (hi & 0x0f).toString(16).toUpperCase() + hex(lo);
}

/** Find the first message per ECU that is a positive response to `service`. */
function positives(messages, service) {
  const found = [];
  for (const [id, list] of messages) {
    for (const payload of list) {
      if (payload[0] === service + 0x40) found.push({ id, payload });
    }
  }
  return found;
}

/** Services 03 (stored), 07 (pending), 0A (permanent). */
export async function readDtcs(elm, service) {
  const { messages } = await elm.request(OBD_FUNCTIONAL, hex(service));
  const codes = new Set();
  for (const { payload } of positives(messages, service)) {
    // On CAN the byte after the service id is the DTC count.
    for (let i = 2; i + 1 < payload.length; i += 2) {
      if (payload[i] === 0 && payload[i + 1] === 0) continue;
      codes.add(decodeDtc(payload[i], payload[i + 1]));
    }
  }
  return [...codes];
}

/** Service 04. Returns true if at least one ECU acknowledged. */
export async function clearDtcs(elm) {
  const { messages } = await elm.request(OBD_FUNCTIONAL, '04', 12000);
  return positives(messages, 0x04).length > 0;
}

export async function readVin(elm) {
  const { messages } = await elm.request(OBD_FUNCTIONAL, '0902', 10000);
  for (const { payload } of positives(messages, 0x09)) {
    if (payload[1] !== 0x02) continue;
    const chars = payload.slice(3).filter((b) => b >= 0x20 && b < 0x7f);
    const vin = String.fromCharCode(...chars).trim();
    if (vin.length >= 17) return vin.slice(-17);
  }
  return null;
}

const SPARK_MONITORS = [
  'Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air system',
  'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR / VVT system',
];
const DIESEL_MONITORS = [
  'NMHC catalyst', 'NOx / SCR aftertreatment', null, 'Boost pressure',
  null, 'Exhaust gas sensor', 'Particulate filter (DPF)', 'EGR / VVT system',
];
const CONTINUOUS = ['Misfire', 'Fuel system', 'Components'];

/** Service 01 PID 01: warning light, fault count and emissions monitor readiness. */
export async function readStatus(elm) {
  const { messages } = await elm.request(OBD_FUNCTIONAL, '0101');
  const answers = positives(messages, 0x01).filter((a) => a.payload[1] === 0x01 && a.payload.length >= 6);
  if (!answers.length) return null;
  // Prefer the engine ECU (0x7E8); it owns the monitors.
  answers.sort((a, b) => a.id - b.id);
  const [, , a, b, c, d] = answers[0].payload;
  const diesel = Boolean(b & 0x08);
  const monitors = [];
  CONTINUOUS.forEach((name, i) => {
    if (b & (1 << i)) monitors.push({ name, ready: !(b & (1 << (i + 4))) });
  });
  (diesel ? DIESEL_MONITORS : SPARK_MONITORS).forEach((name, i) => {
    if (name && c & (1 << i)) monitors.push({ name, ready: !(d & (1 << i)) });
  });
  return {
    mil: answers.some((x) => x.payload[2] & 0x80),
    dtcCount: answers.reduce((n, x) => n + (x.payload[2] & 0x7f), 0),
    diesel,
    monitors,
  };
}

/** Which service-01 PIDs the car supports, from the 00/20/40/60 bitmaps. */
export async function readSupportedPids(elm) {
  const supported = new Set();
  for (const base of [0x00, 0x20, 0x40, 0x60]) {
    if (base !== 0 && !supported.has(base)) break;
    const { messages } = await elm.request(OBD_FUNCTIONAL, '01' + hex(base));
    for (const { payload } of positives(messages, 0x01)) {
      if (payload[1] !== base) continue;
      for (let i = 0; i < 32; i++) {
        if (payload[2 + (i >> 3)] & (0x80 >> (i & 7))) supported.add(base + i + 1);
      }
    }
  }
  return supported;
}

/** Read one live value. Returns the data bytes after the PID, or null. */
export async function readPid(elm, pid) {
  const { messages } = await elm.request(OBD_FUNCTIONAL, '01' + hex(pid), 4000);
  const answers = positives(messages, 0x01).filter((a) => a.payload[1] === pid);
  if (!answers.length) return null;
  answers.sort((a, b) => a.id - b.id);
  return answers[0].payload.slice(2);
}
