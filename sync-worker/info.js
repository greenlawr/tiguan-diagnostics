// Public-information lookups for Evergreen. Personal details never come here:
// phones ask only for public facts (tariffs for a region, trains between two
// stations, advice for a country…) and do any comparing with private data on
// the phone. Only fixed, named services can be reached (no open relay).
//
// Optional secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   RAIL_API_KEY + RAIL_LDB_URL  National Rail live departures (Rail Data Marketplace)
//   COMPANIES_HOUSE_KEY          Companies House filing deadlines

const UA = { 'User-Agent': 'Evergreen-family-app/1.0' };

// Small cache in KV so repeat checks are instant and the free limits go further.
async function cached(env, key, ttlSeconds, load) {
  const k = 'cache:' + key;
  const hit = await env.HOUSEHOLD.get(k);
  if (hit) { try { return JSON.parse(hit); } catch { /* reload */ } }
  const value = await load();
  if (value && !value.error && value.configured !== false) await env.HOUSEHOLD.put(k, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  return value;
}
async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, Accept: 'application/json', ...(init.headers || {}) } });
  if (!r.ok) { const e = new Error(`${new URL(url).hostname} returned ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// ---------- energy: Octopus's public tariff list (other suppliers don't publish one) ----------
const REGIONS = ['_A', '_B', '_C', '_D', '_E', '_F', '_G', '_H', '_J', '_K', '_L', '_M', '_N', '_P'];
export async function octopusRegion(postcode) {
  const j = await getJson('https://api.octopus.energy/v1/industry/grid-supply-points/?postcode=' + encodeURIComponent(postcode));
  const g = j.results && j.results[0] && j.results[0].group_id;
  return REGIONS.includes(g) ? g : null;
}
const ddRates = (tariffs, region) => {
  const t = tariffs && tariffs[region];
  const dd = t && (t.direct_debit_monthly || t.varying);
  return dd && typeof dd.standard_unit_rate_inc_vat === 'number' ? { unit: dd.standard_unit_rate_inc_vat, standing: dd.standing_charge_inc_vat } : null;
};
export async function octopusTariffs(region) {
  const list = await getJson('https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY&is_business=false&page_size=100');
  // Plain single-rate import tariffs only (no time-of-use, prepay, tracker, EV, export or business deals).
  const plain = (list.results || []).filter((p) => p.direction === 'IMPORT' && !p.is_prepay && !p.is_business && !p.is_restricted && !p.is_tracker
    && !/agile|go|intelligent|cosy|flux|tracker|export|economy|ev |power pack|snug|prepay/i.test(p.code + ' ' + p.display_name)).slice(0, 20);
  const out = [];
  for (const p of plain) {
    try {
      const d = await getJson(p.links?.find((l) => l.rel === 'self')?.href || `https://api.octopus.energy/v1/products/${p.code}/`);
      const elec = ddRates(d.single_register_electricity_tariffs, region);
      const gas = ddRates(d.single_register_gas_tariffs, region);
      if (elec || gas) out.push({ supplier: 'Octopus Energy', name: p.display_name || p.full_name, code: p.code, fixed: !p.is_variable, term: p.term || null, green: !!p.is_green, elec, gas });
    } catch { /* skip a product that won't load */ }
  }
  return { region, tariffs: out, fetchedAt: Date.now() };
}

// ---------- trains: National Rail live departures (official feed via Rail Data Marketplace) ----------
const crsOk = (s) => /^[A-Z]{3}$/.test(s);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; };
const placeName = (x) => (Array.isArray(x) ? x.map((l) => pick(l, 'locationName', 'LocationName')).filter(Boolean).join(' & ') : '');
export function tidyBoard(raw) {
  const services = pick(raw, 'trainServices', 'TrainServices') || [];
  const list = (Array.isArray(services) ? services : services.service || []).map((s) => {
    const std = pick(s, 'std', 'STD') || '';
    const etd = pick(s, 'etd', 'ETD') || '';
    const cancelled = !!pick(s, 'isCancelled', 'IsCancelled') || /cancel/i.test(etd);
    return {
      id: pick(s, 'serviceID', 'serviceId', 'ServiceID') || '',
      due: std, expected: etd, // etd is "On time", "Delayed", "Cancelled" or a time like "08:47"
      platform: pick(s, 'platform', 'Platform') || '',
      to: placeName(pick(s, 'destination', 'Destination')),
      operator: pick(s, 'operator', 'Operator') || '',
      cancelled,
      late: !cancelled && (/delayed/i.test(etd) || (/^\d\d:\d\d$/.test(etd) && etd !== std)),
      reason: pick(s, 'cancelReason', 'delayReason', 'CancelReason', 'DelayReason') || '',
    };
  });
  const msgs = (pick(raw, 'nrccMessages', 'NrccMessages') || []).map((m) => String(m.Value || m.value || m.xhtmlMessage || m || '').replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  return { station: pick(raw, 'locationName', 'LocationName') || '', generatedAt: pick(raw, 'generatedAt', 'GeneratedAt') || '', services: list, messages: msgs };
}
export async function trainBoard(env, from, to) {
  if (!env.RAIL_API_KEY || !env.RAIL_LDB_URL) return { configured: false };
  // RAIL_LDB_URL is the departure-board address from the feed's Specification page,
  // e.g. https://api1.raildata.org.uk/…/GetDepBoardWithDetails/{crs}
  const base = env.RAIL_LDB_URL.trim();
  const u = new URL(base.includes('{crs}') ? base.replace('{crs}', from) : base.replace(/\/+$/, '') + '/' + from);
  u.searchParams.set('numRows', '10');
  if (to) { u.searchParams.set('filterCrs', to); u.searchParams.set('filterType', 'to'); }
  u.searchParams.set('timeWindow', '120');
  try {
    return { configured: true, ...tidyBoard(await getJson(u.toString(), { headers: { 'x-apikey': env.RAIL_API_KEY } })) };
  } catch (e) {
    return { configured: true, error: e.status === 401 || e.status === 403 ? 'National Rail refused the key — check RAIL_API_KEY' : e.status === 404 ? 'National Rail address not found — check RAIL_LDB_URL' : 'National Rail could not be reached' };
  }
}

// ---------- GOV.UK: bank holidays and foreign travel advice ----------
export async function bankHolidays() {
  const j = await getJson('https://www.gov.uk/bank-holidays.json');
  const ew = (j['england-and-wales'] && j['england-and-wales'].events) || [];
  return { events: ew.map((e) => ({ date: e.date, title: e.title })) };
}
const SLUG_OK = /^[a-z-]{3,40}$/;
export async function travelAdvice(slug) {
  const j = await getJson('https://www.gov.uk/api/content/foreign-travel-advice/' + slug);
  const d = j.details || {};
  const alert = (d.alert_status || []).filter(Boolean);
  return { slug, title: j.title || '', updated: j.public_updated_at || '', change: d.change_description || j.description || '', alert, url: 'https://www.gov.uk/foreign-travel-advice/' + slug };
}

// ---------- trip weather and currency (Open-Meteo, Frankfurter: free, no keys) ----------
export async function weather(place) {
  const g = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=' + encodeURIComponent(place));
  const hit = g.results && g.results[0];
  if (!hit) return { error: 'place not found' };
  const f = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=16&timezone=auto`);
  const d = f.daily || {};
  return { place: [hit.name, hit.country].filter(Boolean).join(', '), days: (d.time || []).map((t, i) => ({ date: t, code: d.weather_code?.[i], max: d.temperature_2m_max?.[i], min: d.temperature_2m_min?.[i], rain: d.precipitation_probability_max?.[i] })) };
}
export async function fx(currency) {
  const j = await getJson('https://api.frankfurter.app/latest?from=GBP&to=' + currency);
  return { currency, rate: j.rates && j.rates[currency], date: j.date };
}

// ---------- weather at home (Open-Meteo, Met Office model data for the UK) ----------
const COUNTY_REGION = { hertfordshire: 'East of England', bedfordshire: 'East of England', 'central bedfordshire': 'East of England', essex: 'East of England', cambridgeshire: 'East of England', norfolk: 'East of England', suffolk: 'East of England',
  buckinghamshire: 'London & South East England', oxfordshire: 'London & South East England', berkshire: 'London & South East England', surrey: 'London & South East England', kent: 'London & South East England', hampshire: 'London & South East England', 'greater london': 'London & South East England', 'east sussex': 'London & South East England', 'west sussex': 'London & South East England',
  northamptonshire: 'East Midlands', leicestershire: 'East Midlands', warwickshire: 'West Midlands', 'west midlands': 'West Midlands' };
export async function localWeather(place) {
  const g = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&countryCode=GB&name=' + encodeURIComponent(place));
  const hit = g.results && g.results[0];
  if (!hit) return { error: "couldn't find that place in the UK" };
  const f = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&timezone=Europe%2FLondon&forecast_days=7`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph'
    + '&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max');
  const c = f.current || {}, h = f.hourly || {}, d = f.daily || {};
  const county = hit.admin2 || '';
  return {
    place: hit.name, county, region: COUNTY_REGION[county.toLowerCase()] || '',
    now: { temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, wind: c.wind_speed_10m, gusts: c.wind_gusts_10m, at: c.time },
    hours: (h.time || []).map((t, i) => ({ t, temp: h.temperature_2m?.[i], rain: h.precipitation_probability?.[i], code: h.weather_code?.[i] })),
    days: (d.time || []).map((t, i) => ({ date: t, code: d.weather_code?.[i], max: d.temperature_2m_max?.[i], min: d.temperature_2m_min?.[i], rain: d.precipitation_probability_max?.[i], sunrise: d.sunrise?.[i], sunset: d.sunset?.[i], uv: d.uv_index_max?.[i] })),
  };
}
// Met Office severe-weather warnings (UK feed), filtered to your county / region.
export function parseWarnings(xml, terms) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const get = (tag) => ((m[1].match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\/${tag}>`)) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    return { title: get('title'), text: get('description'), link: get('link') };
  });
  const want = terms.filter(Boolean).map((t) => t.toLowerCase());
  return items.filter((w) => w.title && want.some((t) => (w.title + ' ' + w.text).toLowerCase().includes(t)))
    .map((w) => ({ ...w, level: /red/i.test(w.title) ? 'red' : /amber/i.test(w.title) ? 'amber' : 'yellow' }));
}
export async function warnings(terms) {
  const r = await fetch('https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK', { headers: UA });
  if (!r.ok) throw new Error('Met Office returned ' + r.status);
  return { warnings: parseWarnings(await r.text(), terms), source: 'Met Office' };
}

// ---------- Companies House: filing deadlines for your company ----------
export async function company(env, number) {
  if (!env.COMPANIES_HOUSE_KEY) return { configured: false };
  try {
    const j = await getJson('https://api.company-information.service.gov.uk/company/' + number, { headers: { Authorization: 'Basic ' + btoa(env.COMPANIES_HOUSE_KEY + ':') } });
    return { configured: true, name: j.company_name, status: j.company_status, accountsDue: j.accounts?.next_due || j.accounts?.next_accounts?.due_on || '', accountsMadeUpTo: j.accounts?.next_made_up_to || '', accountsOverdue: !!j.accounts?.overdue,
      confirmationDue: j.confirmation_statement?.next_due || '', confirmationOverdue: !!j.confirmation_statement?.overdue };
  } catch (e) {
    return { configured: true, error: e.status === 404 ? 'no company with that number' : e.status === 401 ? 'Companies House refused the key — check COMPANIES_HOUSE_KEY' : 'Companies House could not be reached' };
  }
}

/** Route /info/<kind>. The caller has already checked the household key. */
export async function handleInfo(env, url, kind) {
  const q = (k) => (url.searchParams.get(k) || '').trim();
  try {
    switch (kind) {
      case 'energy': {
        let region = q('region');
        if (!REGIONS.includes(region)) {
          const pc = q('postcode').toUpperCase().replace(/[^A-Z0-9 ]/g, '');
          if (!/^[A-Z]{1,2}\d[A-Z\d]?( ?\d[A-Z]{2})?$/.test(pc)) return { status: 400, body: { error: 'choose your region or enter a postcode area' } };
          region = await cached(env, 'gsp:' + pc.replace(/\s/g, ''), 30 * 86400, async () => ({ region: await octopusRegion(pc) })).then((r) => r.region);
          if (!region) return { status: 404, body: { error: "couldn't work out the region from that postcode — choose it instead" } };
        }
        return { body: await cached(env, 'octopus:' + region, 6 * 3600, () => octopusTariffs(region)) };
      }
      case 'trains': {
        const from = q('from').toUpperCase(), to = q('to').toUpperCase();
        if (!crsOk(from) || (to && !crsOk(to))) return { status: 400, body: { error: 'station codes are three letters, e.g. EUS' } };
        return { body: await trainBoard(env, from, to) }; // live, never cached
      }
      case 'bankholidays': return { body: await cached(env, 'bankhols', 86400, bankHolidays) };
      case 'advice': {
        const slug = q('country').toLowerCase();
        if (!SLUG_OK.test(slug)) return { status: 400, body: { error: 'bad country' } };
        return { body: await cached(env, 'advice:' + slug, 3 * 3600, () => travelAdvice(slug)) };
      }
      case 'weather': {
        const place = q('place');
        if (!place || place.length > 60) return { status: 400, body: { error: 'bad place' } };
        return { body: await cached(env, 'wx:' + place.toLowerCase(), 3 * 3600, () => weather(place)) };
      }
      case 'home-weather': {
        const place = q('place');
        if (!place || place.length > 60) return { status: 400, body: { error: 'bad place' } };
        return { body: await cached(env, 'hw:' + place.toLowerCase(), 30 * 60, () => localWeather(place)) };
      }
      case 'warnings': {
        const terms = q('terms').split('|').map((t) => t.trim()).filter((t) => t && t.length <= 40).slice(0, 4);
        if (!terms.length) return { status: 400, body: { error: 'bad area' } };
        return { body: await cached(env, 'warn:' + terms.join('|').toLowerCase(), 15 * 60, () => warnings(terms)) };
      }
      case 'fx': {
        const c = q('currency').toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) return { status: 400, body: { error: 'bad currency' } };
        return { body: await cached(env, 'fx:' + c, 6 * 3600, () => fx(c)) };
      }
      case 'company': {
        const n = q('number').toUpperCase().replace(/\s/g, '');
        if (!/^[A-Z0-9]{8}$/.test(n)) return { status: 400, body: { error: 'company numbers are 8 characters, e.g. 01234567' } };
        return { body: await cached(env, 'co:' + n, 12 * 3600, () => company(env, n)) };
      }
      default: return { status: 404, body: { error: 'unknown lookup' } };
    }
  } catch (e) {
    return { status: 502, body: { error: e.message || 'lookup failed' } };
  }
}
