// Parsing of ELM327 output for CAN (ISO 15765-4, 11-bit IDs) with headers on.
// Each data line looks like "7E8 06 41 00 BE 3F A8 13" (spaces optional).

const HEX_LINE = /^[0-9A-F]+$/;

export const hex = (n, width = 2) => n.toString(16).toUpperCase().padStart(width, '0');
export const bytesToHex = (bytes) => Array.from(bytes, (b) => hex(b)).join(' ');

/** ELM status words that mean "no usable answer". */
export function elmError(lines) {
  const text = lines.join(' ').toUpperCase();
  const known = [
    'UNABLE TO CONNECT', 'CAN ERROR', 'BUS INIT', 'BUS ERROR', 'BUS BUSY',
    'FB ERROR', 'DATA ERROR', 'BUFFER FULL', 'STOPPED', 'NO DATA', 'LV RESET', 'ERR',
  ];
  for (const k of known) if (text.includes(k)) return k;
  if (lines.some((l) => l.trim() === '?')) return '?';
  return null;
}

/**
 * Reassemble ISO-TP frames from ELM lines.
 * @returns {Map<number, number[][]>} CAN id -> list of complete message payloads
 */
export function parseCanLines(lines) {
  const out = new Map();
  const pending = new Map(); // id -> {len, data}
  const push = (id, payload) => {
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(payload);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, '').toUpperCase();
    if (line.length < 5 || line.length % 2 !== 1 || !HEX_LINE.test(line)) continue;
    const id = parseInt(line.slice(0, 3), 16);
    const data = [];
    for (let i = 3; i < line.length; i += 2) data.push(parseInt(line.slice(i, i + 2), 16));
    if (!data.length) continue;

    const type = data[0] >> 4;
    if (type === 0) {
      const len = data[0] & 0x0f;
      if (len > 0) push(id, data.slice(1, 1 + len));
    } else if (type === 1) {
      const len = ((data[0] & 0x0f) << 8) | data[1];
      pending.set(id, { len, data: data.slice(2) });
    } else if (type === 2) {
      const p = pending.get(id);
      if (!p) continue;
      p.data.push(...data.slice(1));
      if (p.data.length >= p.len) {
        push(id, p.data.slice(0, p.len));
        pending.delete(id);
      }
    }
    // type 3 (flow control) is ignored
  }
  return out;
}

/** Encode a payload as ELM-style lines (used by the simulator and tests). */
export function encodeIsoTp(id, payload, spaces = false) {
  const sep = spaces ? ' ' : '';
  const fmt = (bytes) => [hex(id, 3), ...bytes.map((b) => hex(b))].join(sep);
  if (payload.length <= 7) return [fmt([payload.length, ...payload])];
  const lines = [fmt([0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)])];
  let seq = 1;
  for (let i = 6; i < payload.length; i += 7) {
    const chunk = payload.slice(i, i + 7);
    while (chunk.length < 7) chunk.push(0xaa);
    lines.push(fmt([0x20 | (seq & 0x0f), ...chunk]));
    seq++;
  }
  return lines;
}
