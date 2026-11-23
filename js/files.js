// Encrypted document/file attachments (PDFs, scans, photos of letters...).
//
// Two kinds:
// - Shared files: encrypted on the phone with the household key, then uploaded
//   to the sync server under a random id. The server never sees the file's
//   name, type or contents — those live in the caller's (encrypted) shared item.
//   Once opened, the still-encrypted bytes are cached so the file works offline.
// - Private files: this phone only, encrypted with the vault's media key and
//   kept in IndexedDB, and included in backups (like photos.js).
//
// Every file is AES-256-GCM with a random 12-byte IV in front of the
// ciphertext, and its id bound in as "additional data" so one encrypted file
// can't be swapped in for another.

import { householdId, deriveSharedKey, writeToken } from './household.js';

const enc = new TextEncoder();
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // before encryption

// ---- encryption ----
export async function encryptBytes(arrayBuffer, aesKey, blobId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(blobId) }, aesKey, arrayBuffer);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out.buffer;
}
export async function decryptBytes(arrayBuffer, aesKey, blobId) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength < 12 + 16) throw new Error('This file is damaged and can\'t be opened.');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(blobId) }, aesKey, bytes.subarray(12));
}

// Random lowercase id (20 chars from a-z0-9), safe for the server's id rule.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newBlobId(length = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = '';
  // Reject bytes that would bias the pick (252 = 7 * 36).
  for (let i = 0; i < bytes.length && out.length < length; i++) if (bytes[i] < 252) out += ID_CHARS[bytes[i] % 36];
  return out.length === length ? out : newBlobId(length);
}

/** Returns null if the file is fine to store, or a friendly error. */
export function checkFileSize(file) {
  const size = file && typeof file.size === 'number' ? file.size : 0;
  if (!size) return 'That file looks empty — please choose another.';
  if (size > MAX_FILE_BYTES) {
    return `That file is ${(size / 1024 / 1024).toFixed(1)} MB — the most Evergreen can store is 10 MB. Try a smaller scan, or save it as a lower-quality PDF.`;
  }
  return null;
}

// ---- IndexedDB (browser only; absent in Node) ----
const DB_NAME = 'evergreen-files';
const hasIDB = () => typeof indexedDB !== 'undefined';
let dbPromise = null;
function openDB() {
  if (!hasIDB()) return Promise.reject(new Error('File storage isn\'t available on this device.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of ['shared', 'private']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function idb(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}
// The offline cache is a nice-to-have: never let it break an upload or download.
const cacheGet = (id) => (hasIDB() ? idb('shared', 'readonly', (s) => s.get(id)).catch(() => null) : Promise.resolve(null));
const cachePut = (id, bytes) => (hasIDB() ? idb('shared', 'readwrite', (s) => s.put(bytes, id)).catch(() => {}) : Promise.resolve());
const cacheDelete = (id) => (hasIDB() ? idb('shared', 'readwrite', (s) => s.delete(id)).catch(() => {}) : Promise.resolve());

// ---- shared files (via the sync server) ----
const keyCache = new Map(); // code -> { hid, key, token }; PBKDF2 is slow, so derive once
async function household(code) {
  if (!keyCache.has(code)) {
    keyCache.set(code, Promise.all([householdId(code), deriveSharedKey(code), writeToken(code)]).then(([hid, key, token]) => ({ hid, key, token })));
  }
  return keyCache.get(code);
}
const blobUrl = (serverUrl, hid, blobId) => `${serverUrl.replace(/\/+$/, '')}/blob?h=${hid}&id=${blobId}`;
async function serverError(res, action) {
  let msg = '';
  try { msg = (await res.json()).error || ''; } catch {}
  if (res.status === 413) return new Error(msg || 'There isn\'t enough shared file space for this file.');
  if (res.status === 401) return new Error('This phone isn\'t allowed to change the shared space — check the household code.');
  if (res.status === 410) return new Error('This shared space has been retired.');
  if (res.status === 403) return new Error('The shared space isn\'t set up yet — sync once first.');
  return new Error(`Couldn't ${action} the file (server returned ${res.status}${msg ? ': ' + msg : ''}).`);
}

/** Encrypts and uploads a file; returns the details to keep in the (encrypted) shared item. */
export async function uploadSharedFile({ serverUrl, code, file, fetchImpl = fetch }) {
  const problem = checkFileSize(file);
  if (problem) throw new Error(problem);
  const { hid, key, token } = await household(code);
  const blobId = newBlobId();
  const ct = await encryptBytes(await file.arrayBuffer(), key, blobId);
  const res = await fetchImpl(blobUrl(serverUrl, hid, blobId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Evergreen-Token': token },
    body: ct,
  });
  if (!res.ok) throw await serverError(res, 'upload');
  await cachePut(blobId, ct); // the uploader can open it offline straight away
  return { blobId, name: file.name || 'File', type: file.type || 'application/octet-stream', size: file.size, addedAt: Date.now() };
}

/** Fetches (or reads from the offline cache) and decrypts a shared file. */
export async function downloadSharedFile({ serverUrl, code, blobId, type = 'application/octet-stream', fetchImpl = fetch }) {
  const { hid, key, token } = await household(code);
  let ct = await cacheGet(blobId);
  if (!ct) {
    let res;
    try {
      res = await fetchImpl(blobUrl(serverUrl, hid, blobId), { headers: { 'X-Evergreen-Token': token } });
    } catch {
      throw new Error('You\'re offline and this file hasn\'t been opened on this phone before.');
    }
    if (res.status === 404) throw new Error('This file is no longer on the server — it may have been deleted.');
    if (!res.ok) throw await serverError(res, 'download');
    ct = await res.arrayBuffer();
    await cachePut(blobId, ct);
  }
  let pt;
  try {
    pt = await decryptBytes(ct, key, blobId);
  } catch {
    await cacheDelete(blobId);
    throw new Error('This file couldn\'t be unlocked — it may be from a different household.');
  }
  return new Blob([pt], { type });
}

export async function deleteSharedFile({ serverUrl, code, blobId, fetchImpl = fetch }) {
  const { hid, token } = await household(code);
  const res = await fetchImpl(blobUrl(serverUrl, hid, blobId), { method: 'DELETE', headers: { 'X-Evergreen-Token': token } });
  if (!res.ok && res.status !== 404) throw await serverError(res, 'delete');
  await cacheDelete(blobId);
}

// ---- private files (this phone only) ----
export async function savePrivateFile(file, mediaKey) {
  const problem = checkFileSize(file);
  if (problem) throw new Error(problem);
  const fileId = newBlobId();
  const ct = await encryptBytes(await file.arrayBuffer(), mediaKey, fileId);
  await idb('private', 'readwrite', (s) => s.put(ct, fileId));
  return { fileId, name: file.name || 'File', type: file.type || 'application/octet-stream', size: file.size, addedAt: Date.now(), local: true };
}
/** Returns the decrypted Blob, or null if it's missing or can't be unlocked. */
export async function loadPrivateFile(fileId, mediaKey, type = 'application/octet-stream') {
  const ct = await idb('private', 'readonly', (s) => s.get(fileId));
  if (!ct) return null;
  try {
    return new Blob([await decryptBytes(ct, mediaKey, fileId)], { type });
  } catch {
    return null;
  }
}
export async function deletePrivateFile(fileId) {
  if (!fileId || !hasIDB()) return;
  await idb('private', 'readwrite', (s) => s.delete(fileId)).catch(() => {});
}

// ---- backup bundling (private files are already ciphertext) ----
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)).buffer;

/** { fileId: base64 ciphertext } for every private file on this phone. */
export async function exportPrivateFiles() {
  if (!hasIDB()) return {};
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = {};
    const req = db.transaction('private', 'readonly').objectStore('private').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        out[cur.key] = toB64(cur.value);
        cur.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}
export async function importPrivateFiles(obj) {
  for (const [id, b64] of Object.entries(obj || {})) {
    if (typeof b64 === 'string') await idb('private', 'readwrite', (s) => s.put(fromB64(b64), id));
  }
}
