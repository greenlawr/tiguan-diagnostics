// Volkswagen-specific module scan using UDS (ISO 14229) over CAN.
//
// Standard OBD only exposes emissions faults from the engine and gearbox. The
// other control modules (ABS, airbag, etc.) each answer on their own CAN
// address. The addresses below are the commonly documented ones for VW Group
// cars of this era; the response id is the request id + 0x6A. Modules a given
// car does not have simply do not answer.
//
// Everything here is read-only: identification (service 0x22) and fault memory
// (service 0x19). Nothing is written to the car.

import { hex } from './isotp.js';
import { decodeDtc } from './obd.js';

const PLAIN = {
  '01': "The computer that runs the engine.",
  '02': "Controls the automatic gearbox.",
  '03': "Anti-lock brakes, traction and stability control.",
  '08': "Heating and air conditioning.",
  '09': "Lights, wipers, central locking and other body electrics.",
  '10': "Parking sensors.",
  '13': "Radar cruise control and front collision warning.",
  '15': "Airbags and seatbelt tensioners.",
  '16': "Steering wheel buttons and stalks.",
  '17': "The dials and warning lights behind the steering wheel.",
  '19': "The hub that lets all the car's computers talk to each other.",
  '42': "Driver's window, mirror and door lock.",
  '44': "Power-assisted steering.",
  '52': "Passenger's window, mirror and door lock.",
  '5F': "The touchscreen, radio and navigation.",
  'A5': "The windscreen camera used for lane assist and sign recognition.",
};

const mod = (code, name, tx, rx = tx + 0x6a) => ({ code, name, tx, rx, plain: PLAIN[code] });

export const VW_MODULES = [
  mod('01', 'Engine', 0x7e0, 0x7e8),
  mod('02', 'Gearbox', 0x7e1, 0x7e9),
  mod('03', 'Brakes and stability control', 0x713),
  mod('08', 'Heating and air conditioning', 0x746),
  mod('09', 'Body electrics', 0x70e),
  mod('10', 'Parking sensors', 0x70a),
  mod('13', 'Adaptive cruise control', 0x757),
  mod('15', 'Airbags', 0x715),
  mod('16', 'Steering wheel controls', 0x70c),
  mod('17', 'Dashboard dials', 0x714),
  mod('19', 'Communication hub', 0x710),
  mod('42', "Driver's door", 0x74a),
  mod('44', 'Power steering', 0x712),
  mod('52', "Passenger's door", 0x74b),
  mod('5F', 'Touchscreen and radio', 0x773),
  mod('A5', 'Front camera', 0x74f),
];

const DID = { partNumber: 0xf187, softwareVersion: 0xf189, hardwareNumber: 0xf191, systemName: 0xf197 };

const NRC = {
  0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported',
  0x13: 'bad message length', 0x22: 'conditions not correct', 0x31: 'request out of range',
  0x33: 'security access denied', 0x7e: 'not supported in this session', 0x7f: 'not supported in this session',
};

/** Send a UDS request to one module; returns {data} or {error}. */
async function uds(elm, module, request) {
  const { messages, error } = await elm.request({ tx: module.tx, rx: module.rx }, request, 6000);
  const list = messages.get(module.rx);
  if (!list) return { error: error || 'NO DATA', silent: true };
  const sid = parseInt(request.slice(0, 2), 16);
  // Skip "response pending" (7F xx 78) frames; take the final answer.
  const final = list.filter((p) => !(p[0] === 0x7f && p[2] === 0x78)).pop();
  if (!final) return { error: 'module still busy' };
  if (final[0] === 0x7f) return { error: NRC[final[2]] || `refused (0x${hex(final[2])})` };
  if (final[0] !== sid + 0x40) return { error: 'unexpected answer' };
  return { data: final };
}

async function readText(elm, module, did) {
  const res = await uds(elm, module, '22' + hex(did, 4));
  if (!res.data) return res;
  const text = String.fromCharCode(...res.data.slice(3).filter((b) => b >= 0x20 && b < 0x7f)).trim();
  return { text };
}

const STATUS_MASK = 0x0d; // active now | pending | confirmed

export function decodeUdsDtcs(data) {
  // 59 02 <availability mask> then 4 bytes per fault: 3-byte code + status.
  const faults = [];
  for (let i = 3; i + 3 < data.length; i += 4) {
    const [hi, mid, lo, status] = data.slice(i, i + 4);
    if (!hi && !mid && !lo) continue;
    faults.push({
      code: decodeDtc(hi, mid),
      failureType: hex(lo),
      raw: hex(hi) + hex(mid) + hex(lo),
      active: Boolean(status & 0x01),
      pending: Boolean(status & 0x04),
      confirmed: Boolean(status & 0x08),
    });
  }
  return faults;
}

/** Scan one module. Returns null if the module is not fitted / does not answer. */
export async function scanModule(elm, module) {
  const part = await readText(elm, module, DID.partNumber);
  if (part.silent) return null;
  const result = { ...module, partNumber: part.text || null, notes: [] };

  const sw = await readText(elm, module, DID.softwareVersion);
  result.softwareVersion = sw.text || null;
  const hw = await readText(elm, module, DID.hardwareNumber);
  result.hardwareNumber = hw.text || null;
  const name = await readText(elm, module, DID.systemName);
  result.systemName = name.text || null;

  const dtc = await uds(elm, module, '1902' + hex(STATUS_MASK));
  if (dtc.data) {
    result.faults = decodeUdsDtcs(dtc.data);
  } else {
    result.faults = null;
    result.notes.push(`Fault memory could not be read: ${dtc.error}`);
  }
  return result;
}
