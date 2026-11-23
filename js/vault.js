// Encrypted on-device vault.
//
// All of the app's saved data is held in memory while unlocked and written to
// localStorage only as AES-256-GCM ciphertext. The key is derived from the
// user's passphrase with PBKDF2 and never stored anywhere — so without the
// passphrase the stored blob is unreadable, and there is no way to recover it.
// Everything here runs in the browser (or Node's WebCrypto); nothing is sent
// anywhere.

const ITERATIONS = 250000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt an object into a self-describing blob (safe to store or back up). */
export async function encryptJSON(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  return encryptWithKey(key, obj, salt);
}

async function encryptWithKey(key, obj, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, app: 'my-life', iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypt a blob. Throws if the passphrase is wrong or the data is corrupt. */
export async function decryptJSON(blob, passphrase) {
  const key = await deriveKey(passphrase, fromB64(blob.salt), blob.iter || ITERATIONS);
  return decryptWithKey(key, blob);
}

async function decryptWithKey(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(dec.decode(pt));
}

const STORAGE_KEY = 'mylife-vault';

/** Stateful vault bound to localStorage; keeps the derived key in memory while unlocked. */
export class Vault {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  exists() {
    try {
      return Boolean(this.storage.getItem(STORAGE_KEY));
    } catch {
      return false;
    }
  }

  get locked() {
    return this.key === null;
  }

  _readBlob() {
    return JSON.parse(this.storage.getItem(STORAGE_KEY));
  }

  /** Create a brand-new vault, optionally seeded with existing (plaintext) data. */
  async setup(passphrase, seed = {}) {
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(passphrase, this.salt);
    this.data = seed;
    await this._persist();
  }

  /** Unlock an existing vault. Throws on a wrong passphrase. */
  async unlock(passphrase) {
    const blob = this._readBlob();
    if (!blob) throw new Error('No vault set up yet.');
    this.salt = fromB64(blob.salt);
    this.key = await deriveKey(passphrase, this.salt, blob.iter || ITERATIONS);
    try {
      this.data = await decryptWithKey(this.key, blob);
    } catch {
      this.key = null;
      this.data = null;
      throw new Error('Wrong passphrase.');
    }
  }

  lock() {
    this.key = null;
    this.data = null;
  }

  /** Check a passphrase without changing the unlocked state. */
  async verify(passphrase) {
    try {
      const blob = this._readBlob();
      if (!blob) return false;
      const key = await deriveKey(passphrase, fromB64(blob.salt), blob.iter || ITERATIONS);
      await decryptWithKey(key, blob);
      return true;
    } catch {
      return false;
    }
  }

  get(collection, fallback) {
    if (this.locked) return fallback;
    return collection in this.data ? this.data[collection] : fallback;
  }

  /**
   * A stable AES key for encrypting large media (photos) stored outside the
   * vault blob. It lives inside the vault data, so it is protected by the
   * passphrase and survives passphrase changes and backup/restore.
   */
  async mediaKey() {
    if (this.locked) throw new Error('Vault is locked.');
    if (!this.data._mediaKey) {
      this.data._mediaKey = toB64(crypto.getRandomValues(new Uint8Array(32)));
      await this._persist();
    }
    return crypto.subtle.importKey('raw', fromB64(this.data._mediaKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async set(collection, value) {
    if (this.locked) throw new Error('Vault is locked.');
    this.data[collection] = value;
    await this._persist();
  }

  async _persist() {
    const blob = await encryptWithKey(this.key, this.data, this.salt);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(blob));
  }

  /** The encrypted blob, for the user to download as a backup. */
  backupBlob() {
    return this._readBlob();
  }

  /** Restore from a backup file, verifying the passphrase first. */
  async restore(blob, passphrase) {
    const data = await decryptJSON(blob, passphrase); // throws if wrong
    this.storage.setItem(STORAGE_KEY, JSON.stringify(blob));
    this.salt = fromB64(blob.salt);
    this.key = await deriveKey(passphrase, this.salt, blob.iter || ITERATIONS);
    this.data = data;
  }

  /** Permanently delete the vault (e.g. forgotten passphrase). Irreversible. */
  destroy() {
    this.storage.removeItem(STORAGE_KEY);
    this.lock();
  }
}
