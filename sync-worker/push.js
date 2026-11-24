// Web Push for Evergreen: "Jess added 3 things" on the other phone, even when
// the app is closed. The server never knows WHAT was added (it only holds
// ciphertext) — just that something changed and from which phone.
//
// No setup: the server makes its own VAPID key pair the first time and keeps
// it in KV (the private half never leaves your Cloudflare account).
// Standards: RFC 8291 (message encryption, aes128gcm) and RFC 8292 (VAPID).

const enc = new TextEncoder();
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Push services phones actually use (no other hosts can be reached through here).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^web\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
export function pushEndpointOk(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

/** The server's VAPID keys: made once, kept in KV. */
export async function vapidKeys(env) {
  const stored = await env.HOUSEHOLD.get('vapid');
  if (stored) {
    const { publicKey, jwk } = JSON.parse(stored);
    return { publicKey, privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await env.HOUSEHOLD.put('vapid', JSON.stringify({ publicKey, jwk }));
  return { publicKey, privateKey: pair.privateKey };
}
async function vapidAuth(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://greenlawr.github.io/tiguan-diagnostics/' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(header + '.' + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291: encrypt a message so only that phone can read it. */
export async function encryptPush(payload, p256dhB64u, authB64u) {
  const uaPublic = fromB64u(p256dhB64u), authSecret = fromB64u(authB64u);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic); // record size 4096
  return concat(header, ct);
}

export async function sendPush(env, sub, message, fetchImpl = fetch) {
  if (!pushEndpointOk(sub.endpoint)) return { gone: true };
  const keys = await vapidKeys(env);
  const body = await encryptPush(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth);
  const r = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidAuth(sub.endpoint, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Topic: 'evergreen-partner' },
    body,
  });
  return { status: r.status, gone: r.status === 404 || r.status === 410 };
}

// ---- subscriptions, per household: [{ device, label, sub }] ----
const listKey = (hid) => 'push:' + hid;
export async function pushList(env, hid) { try { return JSON.parse((await env.HOUSEHOLD.get(listKey(hid))) || '[]'); } catch { return []; } }

/** Tell every other phone in the household that something changed. */
export async function notifyOthers(env, hid, fromDevice, { added, changed }, fetchImpl = fetch) {
  const list = await pushList(env, hid);
  const targets = list.filter((p) => p.device !== fromDevice);
  if (!targets.length) return 0;
  let gone = [];
  await Promise.all(targets.map(async (p) => {
    const who = p.label || 'Your partner';
    const body = added ? `${who} added ${added === 1 ? 'something' : added + ' things'} — tap to see` : `${who} updated ${changed === 1 ? 'something' : changed + ' things'} — tap to see`;
    try { const r = await sendPush(env, p.sub, { title: 'Evergreen', body }, fetchImpl); if (r.gone) gone.push(p.device); } catch { /* try next time */ }
  }));
  if (gone.length) await env.HOUSEHOLD.put(listKey(hid), JSON.stringify(list.filter((p) => !gone.includes(p.device))));
  return targets.length - gone.length;
}

/** /push/key, /push/subscribe, /push/unsubscribe (caller checks the household key). */
export async function handlePush(request, env, hid, action) {
  if (action === 'key') return { body: { publicKey: (await vapidKeys(env)).publicKey } };
  let body;
  try { body = await request.json(); } catch { return { status: 400, body: { error: 'bad body' } }; }
  const device = String(body.device || '');
  if (!/^[a-z0-9]{6,40}$/.test(device)) return { status: 400, body: { error: 'bad device' } };
  const list = (await pushList(env, hid)).filter((p) => p.device !== device);
  if (action === 'subscribe') {
    const sub = body.sub || {};
    if (!pushEndpointOk(sub.endpoint) || !sub.keys || !/^[A-Za-z0-9_-]{80,100}$/.test(sub.keys.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(sub.keys.auth || '')) return { status: 400, body: { error: 'bad subscription' } };
    list.push({ device, label: String(body.label || '').slice(0, 30), sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
    if (list.length > 6) list.splice(0, list.length - 6);
  }
  await env.HOUSEHOLD.put(listKey(hid), JSON.stringify(list));
  return { body: { ok: true, phones: list.length } };
}
