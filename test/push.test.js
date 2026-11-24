import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync-worker/worker.js';
import { encryptPush, b64u, fromB64u, pushEndpointOk, vapidKeys } from '../sync-worker/push.js';
import { householdId, writeToken } from '../js/household.js';

const enc = new TextEncoder();
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));

// What the phone's browser does on receipt (RFC 8291), to prove the message is readable only by it.
async function phone() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64u(pub), auth: b64u(auth) },
    async decrypt(body) {
      const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
      const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
      const ikm = await hmac(await hmac(auth, ecdh), concat(enc.encode('WebPush: info\0'), pub, asPublic, new Uint8Array([1])));
      const prk = await hmac(salt, ikm);
      const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
      const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
      assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
      return new TextDecoder().decode(pt.slice(0, -1));
    },
  };
}

test('push messages are encrypted so only the phone can read them', async () => {
  const p = await phone();
  const body = await encryptPush('{"title":"Evergreen","body":"Jess added 2 things"}', p.keys.p256dh, p.keys.auth);
  assert.equal(JSON.parse(await p.decrypt(body)).body, 'Jess added 2 things');
  const other = await phone();
  await assert.rejects(() => other.decrypt(body));
});

test('only real push services can be reached', () => {
  assert.ok(pushEndpointOk('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(pushEndpointOk('https://web.push.apple.com/QXz'));
  assert.ok(!pushEndpointOk('https://evil.example.com/x'));
  assert.ok(!pushEndpointOk('http://fcm.googleapis.com/x'));
});

test('subscribe, then the OTHER phone is told when something is added (and nothing else is sent)', async () => {
  const m = new Map();
  const env = { HOUSEHOLD: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } } };
  const code = 'ABCD-EFGH-JKLM-NPQR'; const hid = await householdId(code); const tok = await writeToken(code);
  const req = (path, init = {}) => worker.fetch(new Request('https://w.dev' + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': tok, ...(init.headers || {}) } }), env);
  await req('/' + hid, { method: 'POST', body: '{"items":{}}' });
  const key = await (await req(`/push/key?h=${hid}`)).json();
  assert.equal(fromB64u(key.publicKey).length, 65, 'VAPID public key');
  assert.equal((await vapidKeys(env)).publicKey, key.publicKey, 'kept, not remade');
  const lawrence = await phone(), jess = await phone();
  for (const [device, label, p] of [['dlawrence1', 'Jess', lawrence], ['djess00001', 'Lawrence', jess]]) {
    const r = await req(`/push/subscribe?h=${hid}`, { method: 'POST', body: JSON.stringify({ device, label, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + device, keys: p.keys } }) });
    assert.equal(r.status, 200);
  }
  assert.equal((await req(`/push/subscribe?h=${hid}`, { method: 'POST', body: JSON.stringify({ device: 'dxxxxxxx', sub: { endpoint: 'https://evil.example.com/', keys: lawrence.keys } }) })).status, 400);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response(null, { status: 201 }); };
  try {
    // Jess's phone adds two things
    await req('/' + hid, { method: 'POST', headers: { 'X-Evergreen-Device': 'djess00001', 'X-Evergreen-Notify': '2' }, body: JSON.stringify({ items: { a: { iv: 'x', ct: 'y', updatedAt: Date.now() } } }) });
    assert.equal(sent.length, 1, 'only Lawrence is notified');
    assert.match(sent[0].url, /dlawrence1$/);
    assert.match(sent[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(JSON.parse(await lawrence.decrypt(new Uint8Array(sent[0].init.body))).body, 'Jess added 2 things — tap to see');
    // a calendar refresh (nothing "added") or a repeat with no change → no notification
    await req('/' + hid, { method: 'POST', headers: { 'X-Evergreen-Device': 'djess00001' }, body: JSON.stringify({ items: { b: { iv: 'x', ct: 'y', updatedAt: Date.now() } } }) });
    await req('/' + hid, { method: 'POST', headers: { 'X-Evergreen-Device': 'djess00001', 'X-Evergreen-Notify': '1' }, body: JSON.stringify({ items: {} }) });
    assert.equal(sent.length, 1);
    // an expired subscription is dropped
    globalThis.fetch = async () => new Response(null, { status: 410 });
    await req('/' + hid, { method: 'POST', headers: { 'X-Evergreen-Device': 'djess00001', 'X-Evergreen-Notify': '1' }, body: JSON.stringify({ items: { c: { iv: 'x', ct: 'y', updatedAt: Date.now() } } }) });
    assert.deepEqual(JSON.parse(m.get('push:' + hid)).map((p) => p.device), ['djess00001']);
  } finally { globalThis.fetch = realFetch; }
});
