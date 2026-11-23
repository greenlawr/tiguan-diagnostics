// End-to-end encryption for the shared Household space.
//
// You and your partner share one secret "household code". From it, both phones
// derive the same encryption key (never sent anywhere) and the same public
// "household id". Shared items are encrypted with the key; the sync server only
// ever stores the ciphertext under the id, so it can never read your data.

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// Human-shareable code: 4 groups of 4 from an unambiguous alphabet.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateHouseholdCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out; // e.g. ABCD-EFGH-JKLM-NPQR
}
export const normalizeCode = (code) => (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Public, non-secret bucket id for the sync server (a hash of the code). */
export async function householdId(code) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode('evergreen-id:' + normalizeCode(code)));
  return toHex(digest).slice(0, 32);
}

/** Secret AES key derived from the code (stays on the device). */
export async function deriveSharedKey(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode('evergreen-key:' + normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
  // A fixed salt so both partners derive the same key from the same code.
  const salt = await crypto.subtle.digest('SHA-256', enc.encode('evergreen-salt:' + normalizeCode(code)));
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptItem(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
export async function decryptItem(blob, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(dec.decode(pt));
}

/**
 * Merge local and remote item maps by last-write-wins per item.
 * Each item: { id, updatedAt, deleted, ...payload }. Returns the merged map.
 */
export function mergeItems(local = {}, remote = {}) {
  const out = { ...local };
  for (const [id, item] of Object.entries(remote)) {
    if (!out[id] || item.updatedAt > out[id].updatedAt) out[id] = item;
  }
  return out;
}
