import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync-worker/worker.js';
import { makeInboxKeys, newInboxId, seal, unseal, inboxAddress, parseInboxAddress } from '../js/inbox.js';
import { householdId, writeToken } from '../js/household.js';

test('sealed messages open only with the inbox private key', async () => {
  const keys = await makeInboxKeys();
  const msg = await seal(keys.publicKey, 'delivery: Veepeak | Amazon | 205-1460974-0605128 | 2026-11-24');
  assert.equal(await unseal(keys.privateJwk, msg), 'delivery: Veepeak | Amazon | 205-1460974-0605128 | 2026-11-24');
  const other = await makeInboxKeys();
  await assert.rejects(() => unseal(other.privateJwk, msg));
  const addr = inboxAddress('https://evergreen-sync.x.workers.dev/', 'a'.repeat(32), keys.publicKey);
  assert.deepEqual(parseInboxAddress(addr), { serverUrl: 'https://evergreen-sync.x.workers.dev', inboxId: 'a'.repeat(32), publicKey: keys.publicKey });
  assert.throws(() => parseInboxAddress('hello'));
});

test('server: drop without the household key, collect and clear only with it', async () => {
  const m = new Map();
  const env = { HOUSEHOLD: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } } };
  const code = 'ABCD-EFGH-JKLM-NPQR'; const hid = await householdId(code); const tok = await writeToken(code);
  const req = (path, init = {}, auth = true) => worker.fetch(new Request('https://w.dev' + path, { ...init, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Evergreen-Token': tok } : {}) } }), env);
  await req('/' + hid, { method: 'POST', body: '{"items":{}}' });
  const keys = await makeInboxKeys(); const id = newInboxId();
  const sealed = await seal(keys.publicKey, 'delivery: Test | DPD | X1 | 2026-11-25');
  assert.equal((await req('/inbox/' + id, { method: 'POST', body: JSON.stringify({ sealed }) }, false)).status, 404, 'not registered yet');
  assert.equal((await req(`/inbox/register?h=${hid}`, { method: 'POST', body: JSON.stringify({ inboxId: id }) }, false)).status, 401);
  assert.equal((await req(`/inbox/register?h=${hid}`, { method: 'POST', body: JSON.stringify({ inboxId: id }) })).status, 200);
  assert.equal((await req('/inbox/' + id, { method: 'POST', body: JSON.stringify({ sealed }) }, false)).status, 200, 'the morning check needs no household key');
  assert.equal((await req('/inbox/' + id, { method: 'POST', body: JSON.stringify({ sealed: 'plain text!' }) }, false)).status, 400);
  assert.equal((await req(`/inbox/list?h=${hid}`, {}, false)).status, 401, 'reading needs the key');
  const { messages } = await (await req(`/inbox/list?h=${hid}`)).json();
  assert.equal(messages.length, 1);
  assert.equal(await unseal(keys.privateJwk, messages[0].sealed), 'delivery: Test | DPD | X1 | 2026-11-25');
  assert.ok(![...m.values()].join('').includes('DPD'), 'server holds ciphertext only');
  await req(`/inbox/ack?h=${hid}`, { method: 'POST', body: JSON.stringify({ ids: [messages[0].id] }) });
  assert.equal((await (await req(`/inbox/list?h=${hid}`)).json()).messages.length, 0);
  // re-registering a new inbox retires the old id
  const id2 = newInboxId();
  await req(`/inbox/register?h=${hid}`, { method: 'POST', body: JSON.stringify({ inboxId: id2 }) });
  assert.equal((await req('/inbox/' + id, { method: 'POST', body: JSON.stringify({ sealed }) }, false)).status, 404);
});
