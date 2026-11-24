// Evergreen inbox: lets the morning email check drop new parcels straight into
// the app, without a link to tap. Messages are sealed with the household's inbox
// public key (ECDH P-256 + AES-GCM), so your sync server only stores ciphertext,
// and only your phones (which hold the private key, shared end-to-end encrypted)
// can open them. Works in the browser and in Node.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));

export async function makeInboxKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}
export function newInboxId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function aesKey(bits) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([...new Uint8Array(bits), ...enc.encode('evergreen-inbox-v1')]));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/** Seal text so only the holder of the inbox private key can read it. */
export async function seal(publicKeyB64u, text) {
  const them = await crypto.subtle.importKey('raw', fromB64u(publicKeyB64u), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await aesKey(await crypto.subtle.deriveBits({ name: 'ECDH', public: them }, eph.privateKey, 256));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return b64u(new Uint8Array([...ephRaw, ...iv, ...ct]));
}
export async function unseal(privateJwk, sealedB64u) {
  const all = fromB64u(sealedB64u);
  const eph = await crypto.subtle.importKey('raw', all.slice(0, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const key = await aesKey(await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, mine, 256));
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(65, 77) }, key, all.slice(77)));
}
/** The one string you give the morning check: server address + inbox id + public key. */
export const inboxAddress = (serverUrl, inboxId, publicKey) => 'evergreen-inbox:' + b64u(enc.encode(JSON.stringify({ u: serverUrl.replace(/\/+$/, ''), i: inboxId, k: publicKey })));
export function parseInboxAddress(addr) {
  const m = String(addr || '').trim().match(/^evergreen-inbox:([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('not an Evergreen inbox address');
  const j = JSON.parse(dec.decode(fromB64u(m[1])));
  if (!/^https:\/\//.test(j.u) || !/^[a-f0-9]{32}$/.test(j.i) || !j.k) throw new Error('inbox address looks damaged');
  return { serverUrl: j.u, inboxId: j.i, publicKey: j.k };
}
