import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync-worker/worker.js';
import { householdId, writeToken } from '../js/household.js';
import { encryptBytes, decryptBytes, newBlobId, checkFileSize, uploadSharedFile, downloadSharedFile, deleteSharedFile } from '../js/files.js';

// In-memory KV that, like real KV, can hand values back as an ArrayBuffer.
function kv() {
  const m = new Map();
  return {
    m,
    get: async (k, type) => {
      if (!m.has(k)) return null;
      const v = m.get(k);
      if (type === 'arrayBuffer') return v instanceof ArrayBuffer ? v.slice(0) : new TextEncoder().encode(v).buffer;
      return v instanceof ArrayBuffer ? new TextDecoder().decode(v) : v;
    },
    put: async (k, v) => { m.set(k, v instanceof ArrayBuffer ? v.slice(0) : ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v); },
    delete: async (k) => { m.delete(k); },
  };
}
const aesKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const SERVER = 'https://w.dev';

// Calls the real worker in-process instead of the network.
const viaWorker = (env) => (url, init = {}) => worker.fetch(new Request(url, init), env);

async function setup() {
  const env = { HOUSEHOLD: kv() };
  const hid = await householdId(CODE);
  const token = await writeToken(CODE);
  // Create the household (and register the write key) with an ordinary sync.
  await worker.fetch(new Request(`${SERVER}/${hid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': token }, body: '{"items":{}}' }), env);
  const blob = (method, id, body, tok = token) => worker.fetch(new Request(`${SERVER}/blob?h=${hid}&id=${id}`, { method, headers: tok ? { 'X-Evergreen-Token': tok } : {}, body }), env);
  return { env, hid, token, blob };
}

test('encryptBytes/decryptBytes round trip, with a fresh IV each time', async () => {
  const key = await aesKey();
  const data = crypto.getRandomValues(new Uint8Array(5000));
  const a = await encryptBytes(data.buffer, key, 'blob00001');
  const b = await encryptBytes(data.buffer, key, 'blob00001');
  assert.equal(a.byteLength, 12 + 5000 + 16);
  assert.notDeepEqual(new Uint8Array(a).slice(0, 12), new Uint8Array(b).slice(0, 12));
  assert.deepEqual(new Uint8Array(await decryptBytes(a, key, 'blob00001')), data);
});

test('decryptBytes fails with the wrong file id or the wrong key', async () => {
  const key = await aesKey();
  const ct = await encryptBytes(new TextEncoder().encode('council tax bill').buffer, key, 'idnumberone');
  await assert.rejects(decryptBytes(ct, key, 'idnumbertwo'));
  await assert.rejects(decryptBytes(ct, await aesKey(), 'idnumberone'));
  await assert.rejects(decryptBytes(new ArrayBuffer(10), key, 'idnumberone'));
});

test('newBlobId is ~20 random lowercase letters/digits', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newBlobId();
    assert.match(id, /^[a-z0-9]{20}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('checkFileSize allows up to 10 MB', () => {
  assert.equal(checkFileSize({ size: 1000 }), null);
  assert.equal(checkFileSize({ size: 10 * 1024 * 1024 }), null);
  assert.match(checkFileSize({ size: 10 * 1024 * 1024 + 1 }), /10 MB/);
  assert.match(checkFileSize({ size: 0 }), /empty/);
});

test('worker blobs: put, get, overwrite, delete keep the quota right', async () => {
  const { env, hid, blob } = await setup();
  const quota = () => Number(env.HOUSEHOLD.m.get('blobquota:' + hid));
  const index = () => JSON.parse(env.HOUSEHOLD.m.get('blobindex:' + hid));

  assert.equal((await blob('PUT', 'fileaaaa1', new Uint8Array(100))).status, 200);
  assert.equal((await blob('PUT', 'filebbbb2', new Uint8Array(50))).status, 200);
  assert.equal(quota(), 150);
  assert.deepEqual(index(), ['fileaaaa1', 'filebbbb2']);

  const got = await blob('GET', 'fileaaaa1');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(got.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await got.arrayBuffer()).byteLength, 100);

  // Overwriting replaces the old size rather than adding to it.
  assert.equal((await blob('PUT', 'fileaaaa1', new Uint8Array(30))).status, 200);
  assert.equal(quota(), 80);
  assert.deepEqual(index(), ['fileaaaa1', 'filebbbb2']);

  assert.equal((await blob('DELETE', 'filebbbb2')).status, 200);
  assert.equal(quota(), 30);
  assert.deepEqual(index(), ['fileaaaa1']);
  assert.equal((await blob('GET', 'filebbbb2')).status, 404);
  assert.equal((await blob('DELETE', 'filebbbb2')).status, 200, 'deleting twice is harmless');
  assert.equal(quota(), 30);
});

test('worker blobs: auth, ids, unknown households and CORS', async () => {
  const { env, blob } = await setup();
  assert.equal((await blob('PUT', 'fileaaaa1', new Uint8Array(10), null)).status, 401, 'no key');
  assert.equal((await blob('GET', 'fileaaaa1', undefined, 'f'.repeat(64))).status, 401, 'wrong key');
  assert.equal((await blob('PUT', 'Bad-Id!', new Uint8Array(10))).status, 400);
  assert.equal((await blob('PUT', 'short', new Uint8Array(10))).status, 400);
  assert.equal((await blob('PUT', 'fileaaaa1', new Uint8Array(0))).status, 400, 'empty body');
  const other = await worker.fetch(new Request(`${SERVER}/blob?h=${'b'.repeat(32)}&id=fileaaaa1`, { method: 'PUT', body: new Uint8Array(10) }), env);
  assert.equal(other.status, 403, 'household must exist');
  const pre = await worker.fetch(new Request(`${SERVER}/blob`, { method: 'OPTIONS' }), env);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /PUT/);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /DELETE/);
});

test('worker blobs: 12 MB per file and 250 MB per household', async () => {
  const { env, hid, blob } = await setup();
  const big = await blob('PUT', 'toobig001', new Uint8Array(12 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /12 MB/);
  assert.equal(env.HOUSEHOLD.m.has(`blob:${hid}:toobig001`), false);

  // Pretend the household has nearly filled its space.
  env.HOUSEHOLD.m.set('blobquota:' + hid, String(250 * 1024 * 1024 - 100));
  assert.equal((await blob('PUT', 'fits00001', new Uint8Array(100))).status, 200);
  const full = await blob('PUT', 'nofit0001', new Uint8Array(1));
  assert.equal(full.status, 413);
  assert.match((await full.json()).error, /250 MB/);
  // Shrinking an existing file is still allowed when full.
  assert.equal((await blob('PUT', 'fits00001', new Uint8Array(40))).status, 200);
  assert.equal(Number(env.HOUSEHOLD.m.get('blobquota:' + hid)), 250 * 1024 * 1024 - 60);
});

test('worker blobs: retiring a household deletes its files', async () => {
  const { env, hid, token, blob } = await setup();
  await blob('PUT', 'fileaaaa1', new Uint8Array(10));
  await blob('PUT', 'filebbbb2', new Uint8Array(10));
  const r = await worker.fetch(new Request(`${SERVER}/retire?h=${hid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': token }, body: JSON.stringify({ wipe: ['lostphone01'] }) }), env);
  assert.equal(r.status, 200);
  for (const k of env.HOUSEHOLD.m.keys()) assert.ok(!k.startsWith('blob'), `left behind: ${k}`);
  assert.equal((await blob('GET', 'fileaaaa1')).status, 410);
});

test('shared files end to end: upload, download, delete through the real worker', async () => {
  const { env, hid } = await setup();
  const fetchImpl = viaWorker(env);
  const text = 'Home insurance policy — renewal 1 March';
  const file = new File([text], 'Insurance policy.pdf', { type: 'application/pdf' });

  const meta = await uploadSharedFile({ serverUrl: SERVER + '/', code: CODE, file, fetchImpl });
  assert.match(meta.blobId, /^[a-z0-9]{20}$/);
  assert.equal(meta.name, 'Insurance policy.pdf');
  assert.equal(meta.type, 'application/pdf');
  assert.equal(meta.size, file.size);
  assert.equal(typeof meta.addedAt, 'number');

  // The server holds only ciphertext: no name, no plaintext.
  const stored = env.HOUSEHOLD.m.get(`blob:${hid}:${meta.blobId}`);
  const asText = new TextDecoder().decode(stored);
  assert.ok(!asText.includes('insurance') && !asText.includes('Insurance'));
  for (const v of env.HOUSEHOLD.m.values()) if (typeof v === 'string') assert.ok(!v.includes('Insurance policy'));

  const blob = await downloadSharedFile({ serverUrl: SERVER, code: CODE, blobId: meta.blobId, type: meta.type, fetchImpl });
  assert.equal(blob.type, 'application/pdf');
  assert.equal(await blob.text(), text);

  // A different household can't open it.
  await assert.rejects(downloadSharedFile({ serverUrl: SERVER, code: 'WXYZ-WXYZ-WXYZ-WXYZ', blobId: meta.blobId, fetchImpl }));

  await deleteSharedFile({ serverUrl: SERVER, code: CODE, blobId: meta.blobId, fetchImpl });
  assert.equal(env.HOUSEHOLD.m.has(`blob:${hid}:${meta.blobId}`), false);
  assert.equal(Number(env.HOUSEHOLD.m.get('blobquota:' + hid)), 0);
  await assert.rejects(downloadSharedFile({ serverUrl: SERVER, code: CODE, blobId: meta.blobId, fetchImpl }), /no longer on the server/);
});

test('uploadSharedFile refuses files over 10 MB before sending anything', async () => {
  let called = false;
  const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.pdf');
  await assert.rejects(uploadSharedFile({ serverUrl: SERVER, code: CODE, file, fetchImpl: () => { called = true; } }), /10 MB/);
  assert.equal(called, false);
});
