import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capFor, tariffCost, fuelCost, yearlyFromReadings, compareTariffs, gasM3ToKwh, TYPICAL } from '../js/energy.js';

test('the price cap gives Ofgem’s typical bill', () => {
  const cap = capFor('2026-11-24');
  assert.equal(cap.label, 'Oct–Dec 2026');
  assert.ok(Math.abs(tariffCost(cap, TYPICAL) - 1723) < 2, 'Ofgem’s published £1,723 (they round the rates)');
});

test('costs per fuel, and missing fuels', () => {
  assert.equal(Math.round(fuelCost({ unit: 24, standing: 50 }, 3000)), 903); // £720 + £182.50
  assert.equal(tariffCost({ elec: { unit: 24, standing: 50 } }, { elec: 3000, gas: 9000 }), null, 'electricity-only deal can’t price your gas');
  assert.ok(tariffCost({ elec: { unit: 24, standing: 50 } }, { elec: 3000, gas: 0 }) > 0);
});

test('yearly use from meter readings (gas converted to kWh)', () => {
  const e = yearlyFromReadings([{ date: '2026-01-01', reading: 1000 }, { date: '2026-07-01', reading: 1500 }, { date: '2026-11-01', reading: 2400 }], 'elec');
  assert.equal(e.kwh, Math.round(1400 / 304 * 365));
  assert.equal(e.rough, false);
  const g = yearlyFromReadings([{ date: '2026-09-01', reading: 100 }, { date: '2026-11-01', reading: 200 }], 'gas');
  assert.equal(g.rough, true);
  assert.equal(g.kwh, Math.round(gasM3ToKwh(100 / 61 * 365)));
  assert.equal(yearlyFromReadings([{ date: '2026-11-01', reading: 1 }], 'elec'), null);
});

test('comparison: cheapest first with the saving against your current deal', () => {
  const usage = { elec: 3000, gas: 10000 };
  const mine = { elec: { unit: 28, standing: 60 }, gas: { unit: 8.5, standing: 32 } };
  const r = compareTariffs(mine, [
    { name: 'Price cap', ...capFor('2026-11-24') },
    { name: 'Cheap fix', elec: { unit: 22, standing: 50 }, gas: { unit: 6.5, standing: 28 } },
    { name: 'Elec only', elec: { unit: 20, standing: 40 } },
  ], usage);
  assert.deepEqual(r.map((x) => x.name), ['Cheap fix', 'Price cap']);
  assert.ok(r[0].saving > 300);
});
