import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVerifier, checkVerifier } from '../js/lost.js';
import worker from '../sync-worker/worker.js';

test('passphrase verifier accepts the right passphrase and rejects others', async () => {
  const v = await makeVerifier('correct horse battery', 2000); // low iterations just for the test
  assert.equal(v.iter, 2000);
  assert.ok(!JSON.stringify(v).includes('correct horse'));
  assert.equal(await checkVerifier('correct horse battery', v), true);
  assert.equal(await checkVerifier('correct horse batterY', v), false);
  assert.equal(await checkVerifier('', v), false);
  assert.equal(await checkVerifier('x', null), false);
});

test('verifiers for the same passphrase differ (random salt)', async () => {
  const a = await makeVerifier('same', 1000);
  const b = await makeVerifier('same', 1000);
  assert.notEqual(a.hash, b.hash);
});

// ---- sync server: retiring a household when a phone is reported lost
function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const HID = 'aaaaaaaaaaaaaaaa1111';
const call = async (env, method, path, body) => {
  const r = await worker.fetch(new Request('https://w.dev' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json() };
};

test('retire: deletes the shared data, flags the lost phone, and blocks the old space', async () => {
  const env = { HOUSEHOLD: kv() };
  await call(env, 'POST', '/' + HID, { items: { a: { iv: 'x', ct: 'y', updatedAt: 1 } } });
  assert.deepEqual((await call(env, 'GET', `/status?h=${HID}&d=lostphone01`)).body, { retired: false });

  const r = await call(env, 'POST', `/retire?h=${HID}`, { wipe: ['lostphone01'] });
  assert.equal(r.status, 200);
  assert.equal(env.HOUSEHOLD.m.has(HID), false, 'shared data deleted');

  assert.deepEqual((await call(env, 'GET', `/status?h=${HID}&d=lostphone01`)).body, { retired: true, wipe: true });
  assert.deepEqual((await call(env, 'GET', `/status?h=${HID}&d=otherphone99`)).body, { retired: true, wipe: false });

  // The lost phone can't read or re-upload data to the old space.
  assert.equal((await call(env, 'GET', '/' + HID)).status, 410);
  assert.equal((await call(env, 'POST', '/' + HID, { items: { b: { iv: 'x', ct: 'y', updatedAt: 2 } } })).status, 410);
  assert.equal(env.HOUSEHOLD.m.has(HID), false);
});

test('retire: rejects unknown households and malformed requests', async () => {
  const env = { HOUSEHOLD: kv() };
  assert.equal((await call(env, 'POST', `/retire?h=${HID}`, { wipe: ['lostphone01'] })).status, 404);
  await call(env, 'POST', '/' + HID, { items: {} });
  assert.equal((await call(env, 'POST', `/retire?h=${HID}`, { wipe: ['bad id!'] })).status, 400);
  assert.equal((await call(env, 'POST', `/retire?h=nothex`, { wipe: ['lostphone01'] })).status, 400);
  assert.equal((await call(env, 'GET', `/status?h=${HID}`)).status, 200);
});
