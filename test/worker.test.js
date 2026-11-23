import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync-worker/worker.js';
import { writeToken, householdId } from '../js/household.js';

function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const req = async (env, method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Evergreen-Token'] = token;
  const r = await worker.fetch(new Request('https://w.dev' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json() };
};
const item = (updatedAt, extra = {}) => ({ iv: 'aaaa', ct: 'bbbb', updatedAt, ...extra });

test('write key: registered by the first phone, then required', async () => {
  const env = { HOUSEHOLD: kv() };
  const code = 'ABCD-EFGH-JKLM-NPQR';
  const hid = await householdId(code);
  const tok = await writeToken(code);
  assert.notEqual(tok.slice(0, 32), hid, 'key is not the public id');
  assert.equal((await req(env, 'POST', '/' + hid, { items: { a: item(1) } }, tok)).status, 200);
  assert.ok(env.HOUSEHOLD.m.get('auth:' + hid) && env.HOUSEHOLD.m.get('auth:' + hid) !== tok, 'only a hash is stored');
  assert.equal((await req(env, 'POST', '/' + hid, { items: { a: item(2, { deleted: true }) } })).status, 401, 'no key');
  assert.equal((await req(env, 'POST', '/' + hid, { items: { a: item(2, { deleted: true }) } }, 'f'.repeat(64))).status, 401, 'wrong key');
  assert.equal((await req(env, 'POST', `/retire?h=${hid}`, { wipe: ['phone123'] })).status, 401, 'retire needs the key');
  assert.equal((await req(env, 'POST', `/retire?h=${hid}`, { wipe: ['phone123'] }, tok)).status, 200);
});

test('a phone with a fast clock cannot pin an item in the future', async () => {
  const env = { HOUSEHOLD: kv() };
  const hid = 'a'.repeat(32);
  const future = Date.now() + 365 * 86400000;
  const r = await req(env, 'POST', '/' + hid, { items: { a: item(future) } });
  assert.ok(r.body.items.a.updatedAt <= Date.now() + 2 * 60000 + 1000);
  await new Promise((r) => setTimeout(r, 10));
  const r2 = await req(env, 'POST', '/' + hid, { items: { a: item(Date.now() + 5 * 60000, { ct: 'newer' }) } });
  assert.equal(r2.body.items.a.ct, 'newer', 'a genuine later edit still wins');
});

test('old deleted markers are dropped; malformed entries are ignored', async () => {
  const env = { HOUSEHOLD: kv() };
  const hid = 'b'.repeat(32);
  const old = Date.now() - 61 * 86400000;
  const r = await req(env, 'POST', '/' + hid, { items: {
    gone: item(old, { deleted: true }), recent: item(Date.now() - 86400000, { deleted: true }),
    live: item(old), bad1: { updatedAt: 5 }, bad2: { iv: 1, ct: 'x', updatedAt: 5 },
  } });
  assert.deepEqual(Object.keys(r.body.items).sort(), ['live', 'recent']);
});
