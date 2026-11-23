// Fingerprint / face unlock, built so it can never lock you out.
//
// Your passphrase is always the fallback. When you enable biometrics, we ask
// your phone's secure hardware (WebAuthn + the PRF extension) for a stable
// secret, use it to encrypt your passphrase, and store only that ciphertext.
// On unlock, a successful fingerprint/face check reproduces the secret, which
// decrypts the passphrase and opens the vault. If anything is unsupported or
// fails, nothing is lost — you just type your passphrase as usual.

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const BIO_KEY = 'mylife-biometric';

/** Encrypt the passphrase under a raw key (the hardware secret). Testable. */
export async function wrapSecret(passphrase, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(passphrase));
  return { iv: toB64(iv), ct: toB64(ct) };
}
export async function unwrapSecret(blob, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return dec.decode(pt);
}

export function biometricConfigured(storage = globalThis.localStorage) {
  try {
    return Boolean(storage.getItem(BIO_KEY));
  } catch {
    return false;
  }
}

export function disableBiometric(storage = globalThis.localStorage) {
  try {
    storage.removeItem(BIO_KEY);
  } catch {
    /* ignore */
  }
}

/** Does this device have a usable platform authenticator (fingerprint/face)? */
export async function biometricAvailable() {
  try {
    if (!globalThis.PublicKeyCredential) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Register the device and store the passphrase wrapped by the hardware secret. */
export async function enableBiometric(passphrase, storage = globalThis.localStorage) {
  const prfSalt = rand(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { name: 'My Life', id: location.hostname },
      user: { id: rand(16), name: 'my-life', displayName: 'My Life' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  const credId = new Uint8Array(cred.rawId);
  // The PRF value usually comes from a follow-up get(), not from create().
  let rawKey = cred.getClientExtensionResults?.().prf?.results?.first;
  if (!rawKey) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ id: credId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    rawKey = assertion.getClientExtensionResults().prf?.results?.first;
  }
  if (!rawKey) throw new Error('This phone does not support fingerprint unlock for web apps. Your passphrase still works.');
  const wrapped = await wrapSecret(passphrase, new Uint8Array(rawKey));
  storage.setItem(BIO_KEY, JSON.stringify({ credId: toB64(credId), prfSalt: toB64(prfSalt), wrapped }));
}

/** Prompt for fingerprint/face and return the decrypted passphrase. */
export async function unlockBiometric(storage = globalThis.localStorage) {
  const data = JSON.parse(storage.getItem(BIO_KEY));
  if (!data) throw new Error('Fingerprint unlock is not set up.');
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ id: fromB64(data.credId), type: 'public-key' }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: fromB64(data.prfSalt) } } },
    },
  });
  const rawKey = assertion.getClientExtensionResults().prf?.results?.first;
  if (!rawKey) throw new Error('Fingerprint unlock failed. Please use your passphrase.');
  return unwrapSecret(data.wrapped, new Uint8Array(rawKey));
}
