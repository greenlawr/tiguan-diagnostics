// Evergreen shared-household sync server (Cloudflare Worker).
//
// Zero-knowledge: it only ever stores and returns ciphertext, keyed by the
// public household id. It cannot read anything you store. Deploy it free on
// Cloudflare and bind a KV namespace called HOUSEHOLD (see README in this folder).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const id = new URL(request.url).pathname.split('/').filter(Boolean).pop() || '';
    if (!/^[a-f0-9]{16,64}$/.test(id)) return json({ error: 'bad id' }, 400);

    if (request.method === 'GET') {
      const stored = await env.HOUSEHOLD.get(id);
      return json(stored ? JSON.parse(stored) : { items: {} });
    }

    if (request.method === 'POST') {
      let incoming;
      try {
        incoming = await request.json();
      } catch {
        return json({ error: 'bad body' }, 400);
      }
      const current = JSON.parse((await env.HOUSEHOLD.get(id)) || '{"items":{}}');
      for (const [key, value] of Object.entries(incoming.items || {})) {
        // Only accept well-formed ciphertext entries; last write wins per item.
        if (!value || typeof value.updatedAt !== 'number') continue;
        if (!current.items[key] || value.updatedAt > current.items[key].updatedAt) current.items[key] = value;
      }
      // Cap stored size defensively (a shared household list should be small).
      const body = JSON.stringify(current);
      if (body.length > 2_000_000) return json({ error: 'too large' }, 413);
      await env.HOUSEHOLD.put(id, body);
      return json(current);
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
