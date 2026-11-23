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
    const url = new URL(request.url);

    // Calendar pass-through: phones can't fetch a Google/Outlook/iCloud calendar
    // feed directly (browsers block it), so this fetches it on their behalf.
    // Only for your own household, only calendar links, and nothing is stored.
    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith('/cal')) {
      const hid = url.searchParams.get('h') || '';
      if (!/^[a-f0-9]{16,64}$/.test(hid) || !(await env.HOUSEHOLD.get(hid))) return json({ error: 'unknown household — sync once first' }, 403);
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
        let body;
        try { body = await request.json(); } catch { return json({ error: 'bad body' }, 400); }
        const wipe = Array.isArray(body.wipe) ? body.wipe : [];
        if (!wipe.length || wipe.length > 10 || !wipe.every((d) => typeof d === 'string' && /^[a-z0-9]{6,40}$/.test(d))) return json({ error: 'bad device list' }, 400);
        const prev = retired ? JSON.parse(retired).wipe || [] : [];
        await env.HOUSEHOLD.put('retired:' + hid, JSON.stringify({ at: Date.now(), wipe: [...new Set([...prev, ...wipe])] }));
        await env.HOUSEHOLD.delete(hid);
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
