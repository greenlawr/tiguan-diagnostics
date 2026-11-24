import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sync-worker/worker.js';
import { tidyBoard } from '../sync-worker/info.js';
import { householdId, writeToken } from '../js/household.js';

const code = 'ABCD-EFGH-JKLM-NPQR';
async function setup(extraEnv = {}) {
  const m = new Map(); let puts = 0;
  const env = { HOUSEHOLD: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { puts++; m.set(k, v); }, delete: async (k) => { m.delete(k); } }, ...extraEnv };
  const hid = await householdId(code); const tok = await writeToken(code);
  await worker.fetch(new Request('https://w.dev/' + hid, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': tok }, body: '{"items":{}}' }), env);
  const call = async (path, t = tok) => { const r = await worker.fetch(new Request(`https://w.dev/info/${path}${path.includes('?') ? '&' : '?'}h=${hid}`, { headers: t ? { 'X-Evergreen-Token': t } : {} }), env); return { status: r.status, body: await r.json() }; };
  return { env, call, m, puts: () => puts };
}
function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    seen.push({ url, headers: init.headers || {} });
    for (const [pat, body] of routes) if (url.includes(pat)) return new Response(JSON.stringify(typeof body === 'function' ? body(url) : body), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return seen;
}

test('info lookups need your household key', async () => {
  const { call } = await setup();
  assert.equal((await call('bankholidays', null)).status, 401);
  assert.equal((await call('nonsense')).status, 404);
});

test('energy: Octopus tariffs for a region, cached, personal usage never sent', async () => {
  const seen = mockFetch([
    ['grid-supply-points', { results: [{ group_id: '_C' }] }],
    ['/products/?', { results: [
      { code: 'VAR-1', display_name: 'Flexible Octopus', direction: 'IMPORT', is_variable: true, links: [{ rel: 'self', href: 'https://api.octopus.energy/v1/products/VAR-1/' }] },
      { code: 'FIX-12M', display_name: 'Octopus 12M Fixed', direction: 'IMPORT', is_variable: false, term: 12, links: [{ rel: 'self', href: 'https://api.octopus.energy/v1/products/FIX-12M/' }] },
      { code: 'AGILE-24', display_name: 'Agile Octopus', direction: 'IMPORT', is_variable: true },
      { code: 'OUTGOING', display_name: 'Outgoing', direction: 'EXPORT' },
    ] }],
    ['/products/VAR-1/', { single_register_electricity_tariffs: { _C: { direct_debit_monthly: { standard_unit_rate_inc_vat: 26.1, standing_charge_inc_vat: 55.2 } } }, single_register_gas_tariffs: { _C: { direct_debit_monthly: { standard_unit_rate_inc_vat: 7.9, standing_charge_inc_vat: 29.5 } } } }],
    ['/products/FIX-12M/', { single_register_electricity_tariffs: { _C: { direct_debit_monthly: { standard_unit_rate_inc_vat: 24.0, standing_charge_inc_vat: 50 } } } }],
  ]);
  const { call } = await setup();
  const r = await call('energy?postcode=NW1');
  assert.equal(r.status, 200);
  assert.equal(r.body.region, '_C');
  assert.deepEqual(r.body.tariffs.map((t) => t.name), ['Flexible Octopus', 'Octopus 12M Fixed'], 'time-of-use and export tariffs left out');
  assert.equal(r.body.tariffs[1].elec.unit, 24.0);
  const before = seen.length;
  await call('energy?region=_C');
  assert.equal(seen.length, before, 'second look is served from the cache');
  assert.ok(seen.every((s) => !/kwh|usage/i.test(s.url)));
});

test('trains: not set up, then a tidy board from the National Rail feed', async () => {
  let r = await (await setup()).call('trains?from=EUS&to=MKC');
  assert.equal(r.body.configured, false);
  const seen = mockFetch([['GetDepBoardWithDetails', { locationName: 'London Euston', trainServices: [
    { std: '17:24', etd: 'On time', platform: '9', operator: 'London Northwestern Railway', destination: [{ locationName: 'Northampton' }], serviceID: 'a1' },
    { std: '17:33', etd: '17:41', operator: 'Avanti West Coast', destination: [{ locationName: 'Manchester Piccadilly' }], serviceID: 'a2', delayReason: 'a fault with the signalling' },
    { std: '17:40', etd: 'Cancelled', isCancelled: true, cancelReason: 'a shortage of train crew', destination: [{ locationName: 'Tring' }], serviceID: 'a3' },
  ], nrccMessages: [{ Value: '<p>Disruption between <b>Watford</b> and Tring.</p>' }] }]]);
  const { call } = await setup({ RAIL_API_KEY: 'k', RAIL_LDB_URL: 'https://api1.raildata.org.uk/x/LDBWS/api/20220120/GetDepBoardWithDetails/{crs}' });
  r = await call('trains?from=eus&to=mkc');
  assert.equal(r.status, 200);
  assert.match(seen[0].url, /GetDepBoardWithDetails\/EUS\?.*filterCrs=MKC/);
  assert.equal(seen[0].headers['x-apikey'], 'k');
  assert.deepEqual(r.body.services.map((s) => [s.due, s.late, s.cancelled]), [['17:24', false, false], ['17:33', true, false], ['17:40', false, true]]);
  assert.equal(r.body.messages[0], 'Disruption between Watford and Tring.');
  assert.equal((await call('trains?from=EUSTON')).status, 400);
});

test('board tidying copes with PascalCase and missing fields', () => {
  const b = tidyBoard({ LocationName: 'Milton Keynes Central', TrainServices: [{ STD: '08:01', ETD: 'Delayed', Destination: [{ LocationName: 'London Euston' }] }] });
  assert.equal(b.station, 'Milton Keynes Central');
  assert.equal(b.services[0].late, true);
  assert.equal(b.services[0].to, 'London Euston');
});

test('bank holidays, travel advice, weather, currency and Companies House', async () => {
  mockFetch([
    ['bank-holidays.json', { 'england-and-wales': { events: [{ date: '2026-12-25', title: 'Christmas Day' }] }, scotland: { events: [] } }],
    ['foreign-travel-advice/spain', { title: 'Spain travel advice', public_updated_at: '2026-11-03T10:00:00Z', details: { change_description: 'Information on new entry checks', alert_status: [] } }],
    ['geocoding-api', { results: [{ name: 'Palma', country: 'Spain', latitude: 39.57, longitude: 2.65 }] }],
    ['api.open-meteo.com', { daily: { time: ['2026-12-04'], weather_code: [1], temperature_2m_max: [17], temperature_2m_min: [9], precipitation_probability_max: [10] } }],
    ['frankfurter', { date: '2026-11-24', rates: { EUR: 1.17 } }],
    ['company-information', { company_name: 'JACK FRANCIS LTD', company_status: 'active', accounts: { next_due: '2027-06-30' }, confirmation_statement: { next_due: '2027-03-14' } }],
  ]);
  const { call } = await setup({ COMPANIES_HOUSE_KEY: 'ch' });
  assert.deepEqual((await call('bankholidays')).body.events, [{ date: '2026-12-25', title: 'Christmas Day' }]);
  assert.equal((await call('advice?country=spain')).body.change, 'Information on new entry checks');
  assert.equal((await call('advice?country=../x')).status, 400);
  const w = (await call('weather?place=Palma')).body;
  assert.equal(w.place, 'Palma, Spain'); assert.equal(w.days[0].max, 17);
  assert.equal((await call('fx?currency=eur')).body.rate, 1.17);
  const c = (await call('company?number=12345678')).body;
  assert.deepEqual([c.accountsDue, c.confirmationDue], ['2027-06-30', '2027-03-14']);
  assert.equal((await call('company?number=123')).status, 400);
});
