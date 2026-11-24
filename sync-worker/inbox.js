// Evergreen inbox on the sync server. The morning parcel check posts sealed
// messages here (it has no household key — only the inbox id and public key);
// your phones collect and open them. The server stores ciphertext only.

const MAX_MESSAGE = 16 * 1024;
const MAX_WAITING = 30;
const KEEP_SECONDS = 21 * 86400;
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function load(env, hid) { try { return JSON.parse((await env.HOUSEHOLD.get('inbox:' + hid)) || '[]'); } catch { return []; } }
const save = (env, hid, list) => (list.length ? env.HOUSEHOLD.put('inbox:' + hid, JSON.stringify(list), { expirationTtl: KEEP_SECONDS }) : env.HOUSEHOLD.delete('inbox:' + hid));

/** Anyone with the inbox id may DROP a sealed message (they can't read anything). */
export async function dropMessage(request, env, inboxId) {
  const hid = await env.HOUSEHOLD.get('inboxreg:' + inboxId);
  if (!hid) return { status: 404, body: { error: 'unknown inbox' } };
  if (await env.HOUSEHOLD.get('retired:' + hid)) return { status: 410, body: { error: 'retired' } };
  const text = await request.text();
  if (text.length > MAX_MESSAGE) return { status: 413, body: { error: 'too large' } };
  let sealed;
  try { sealed = JSON.parse(text).sealed; } catch { return { status: 400, body: { error: 'bad body' } }; }
  if (typeof sealed !== 'string' || !/^[A-Za-z0-9_-]{100,}$/.test(sealed)) return { status: 400, body: { error: 'bad message' } };
  const list = await load(env, hid);
  list.push({ id: rid(), at: Date.now(), sealed });
  if (list.length > MAX_WAITING) list.splice(0, list.length - MAX_WAITING);
  await save(env, hid, list);
  return { body: { ok: true }, hid };
}

/** register / list / ack — the caller has already checked the household key. */
export async function handleInbox(request, env, hid, action) {
  if (action === 'register') {
    let body; try { body = await request.json(); } catch { return { status: 400, body: { error: 'bad body' } }; }
    const inboxId = String(body.inboxId || '');
    if (!/^[a-f0-9]{32}$/.test(inboxId)) return { status: 400, body: { error: 'bad inbox id' } };
    const owner = await env.HOUSEHOLD.get('inboxreg:' + inboxId);
    if (owner && owner !== hid) return { status: 409, body: { error: 'inbox id taken' } };
    const old = await env.HOUSEHOLD.get('inboxof:' + hid);
    if (old && old !== inboxId) await env.HOUSEHOLD.delete('inboxreg:' + old);
    if (owner !== hid) await env.HOUSEHOLD.put('inboxreg:' + inboxId, hid);
    if (old !== inboxId) await env.HOUSEHOLD.put('inboxof:' + hid, inboxId);
    return { body: { ok: true } };
  }
  if (action === 'list') return { body: { messages: await load(env, hid) } };
  if (action === 'ack') {
    let body; try { body = await request.json(); } catch { return { status: 400, body: { error: 'bad body' } }; }
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    const list = await load(env, hid);
    const left = list.filter((m) => !ids.has(m.id));
    if (left.length !== list.length) await save(env, hid, left);
    return { body: { ok: true, left: left.length } };
  }
  return { status: 404, body: { error: 'unknown' } };
}

export async function deleteInbox(env, hid) {
  const id = await env.HOUSEHOLD.get('inboxof:' + hid);
  if (id) await env.HOUSEHOLD.delete('inboxreg:' + id);
  await env.HOUSEHOLD.delete('inboxof:' + hid);
  await env.HOUSEHOLD.delete('inbox:' + hid);
}
