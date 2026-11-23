// Lost-phone protection helpers.
//
// Each phone stores a one-way "verifier" of its owner's passphrase in the
// shared space (PBKDF2-SHA256 with its own random salt, deliberately slow).
// It cannot be turned back into the passphrase; it only lets the other phone
// check that whoever reports a phone lost knows that phone's passphrase.

const enc = new TextEncoder();
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const VERIFIER_ITERATIONS = 600000;

async function derive(passphrase, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Make a verifier for a passphrase: { salt, hash, iter }. */
export async function makeVerifier(passphrase, iterations = VERIFIER_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toB64(salt), hash: toB64(await derive(passphrase, salt, iterations)), iter: iterations };
}

/** True if `passphrase` matches the verifier. */
export async function checkVerifier(passphrase, v) {
  if (!v || !v.salt || !v.hash) return false;
  const got = await derive(passphrase, fromB64(v.salt), v.iter || VERIFIER_ITERATIONS);
  const want = fromB64(v.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // constant-time compare
  return diff === 0;
}
