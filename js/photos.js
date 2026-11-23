// Encrypted photo storage, kept OUT of the main vault blob.
//
// Document/inventory photos used to live inside the one encrypted vault JSON, so
// every save re-encrypted every image. Now each photo is encrypted on its own
// (AES-256-GCM, with the vault's stable "media key") and stored in IndexedDB,
// which handles binary well. The vault only keeps a small photo id reference,
// so everyday saves stay instant no matter how many photos you have.

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function encryptPhoto(dataUrl, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(dataUrl));
  return { iv, ct };
}
export async function decryptPhoto(blob, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, blob.ct);
  return dec.decode(pt);
}

// ---- IndexedDB (browser only) ----
const DB_NAME = 'evergreen-media';
const STORE = 'photos';
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function idb(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export async function savePhoto(id, dataUrl, key) {
  const blob = await encryptPhoto(dataUrl, key);
  await idb('readwrite', (s) => s.put(blob, id));
}
export async function loadPhoto(id, key) {
  const blob = await idb('readonly', (s) => s.get(id));
  if (!blob) return null;
  try {
    return await decryptPhoto(blob, key);
  } catch {
    return null;
  }
}
export async function deletePhoto(id) {
  if (!id) return;
  await idb('readwrite', (s) => s.delete(id)).catch(() => {});
}

// ---- backup bundling (photos are already ciphertext) ----
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

export async function exportAllPhotos() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = {};
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        out[cur.key] = { iv: toB64(cur.value.iv), ct: toB64(cur.value.ct) };
        cur.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}
export async function importAllPhotos(obj) {
  for (const [id, v] of Object.entries(obj || {})) {
    await idb('readwrite', (s) => s.put({ iv: fromB64(v.iv), ct: fromB64(v.ct) }, id));
  }
}
