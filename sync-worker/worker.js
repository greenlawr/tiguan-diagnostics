// Evergreen shared-household sync server (Cloudflare Worker).
//
// Zero-knowledge: it only ever stores and returns ciphertext, keyed by the
// public household id. It cannot read anything you store. Deploy it free on
// Cloudflare and bind a KV namespace called HOUSEHOLD (see README in this folder).

import { handleInfo } from './info.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Evergreen-Token',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const TOMBSTONE_MS = 60 * 86400000; // deleted-item markers are kept 60 days, then dropped
const MAX_CLOCK_AHEAD_MS = 2 * 60000; // a phone's clock can't put an item further in the future than this
const MAX_BLOB_BYTES = 12 * 1024 * 1024; // one encrypted file (the app caps files at 10 MB before encryption)
const MAX_HOUSEHOLD_BLOB_BYTES = 250 * 1024 * 1024; // all of a household's files together

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Write key: the first phone to present one registers it (only its hash is
// stored); after that every write, calendar fetch and retire must present it.
// Phones from before the key existed are let through until one is registered.
async function authorised(request, env, hid) {
  const token = request.headers.get('X-Evergreen-Token') || '';
  const valid = /^[a-f0-9]{64}$/.test(token);
  const stored = await env.HOUSEHOLD.get('auth:' + hid);
  if (stored) return valid && (await sha256hex(token)) === stored;
  if (valid) await env.HOUSEHOLD.put('auth:' + hid, await sha256hex(token));
  return true;
}

// ---------- Car details (DVLA) and MOT history (DVSA) ----------
// Keys live only here, as Cloudflare secrets: DVLA_API_KEY, and MOT_CLIENT_ID,
// MOT_CLIENT_SECRET, MOT_API_KEY, MOT_TOKEN_URL (MOT_SCOPE optional).
async function dvlaLookup(env, reg) {
  if (!env.DVLA_API_KEY) return { configured: false };
  try {
    const r = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST', headers: { 'x-api-key': env.DVLA_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationNumber: reg }),
    });
    if (r.status === 404) return { configured: true, notFound: true };
    if (!r.ok) return { configured: true, error: `DVLA returned ${r.status}` };
    return { configured: true, data: await r.json() };
  } catch (e) { return { configured: true, error: 'DVLA could not be reached' }; }
}
let motToken = null; // reused while this server instance is warm
async function motAccessToken(env) {
  if (motToken && motToken.until > Date.now() + 60000) return motToken.value;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.MOT_CLIENT_ID, client_secret: env.MOT_CLIENT_SECRET, scope: env.MOT_SCOPE || 'https://tapi.dvsa.gov.uk/.default' });
  const r = await fetch(env.MOT_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`MOT sign-in returned ${r.status} — check the MOT client ID, secret and token URL`);
  const j = await r.json();
  motToken = { value: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 };
  return motToken.value;
}
async function motLookup(env, reg) {
  if (!env.MOT_CLIENT_ID || !env.MOT_CLIENT_SECRET || !env.MOT_API_KEY || !env.MOT_TOKEN_URL) return { configured: false };
  try {
    const token = await motAccessToken(env);
    const r = await fetch(`https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(reg)}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-API-Key': env.MOT_API_KEY, Accept: 'application/json' },
    });
    if (r.status === 404) return { configured: true, notFound: true };
    if (!r.ok) return { configured: true, error: `MOT history returned ${r.status}` };
    return { configured: true, data: await r.json() };
  } catch (e) { return { configured: true, error: e.message || 'MOT history could not be reached' }; }
}

// ---------- Shared files (encrypted blobs) ----------
// Phones encrypt each file before upload; the server only sees random ids and
// ciphertext — never names, types or contents. A small index of ids and a byte
// total are kept per household so space can be capped and retired spaces cleaned up.
async function blobIndex(env, hid) {
  try { return JSON.parse((await env.HOUSEHOLD.get('blobindex:' + hid)) || '[]'); } catch { return []; }
}
async function blobUsed(env, hid) {
  return Number(await env.HOUSEHOLD.get('blobquota:' + hid)) || 0;
}
async function deleteAllBlobs(env, hid) {
  for (const id of await blobIndex(env, hid)) await env.HOUSEHOLD.delete(`blob:${hid}:${id}`);
  await env.HOUSEHOLD.delete('blobindex:' + hid);
  await env.HOUSEHOLD.delete('blobquota:' + hid);
}
async function handleBlob(request, env, url) {
  const hid = url.searchParams.get('h') || '';
  const id = url.searchParams.get('id') || '';
  if (!/^[a-f0-9]{16,64}$/.test(hid)) return json({ error: 'bad id' }, 400);
  if (!/^[a-z0-9]{8,40}$/.test(id)) return json({ error: 'bad file id' }, 400);
  if (await env.HOUSEHOLD.get('retired:' + hid)) return json({ error: 'retired' }, 410);
  if (!(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household — sync once first' }, 403);
  if (!(await authorised(request, env, hid))) return json({ error: 'not allowed' }, 401);
  const key = `blob:${hid}:${id}`;

  if (request.method === 'GET') {
    const bytes = await env.HOUSEHOLD.get(key, 'arrayBuffer');
    if (!bytes) return json({ error: 'not found' }, 404);
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...CORS } });
  }

  if (request.method === 'PUT') {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BLOB_BYTES) return json({ error: 'file too large (max 12 MB)' }, 413);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: 'empty file' }, 400);
    if (bytes.byteLength > MAX_BLOB_BYTES) return json({ error: 'file too large (max 12 MB)' }, 413);
    const index = await blobIndex(env, hid);
    let previous = 0;
    if (index.includes(id)) {
      const old = await env.HOUSEHOLD.get(key, 'arrayBuffer');
      previous = old ? old.byteLength : 0;
    }
    const used = Math.max(0, (await blobUsed(env, hid)) - previous) + bytes.byteLength;
    if (used > MAX_HOUSEHOLD_BLOB_BYTES) return json({ error: 'shared file space is full (250 MB per household) — delete some files first', used: used - bytes.byteLength, limit: MAX_HOUSEHOLD_BLOB_BYTES }, 413);
    await env.HOUSEHOLD.put(key, bytes);
    if (!index.includes(id)) await env.HOUSEHOLD.put('blobindex:' + hid, JSON.stringify([...index, id]));
    await env.HOUSEHOLD.put('blobquota:' + hid, String(used));
    return json({ ok: true, id, size: bytes.byteLength, used, limit: MAX_HOUSEHOLD_BLOB_BYTES });
  }

  if (request.method === 'DELETE') {
    const index = await blobIndex(env, hid);
    const old = await env.HOUSEHOLD.get(key, 'arrayBuffer');
    if (old) {
      await env.HOUSEHOLD.delete(key);
      await env.HOUSEHOLD.put('blobquota:' + hid, String(Math.max(0, (await blobUsed(env, hid)) - old.byteLength)));
    }
    if (index.includes(id)) await env.HOUSEHOLD.put('blobindex:' + hid, JSON.stringify(index.filter((x) => x !== id)));
    return json({ ok: true, deleted: Boolean(old) });
  }

  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // Calendar pass-through: phones can't fetch a Google/Outlook/iCloud calendar
    // feed directly (browsers block it), so this fetches it on their behalf.
    // Only for your own household, only calendar links, and nothing is stored.
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/cal')) {
      const hid = url.searchParams.get('h') || '';
      if (!/^[a-f0-9]{16,64}$/.test(hid) || !(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household — sync once first' }, 403);
      if (!(await authorised(request, env, hid))) return json({ error: 'not allowed' }, 401);
      let target;
      try { target = new URL((url.searchParams.get('url') || '').replace(/^webcal:/i, 'https:')); } catch { return json({ error: 'bad calendar link' }, 400); }
      const allowed = target.protocol === 'https:' && (
        (target.hostname === 'calendar.google.com' && target.pathname.startsWith('/calendar/ical/')) ||
        ((target.hostname === 'outlook.live.com' || target.hostname === 'outlook.office365.com') && target.pathname.includes('/calendar/')) ||
        /^p\d+-caldav\.icloud\.com$/.test(target.hostname));
      if (!allowed) return json({ error: 'only calendar links are allowed' }, 400);
      const res = await fetch(target.toString(), { cf: { cacheTtl: 300 } });
      if (!res.ok) return json({ error: `the calendar returned ${res.status} — check the link` }, 502);
      return new Response(await res.text(), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
    }

    // Official car details + MOT history for a registration (your household only).
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/vehicle')) {
      const hid = url.searchParams.get('h') || '';
      if (!/^[a-f0-9]{16,64}$/.test(hid) || !(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household — sync once first' }, 403);
      if (!(await authorised(request, env, hid))) return json({ error: 'not allowed' }, 401);
      const reg = (url.searchParams.get('reg') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z0-9]{2,8}$/.test(reg)) return json({ error: 'that registration doesn\'t look right' }, 400);
      const [dvla, mot] = await Promise.all([dvlaLookup(env, reg), motLookup(env, reg)]);
      return json({ reg, dvla, mot });
    }

    // Public information (tariffs, trains, travel advice…): GET /info/<kind>?h=<household>&…
    const infoMatch = url.pathname.match(/\/info\/([a-z]+)\/?$/);
    if (request.method === 'GET' && infoMatch) {
      const hid = url.searchParams.get('h') || '';
      if (!/^[a-f0-9]{16,64}$/.test(hid) || !(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household — sync once first' }, 403);
      if (!(await authorised(request, env, hid))) return json({ error: 'not allowed' }, 401);
      const r = await handleInfo(env, url, infoMatch[1]);
      return json(r.body, r.status || 200);
    }

    // Shared encrypted files: PUT / GET / DELETE /blob?h=<household>&id=<file id>
    if (url.pathname.replace(/\/+$/, '').endsWith('/blob')) return handleBlob(request, env, url);

    // Lost-phone protection.
    // GET  /status?h=<household>&d=<device>  -> is this space retired, and should this phone wipe itself?
    // POST /retire?h=<household>  {wipe:[device ids]}  -> delete the shared data and flag the lost phone(s).
    const route = url.pathname.replace(/\/+$/, '');
    if (route.endsWith('/status') || route.endsWith('/retire')) {
      const hid = url.searchParams.get('h') || '';
      if (!/^[a-f0-9]{16,64}$/.test(hid)) return json({ error: 'bad id' }, 400);
      const retired = await env.HOUSEHOLD.get('retired:' + hid);
      if (request.method === 'GET' && route.endsWith('/status')) {
        if (!retired) return json({ retired: false });
        const device = url.searchParams.get('d') || '';
        return json({ retired: true, wipe: (JSON.parse(retired).wipe || []).includes(device) });
      }
      if (request.method === 'POST' && route.endsWith('/retire')) {
        if (!retired && !(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household' }, 404);
        if (!retired && !(await authorised(request, env, hid))) return json({ error: 'not allowed' }, 401);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad body' }, 400); }
        const wipe = Array.isArray(body.wipe) ? body.wipe : [];
        if (!wipe.length || wipe.length > 10 || !wipe.every((d) => typeof d === 'string' && /^[a-z0-9]{6,40}$/.test(d))) return json({ error: 'bad device list' }, 400);
        const prev = retired ? JSON.parse(retired).wipe || [] : [];
        await env.HOUSEHOLD.put('retired:' + hid, JSON.stringify({ at: Date.now(), wipe: [...new Set([...prev, ...wipe])] }));
        await env.HOUSEHOLD.delete(hid);
        await env.HOUSEHOLD.delete('auth:' + hid);
        await deleteAllBlobs(env, hid);
        return json({ ok: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    const id = url.pathname.split('/').filter(Boolean).pop() || '';
    if (!/^[a-f0-9]{16,64}$/.test(id)) return json({ error: 'bad id' }, 400);
    // A space retired after a lost phone can't be read or written again.
    if (await env.HOUSEHOLD.get('retired:' + id)) return json({ error: 'retired' }, 410);

    if (request.method === 'GET') {
      const stored = await env.HOUSEHOLD.get(id);
      return json(stored ? JSON.parse(stored) : { items: {} });
    }

    if (request.method === 'POST') {
      if (!(await authorised(request, env, id))) return json({ error: 'not allowed' }, 401);
      let incoming;
      try {
        incoming = await request.json();
      } catch {
        return json({ error: 'bad body' }, 400);
      }
      const serverNow = Date.now();
      const stored = await env.HOUSEHOLD.get(id);
      const current = JSON.parse(stored || '{"items":{}}');
      let changed = !stored; // a new household is always saved
      for (const [key, value] of Object.entries(incoming.items || {})) {
        // Only accept well-formed ciphertext entries; last write wins per item.
        if (!value || typeof value.updatedAt !== 'number' || typeof value.iv !== 'string' || typeof value.ct !== 'string') continue;
        const entry = { ...value, updatedAt: Math.min(value.updatedAt, serverNow + MAX_CLOCK_AHEAD_MS) };
        if (!current.items[key] || entry.updatedAt > current.items[key].updatedAt) { current.items[key] = entry; changed = true; }
      }
      // Drop deleted-item markers once they're old enough to have reached both phones.
      for (const [key, value] of Object.entries(current.items)) if (value.deleted && value.updatedAt < serverNow - TOMBSTONE_MS) { delete current.items[key]; changed = true; }
      // Cap stored size defensively (a shared household list should be small).
      const body = JSON.stringify(current);
      if (body.length > 2_000_000) return json({ error: 'too large' }, 413);
      // Only write when something changed: storage writes are limited (1,000 a day on the free plan).
      if (changed) await env.HOUSEHOLD.put(id, body);
      return json(current);
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
