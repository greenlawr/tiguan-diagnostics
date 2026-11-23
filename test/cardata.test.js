import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseCar } from '../js/cardata.js';
import worker from '../sync-worker/worker.js';
import { householdId, writeToken } from '../js/household.js';

const dvla = { configured: true, data: { registrationNumber: 'AB17CDE', taxStatus: 'Taxed', taxDueDate: '2027-03-01', motStatus: 'Valid', motExpiryDate: '2027-01-14', make: 'VOLKSWAGEN', yearOfManufacture: 2017, engineCapacity: 1968, co2Emissions: 139, fuelType: 'DIESEL', colour: 'WHITE', monthOfFirstRegistration: '2017-03' } };
const mot = { configured: true, data: { registration: 'AB17CDE', make: 'VOLKSWAGEN', model: 'TIGUAN', hasOutstandingRecall: 'No', motTests: [
  { completedDate: '2024-01-10T10:00:00.000Z', testResult: 'PASSED', expiryDate: '2025-01-14', odometerValue: '30000', odometerUnit: 'MI', defects: [{ text: 'Nearside front tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }] },
  { completedDate: '2026-01-12T10:00:00.000Z', testResult: 'PASSED', expiryDate: '2027-01-14', odometerValue: '52000', odometerUnit: 'MI', defects: [{ text: 'Brake pipe corroded', type: 'MINOR' }, { text: 'Oil leak', type: 'ADVISORY' }] },
  { completedDate: '2025-01-09T10:00:00.000Z', testResult: 'FAILED', odometerValue: '41000', odometerUnit: 'MI', defects: [{ text: 'Headlamp aim too high', type: 'MAJOR' }, { text: 'Tyre cut', type: 'DANGEROUS', dangerous: true }] },
] } };

test('car summary from DVLA + MOT history', () => {
  const s = summariseCar(dvla, mot);
  assert.equal(s.make, 'Volkswagen');
  assert.equal(s.model, 'Tiguan');
  assert.equal(s.colour, 'White');
  assert.equal(s.fuel, 'Diesel');
  assert.equal(s.engineCc, 1968);
  assert.equal(s.taxDue, '2027-03-01');
  assert.equal(s.motExpiry, '2027-01-14');
  assert.equal(s.outstandingRecall, false);
  assert.deepEqual(s.tests.map((t) => `${t.date} ${t.result} ${t.mileage}`), ['2026-01-12 Pass 52000', '2025-01-09 Fail 41000', '2024-01-10 Pass 30000']);
  assert.equal(s.tests[1].defects[0].label, 'Dangerous', 'worst first');
  assert.equal(s.milesPerYear, 10962); // 22,000 miles over 2.007 years
  assert.deepEqual(s.sources, { dvla: 'ok', mot: 'ok' });
});

test('works with only one source, or none set up', () => {
  const s = summariseCar({ configured: false }, mot);
  assert.equal(s.make, 'Volkswagen');
  assert.equal(s.motExpiry, '2027-01-14', 'falls back to the latest pass');
  assert.equal(s.sources.dvla, 'not set up');
  const e = summariseCar({ configured: false }, { configured: false });
  assert.deepEqual(e.tests, []);
});

test('server: /vehicle needs your household key and reports when keys are not set up', async () => {
  const m = new Map(); const env = { HOUSEHOLD: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } } };
  const code = 'ABCD-EFGH-JKLM-NPQR'; const hid = await householdId(code); const tok = await writeToken(code);
  await worker.fetch(new Request('https://w.dev/' + hid, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': tok }, body: '{"items":{}}' }), env);
  const call = async (q, t) => { const r = await worker.fetch(new Request('https://w.dev/vehicle?' + q, { headers: t ? { 'X-Evergreen-Token': t } : {} }), env); return { status: r.status, body: await r.json() }; };
  assert.equal((await call(`h=${hid}&reg=AB17CDE`)).status, 401);
  assert.equal((await call(`h=${hid}&reg=!!`, tok)).status, 400);
  const r = await call(`h=${hid}&reg=ab17 cde`, tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.reg, 'AB17CDE');
  assert.deepEqual([r.body.dvla.configured, r.body.mot.configured], [false, false]);
});
