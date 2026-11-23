import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCanLines, encodeIsoTp, elmError } from '../js/isotp.js';
import { Elm } from '../js/elm.js';
import { SimulatorTransport } from '../js/simulator.js';
import * as obd from '../js/obd.js';
import { PIDS } from '../js/pids.js';
import { VW_MODULES, scanModule, decodeUdsDtcs } from '../js/vw.js';
import { describeDtc } from '../js/dtc.js';

test('single frames parse with and without spaces', () => {
  const a = parseCanLines(['7E8 06 41 00 BE 3F A8 13']);
  const b = parseCanLines(['7E80641 00BE3FA813'.replace(' ', '')]);
  assert.deepEqual(a.get(0x7e8), [[0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13]]);
  assert.deepEqual(b.get(0x7e8), a.get(0x7e8));
});

test('multi-frame VIN reassembles (real ELM capture format)', () => {
  const lines = [
    '7E8 10 14 49 02 01 57 56 47',
    '7E8 21 5A 5A 5A 35 4E 5A 48',
    '7E8 22 57 30 30 30 30 30 30',
  ];
  const payload = parseCanLines(lines).get(0x7e8)[0];
  assert.equal(payload.length, 0x14);
  assert.equal(String.fromCharCode(...payload.slice(3)), 'WVGZZZ5NZHW000000');
});

test('interleaved multi-frame answers from two ECUs stay separate', () => {
  const p1 = Array.from({ length: 20 }, (_, i) => i);
  const p2 = Array.from({ length: 12 }, (_, i) => 100 + i);
  const a = encodeIsoTp(0x7e8, p1);
  const b = encodeIsoTp(0x7e9, p2);
  const mixed = [a[0], b[0], a[1], b[1], a[2]];
  const out = parseCanLines(mixed);
  assert.deepEqual(out.get(0x7e8), [p1]);
  assert.deepEqual(out.get(0x7e9), [p2]);
});

test('noise and status lines are ignored / reported', () => {
  assert.equal(parseCanLines(['NO DATA', 'OK', '?', '']).size, 0);
  assert.equal(elmError(['NO DATA']), 'NO DATA');
  assert.equal(elmError(['CAN ERROR']), 'CAN ERROR');
  assert.equal(elmError(['7E8 02 41 00']), null);
});

test('DTC decoding', () => {
  assert.equal(obd.decodeDtc(0x02, 0x99), 'P0299');
  assert.equal(obd.decodeDtc(0x01, 0x71), 'P0171');
  assert.equal(obd.decodeDtc(0xc1, 0x21), 'U0121');
  assert.equal(obd.decodeDtc(0x40, 0x12), 'C0012');
  assert.equal(obd.decodeDtc(0x9a, 0xbc), 'B1ABC');
  assert.equal(describeDtc('P0299'), 'Turbocharger underboost');
  assert.match(describeDtc('P1234'), /Volkswagen-specific/);
});

test('UDS fault list decoding', () => {
  const faults = decodeUdsDtcs([0x59, 0x02, 0xff, 0xc1, 0x21, 0x00, 0x09, 0x02, 0x99, 0x17, 0x04]);
  assert.equal(faults.length, 2);
  assert.deepEqual(
    { code: faults[0].code, active: faults[0].active, confirmed: faults[0].confirmed, raw: faults[0].raw },
    { code: 'U0121', active: true, confirmed: true, raw: 'C12100' }
  );
  assert.equal(faults[1].pending, true);
  assert.equal(faults[1].confirmed, false);
});

async function connected() {
  const elm = new Elm(new SimulatorTransport());
  await elm.init();
  return elm;
}

test('end to end against the simulated car: OBD services', async () => {
  const elm = await connected();
  assert.match(elm.info.adapter, /ELM327/);
  assert.equal(await obd.readVin(elm), 'WVGZZZ5NZHW000000');
  assert.deepEqual(await obd.readDtcs(elm, 0x03), ['P0299']);
  assert.deepEqual(await obd.readDtcs(elm, 0x07), ['P0171']);
  assert.deepEqual(await obd.readDtcs(elm, 0x0a), []);

  const status = await obd.readStatus(elm);
  assert.equal(status.mil, true);
  assert.equal(status.dtcCount, 1);
  assert.equal(status.diesel, false);
  assert.ok(status.monitors.some((m) => m.name === 'Catalyst'));

  const supported = await obd.readSupportedPids(elm);
  assert.ok(supported.has(0x0c) && supported.has(0x42) && supported.has(0x5c));
  assert.ok(!supported.has(0x0b));

  const rpm = PIDS.find((p) => p.pid === 0x0c).calc(await obd.readPid(elm, 0x0c));
  assert.ok(rpm > 700 && rpm < 1000);
  assert.equal(PIDS.find((p) => p.pid === 0x05).calc(await obd.readPid(elm, 0x05)), 88);
  assert.equal(await elm.batteryVoltage(), 14.1);

  assert.equal(await obd.clearDtcs(elm), true);
  assert.deepEqual(await obd.readDtcs(elm, 0x03), []);
  assert.equal((await obd.readStatus(elm)).mil, false);
});

test('end to end against the simulated car: VW module scan', async () => {
  const elm = await connected();
  const results = [];
  for (const m of VW_MODULES) {
    const r = await scanModule(elm, m);
    if (r) results.push(r);
  }
  assert.equal(results.length, 8);

  const abs = results.find((r) => r.code === '03');
  assert.equal(abs.partNumber, '5Q0614517DT');
  assert.equal(abs.softwareVersion, '0421');
  assert.equal(abs.faults.length, 1);
  assert.equal(abs.faults[0].code, 'C0012');

  const infotainment = results.find((r) => r.code === '5F');
  assert.equal(infotainment.faults, null);
  assert.equal(infotainment.notes.length, 1);

  // Switching back to normal OBD addressing still works after a module scan.
  assert.equal(await obd.readVin(elm), 'WVGZZZ5NZHW000000');
});

test('a silent adapter times out instead of hanging', async () => {
  const transport = { open: async () => {}, close: async () => {}, write: async () => {} };
  const elm = new Elm(transport);
  await assert.rejects(elm.cmd('ATZ', 30), /did not answer/);
});

// ---------- plain-English layer ----------
import { runHealthCheck, reportText } from '../js/report.js';
import { explainFault, explainBattery } from '../js/explain.js';

test('fault advice: severity depends on the fault and whether it is happening now', () => {
  assert.equal(explainFault({ code: 'P0301', state: 'current' }).level, 'urgent');
  assert.equal(explainFault({ code: 'P0299', state: 'current' }).level, 'soon');
  assert.equal(explainFault({ code: 'P0299', state: 'pending' }).level, 'minor');
  assert.equal(explainFault({ code: 'P0301', state: 'pending' }).level, 'urgent');
  assert.equal(explainFault({ code: 'P0299', state: 'historic' }).level, 'minor');
  // Unknown code falls back to advice for the part of the car that reported it.
  const airbag = explainFault({ code: 'B1234', moduleCode: '15', state: 'current' });
  assert.equal(airbag.title, 'Airbag system fault');
  assert.equal(airbag.level, 'soon');
  for (const key of ['title', 'meaning', 'drive', 'action']) assert.ok(airbag[key].length > 10);
});

test('battery advice', () => {
  assert.equal(explainBattery(12.6, false).level, 'ok');
  assert.equal(explainBattery(11.7, false).level, 'soon');
  assert.equal(explainBattery(14.1, true).level, 'ok');
  assert.equal(explainBattery(11.9, true).level, 'soon');
  assert.equal(explainBattery(null, true), null);
});

test('health check builds a complete plain-English report', async () => {
  const elm = await connected();
  const steps = [];
  const r = await runHealthCheck(elm, (f, m) => steps.push([f, m]));

  assert.equal(r.level, 'soon');
  assert.equal(r.headline, 'Something needs attention');
  assert.equal(r.vin, 'WVGZZZ5NZHW000000');
  assert.equal(r.mil, true);
  assert.equal(r.battery.engineRunning, true);
  assert.equal(r.battery.level, 'ok');

  // P0299 is reported by both the standard list and the engine module: listed once.
  assert.deepEqual(r.issues.map((i) => i.code).sort(), ['C0012', 'P0171', 'P0299']);
  assert.equal(r.issues[0].code, 'P0299'); // most serious first
  const abs = r.issues.find((i) => i.code === 'C0012');
  assert.equal(abs.state, 'historic');
  assert.equal(abs.system, 'Brakes and stability control');

  assert.equal(r.systems.length, 8);
  assert.equal(r.systems.find((s) => s.code === '5F').status, 'unknown');
  assert.ok(r.systems.every((s) => s.plain));

  assert.equal(steps.at(-1)[0], 1);
  assert.ok(steps.every(([f]) => f >= 0 && f <= 1));

  const text = reportText(r);
  assert.match(text, /RESULT: Something needs attention/);
  assert.match(text, /P0299/);
  assert.match(text, /Gearbox: OK \(part 0CW300050K, software 5403\)/);

  // After clearing, only the historic ABS note is left: nothing urgent.
  await obd.clearDtcs(elm);
  const after = await runHealthCheck(elm);
  assert.equal(after.level, 'minor');
  assert.equal(after.mil, false);
});

// ---------- Android Auto diagnosis ----------
import { diagnoseAppConnect, CHECKLIST } from '../js/appconnect.js';

test('Android Auto check reads the infotainment unit', async () => {
  const elm = await connected();
  const d = await diagnoseAppConnect(elm);
  assert.equal(d.reachable, true);
  assert.equal(d.partNumber, '5NA035180');
  assert.equal(d.softwareVersion, '0478');
  assert.equal(d.faultsUnreadable, true); // sim's unit refuses fault memory
});

test('Android Auto checklist tree is coherent', () => {
  const ids = new Set(CHECKLIST.map((s) => s.id));
  for (const step of CHECKLIST) {
    for (const outcome of Object.values(step.answers)) {
      if (outcome.next) assert.ok(ids.has(outcome.next), `dangling next: ${outcome.next}`);
      else {
        assert.ok(outcome.verdict && outcome.detail, 'leaf needs verdict and detail');
        assert.ok(['minor', 'soon', 'urgent'].includes(outcome.level));
      }
    }
  }
});

// ---------- costs and dealer summary ----------
import { priceSearchUrl } from '../js/explain.js';
import { dealerSummary } from '../js/appconnect.js';

test('fault advice carries a rough cost guide and a price link', () => {
  const misfire = explainFault({ code: 'P0301', state: 'current' });
  assert.match(misfire.cost, /coil|plug/i);
  assert.match(priceSearchUrl(misfire.title), /^https:\/\/www\.google\.com\/search\?tbm=shop/);
  // Unknown codes have no fabricated cost.
  assert.equal(explainFault({ code: 'P3FFF', moduleCode: '09', state: 'current' }).cost, null);
});

test('health check issues expose cost where known', async () => {
  const elm = await connected();
  const r = await runHealthCheck(elm);
  const turbo = r.issues.find((i) => i.code === 'P0299');
  assert.match(turbo.cost, /hose|turbo/i);
});

test('dealer summary includes VIN and unit identifiers', async () => {
  const elm = await connected();
  const d = await diagnoseAppConnect(elm);
  const text = dealerSummary(d);
  assert.match(text, /VIN: WVGZZZ5NZHW000000/);
  assert.match(text, /Part number: 5NA035180/);
  assert.match(text, /App-Connect/);
});

// ---------- trips, vehicle, report diff ----------
import { Trip, fuelRateFrom5E, fuelRateFromMaf, mpgUk } from '../js/trip.js';
import { motCountdown, calendarUrl, cleanReg } from '../js/vehicle.js';
import { diffReports } from '../js/report.js';

test('fuel maths', () => {
  assert.equal(fuelRateFrom5E([0x00, 0x78]), 6); // 120/20 = 6 L/h
  assert.ok(Math.abs(fuelRateFromMaf(10) - 3.28) < 0.1); // 10 g/s petrol ≈ 3.3 L/h
  assert.ok(Math.abs(mpgUk(50, 6) - 23.5) < 0.5); // 50 km/h on 6 L/h ≈ 23.5 mpg
  assert.equal(mpgUk(0, 6), 0);
  assert.equal(mpgUk(50, 0), 0);
});

test('trip accumulates distance, fuel and economy', () => {
  const t = new Trip();
  for (let i = 0; i < 360; i++) t.add(50, 6, 10); // 50 km/h, 6 L/h, 1 hour total
  assert.ok(Math.abs(t.distanceKm - 50) < 0.5);
  assert.ok(Math.abs(t.fuelL - 6) < 0.1);
  assert.ok(Math.abs(t.avgMpg - 23.5) < 0.5);
  assert.equal(t.maxSpeedKmh, 50);
  t.add(50, 6, 999); // absurd gap ignored
  assert.ok(Math.abs(t.distanceKm - 50) < 0.5);
});

test('MOT countdown severity', () => {
  const now = new Date('2026-06-01T12:00:00');
  assert.equal(motCountdown('2026-06-20', now).level, 'minor');
  assert.equal(motCountdown('2026-06-10', now).level, 'soon');
  assert.equal(motCountdown('2026-05-20', now).level, 'urgent');
  assert.equal(motCountdown('', now), null);
  assert.match(calendarUrl('ab17cde', '2026-06-20'), /calendar\.google\.com.*MOT/);
  assert.equal(cleanReg('  ab17 cde '), 'AB17 CDE');
});

test('report diff highlights new and cleared faults', async () => {
  const elm = await connected();
  const before = await runHealthCheck(elm);
  await obd.clearDtcs(elm);
  const after = await runHealthCheck(elm);
  const diff = diffReports(after, before);
  assert.ok(diff.changed);
  assert.ok(diff.cleared.some((i) => i.code === 'P0299')); // cleared since last time
  assert.equal(diff.milChanged, true);
  assert.equal(diffReports(after, null), null);
});

// ---------- car hub (fuel, renewals, mileage) ----------
import { fuelStats, renewals, countdown, mileageSummary, mileageExport, parkMapsUrl, timeAgo } from '../js/garage.js';

test('fuel stats compute MPG between full fill-ups', () => {
  const fills = [
    { date: '2026-01-01', odo: 40000, litres: 50, cost: 70, full: true },
    { date: '2026-01-10', odo: 40300, litres: 20, cost: 28, full: false },
    { date: '2026-01-20', odo: 40600, litres: 40, cost: 56, full: true }, // 600 mi on 60 L
  ];
  const s = fuelStats(fills);
  assert.equal(s.segments.length, 1);
  // 600 miles / (60 / 4.54609 gal) = ~45.5 mpg
  assert.ok(Math.abs(s.segments[0].mpg - 45.5) < 0.5);
  assert.ok(Math.abs(s.latestMpg - 45.5) < 0.5);
  assert.ok(Math.abs(s.segments[0].costPerMile - (84 / 600)) < 0.001); // 28+56 over 600 mi
  assert.equal(s.totalSpend, 154);
  assert.ok(Math.abs(s.lastPricePerLitre - 140) < 0.1); // 56/40 = £1.40 => 140 p/L
});

test('fuel stats cope with no complete segment', () => {
  const s = fuelStats([{ date: '2026-01-01', odo: 40000, litres: 50, cost: 70, full: true }]);
  assert.equal(s.latestMpg, null);
  assert.equal(s.avgMpg, null);
  assert.equal(s.totalSpend, 70);
});

test('renewals sort by urgency and band correctly', () => {
  const now = new Date('2026-06-01T12:00:00');
  const list = renewals({ mot: '2026-06-10', tax: '2026-05-01', insurance: '2026-09-01' }, now);
  assert.deepEqual(list.map((r) => r.key), ['tax', 'mot', 'insurance']); // overdue first
  assert.equal(list[0].level, 'urgent');
  assert.equal(countdown('2026-06-10', 'MOT', now).level, 'soon');
  assert.equal(renewals({}, now).length, 0);
});

test('mileage reclaim uses HMRC bands', () => {
  const m = mileageSummary([
    { miles: 100, business: true },
    { miles: 40, business: false },
  ]);
  assert.equal(m.businessMiles, 100);
  assert.equal(m.totalMiles, 140);
  assert.ok(Math.abs(m.reclaim - 45) < 0.01); // 100 * 0.45
  const big = mileageSummary([{ miles: 12000, business: true }]);
  assert.ok(Math.abs(big.reclaim - (10000 * 0.45 + 2000 * 0.25)) < 0.01);
  assert.match(mileageExport([{ date: '2026-01-01', miles: 10, purpose: 'Venue "A"', business: true }]), /Venue ""A""/);
});

test('parking helpers', () => {
  assert.match(parkMapsUrl({ lat: 51.45, lng: -2.6 }), /destination=51\.45,-2\.6/);
  assert.equal(parkMapsUrl(null), null);
  assert.equal(timeAgo(new Date(Date.now() - 90000).toISOString()), '2 min ago');
});

// ---------- encrypted vault ----------
import { Vault, encryptJSON, decryptJSON } from '../js/vault.js';

const mockStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

test('vault encrypts, rejects wrong passphrase, and never stores plaintext', async () => {
  const blob = await encryptJSON({ passport: 'GB123456', pin: 4242 }, 'correct horse');
  assert.deepEqual(await decryptJSON(blob, 'correct horse'), { passport: 'GB123456', pin: 4242 });
  await assert.rejects(decryptJSON(blob, 'wrong'));
  assert.ok(!JSON.stringify(blob).includes('GB123456'));
  assert.ok(!JSON.stringify(blob).includes('4242'));
});

test('vault: setup, lock, unlock, persistence across instances', async () => {
  const s = mockStorage();
  const v = new Vault(s);
  assert.equal(v.exists(), false);
  await v.setup('mypass', { 'tiguan-docs': [{ label: 'Passport' }] });
  assert.equal(v.exists(), true);
  await v.set('tiguan-fuel', [{ litres: 50 }]);
  v.lock();
  assert.equal(v.locked, true);
  assert.equal(v.get('tiguan-docs', 'LOCKED'), 'LOCKED'); // unreadable while locked

  const reopened = new Vault(s);
  await assert.rejects(reopened.unlock('nope'));
  await reopened.unlock('mypass');
  assert.deepEqual(reopened.get('tiguan-fuel', []), [{ litres: 50 }]);
  assert.deepEqual(reopened.get('tiguan-docs', []), [{ label: 'Passport' }]);
});

test('vault backup restores onto a clean device', async () => {
  const s1 = mockStorage();
  const v1 = new Vault(s1);
  await v1.setup('pw', { 'tiguan-vehicle': { reg: 'AB17 CDE' } });
  const backup = v1.backupBlob();

  const v2 = new Vault(mockStorage());
  await assert.rejects(v2.restore(backup, 'wrong'));
  await v2.restore(backup, 'pw');
  assert.deepEqual(v2.get('tiguan-vehicle', {}), { reg: 'AB17 CDE' });
});

// ---------- unified coming-up dashboard ----------
import { upcomingReminders } from '../js/garage.js';

test('upcomingReminders merges car renewals and document expiries, soonest first', () => {
  const now = new Date('2026-06-01T12:00:00');
  const items = upcomingReminders({
    renewalDates: { mot: '2026-07-01', tax: '2026-05-20' },
    documents: [
      { label: 'Passport', category: 'Passport', expiry: '2026-06-15' },
      { label: 'Gym', category: 'Membership' }, // no date, skipped
    ],
  }, now);
  assert.deepEqual(items.map((i) => i.label), ['Road tax', 'Passport', 'MOT']);
  assert.equal(items[0].level, 'urgent'); // tax overdue
  assert.equal(items[1].sub, 'Passport');
  assert.equal(upcomingReminders({}, now).length, 0);
});

// ---------- deliveries ----------
import { trackingUrl, parcelStatus, parseShared, CARRIER_NAMES } from '../js/deliveries.js';

test('delivery tracking links and status', () => {
  assert.match(trackingUrl('Royal Mail', 'AB123'), /royalmail\.com.*AB123/);
  assert.match(trackingUrl('Evri', 'X9'), /evri\.com\/track\/parcel\/X9/);
  assert.match(trackingUrl('Nonsense', '55'), /google\.com\/search/); // unknown -> search
  const now = new Date('2026-06-01T12:00:00');
  assert.equal(parcelStatus('2026-06-01', now).text, 'Arriving today');
  assert.equal(parcelStatus('2026-06-02', now).text, 'Arriving tomorrow');
  assert.equal(parcelStatus('2026-05-30', now).level, 'soon'); // overdue
  assert.equal(parcelStatus('', now).days, null);
});

test('parseShared pulls item, carrier and tracking from shared text', () => {
  const r = parseShared({ title: 'Your Evri parcel', text: 'Tracking H00ABC12345 is on its way', url: 'https://evri.com/track/H00ABC12345' });
  assert.equal(r.carrier, 'Evri');
  assert.equal(r.tracking, 'H00ABC12345');
  assert.ok(r.item.length > 0);
  assert.ok(CARRIER_NAMES.includes('Amazon'));
});

// ---------- life admin logic (tax, subs, health, meters) ----------
import { incomeTax, employeeNI, dividendTax, takeHome, taxDeadlines, subscriptionsTotal, monthlyEquivalent, nextDue, meterUsage, personalAllowance } from '../js/life.js';

test('UK income tax estimates (England, rough)', () => {
  assert.equal(incomeTax(12570), 0);
  assert.equal(incomeTax(50270), 7540);      // full basic band
  assert.equal(incomeTax(100000), 27432);
  assert.equal(personalAllowance(125140), 0); // fully tapered
  assert.equal(incomeTax(125140), 42516);
});

test('NI and dividend tax', () => {
  assert.equal(employeeNI(50270), 3016);
  assert.equal(dividendTax(0, 10000), Math.round(9500 * 0.0875)); // all basic
  assert.equal(dividendTax(50000, 10000), Math.round((50270 - 50000) * 0.0875 + (10000 - 500 - (50270 - 50000)) * 0.3375));
  const th = takeHome(50270);
  assert.equal(th.net, 50270 - 7540 - 3016);
});

test('tax deadlines are the next 31 Jan and 31 Jul', () => {
  const d = taxDeadlines(new Date('2026-03-01'));
  assert.deepEqual(d.map((x) => x.date), ['2027-01-31', '2026-07-31']);
});

test('subscriptions monthly/yearly totals', () => {
  assert.equal(monthlyEquivalent({ cost: 120, cycle: 'yearly' }), 10);
  const t = subscriptionsTotal([{ cost: 9.99, cycle: 'monthly' }, { cost: 120, cycle: 'yearly' }]);
  assert.ok(Math.abs(t.monthly - 19.99) < 0.001);
  assert.ok(Math.abs(t.yearly - 239.88) < 0.01);
});

test('health next-due and meter usage', () => {
  assert.equal(nextDue('2026-01-15', 6), '2026-07-15');
  assert.equal(nextDue('', 6), null);
  const u = meterUsage([{ date: '2026-01-01', reading: 1000 }, { date: '2026-01-11', reading: 1100 }]);
  assert.equal(u.used, 100);
  assert.equal(u.perDay, 10);
  assert.equal(meterUsage([{ date: '2026-01-01', reading: 1000 }]), null);
});

// ---------- biometric passphrase wrapping ----------
import { wrapSecret, unwrapSecret } from '../js/biometric.js';
import { webcrypto } from 'node:crypto';

test('biometric wrap/unwrap round-trips the passphrase and rejects a wrong key', async () => {
  const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
  const blob = await wrapSecret('my secret passphrase', rawKey);
  assert.equal(await unwrapSecret(blob, rawKey), 'my secret passphrase');
  assert.ok(!JSON.stringify(blob).includes('secret'));
  const wrongKey = webcrypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(unwrapSecret(blob, wrongKey));
});

// ---------- shared household E2E crypto ----------
import { generateHouseholdCode, normalizeCode, householdId, deriveSharedKey, encryptItem, decryptItem, mergeItems } from '../js/household.js';

test('two phones sharing a code derive the same key and id, and interoperate', async () => {
  const code = generateHouseholdCode();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // "Phone A" encrypts; "Phone B" (same code, typed loosely) decrypts.
  const keyA = await deriveSharedKey(code);
  const keyB = await deriveSharedKey(code.toLowerCase().replace(/-/g, ' '));
  const blob = await encryptItem({ item: 'Milk', by: 'Lawrence' }, keyA);
  assert.deepEqual(await decryptItem(blob, keyB), { item: 'Milk', by: 'Lawrence' });
  // Same public id both sides; a different code does not.
  assert.equal(await householdId(code), await householdId(normalizeCode(code)));
  assert.notEqual(await householdId(code), await householdId(generateHouseholdCode()));
  // Server can't read it.
  assert.ok(!JSON.stringify(blob).includes('Milk'));
  // Wrong code cannot decrypt.
  await assert.rejects(decryptItem(blob, await deriveSharedKey(generateHouseholdCode())));
});

test('household id is 32 hex chars (valid server bucket)', async () => {
  assert.match(await householdId('ABCD-EFGH-JKLM-NPQR'), /^[a-f0-9]{32}$/);
});

test('merge is last-write-wins per item', () => {
  const local = { a: { id: 'a', updatedAt: 100, text: 'old' }, b: { id: 'b', updatedAt: 50 } };
  const remote = { a: { id: 'a', updatedAt: 200, text: 'new' }, c: { id: 'c', updatedAt: 10 } };
  const merged = mergeItems(local, remote);
  assert.equal(merged.a.text, 'new');
  assert.equal(merged.b.updatedAt, 50);
  assert.ok(merged.c);
});

// ---------- end-to-end shared sync against a mock server ----------
import http from 'node:http';
import { syncShared } from '../js/sync.js';

function mockSyncServer() {
  const store = new Map();
  const server = http.createServer((req, res) => {
    const id = req.url.split('/').filter(Boolean).pop();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const cur = JSON.parse(store.get(id) || '{"items":{}}');
      if (req.method === 'POST') {
        const incoming = JSON.parse(body);
        for (const [k, v] of Object.entries(incoming.items || {})) {
          if (!cur.items[k] || v.updatedAt > cur.items[k].updatedAt) cur.items[k] = v;
        }
        store.set(id, JSON.stringify(cur));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cur));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}`, server, store })));
}

test('two partners converge through the server, which stores only ciphertext', async () => {
  const { url, server, store } = await mockSyncServer();
  const code = 'ABCD-EFGH-JKLM-NPQR';
  try {
    // Lawrence adds milk.
    let lawrence = await syncShared(url, code, { m1: { text: 'Milk', done: false, updatedAt: 1000, deleted: false } });
    assert.equal(lawrence.m1.text, 'Milk');
    // Jess (same code, separate device) syncs and sees it, then adds bread.
    let jess = await syncShared(url, code, { b1: { text: 'Bread', done: false, updatedAt: 1001, deleted: false } });
    assert.equal(jess.m1.text, 'Milk');
    assert.equal(jess.b1.text, 'Bread');
    // Lawrence syncs again and now sees bread too.
    lawrence = await syncShared(url, code, lawrence);
    assert.equal(lawrence.b1.text, 'Bread');
    // The server's stored blob contains no plaintext.
    const stored = [...store.values()].join('');
    assert.ok(stored.length > 0 && !stored.includes('Milk') && !stored.includes('Bread'));
    // A partner with the wrong code sees nothing of ours.
    const stranger = await syncShared(url, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', {});
    assert.equal(Object.keys(stranger).length, 0);
  } finally {
    server.close();
  }
});

// ---------- passport MRZ parsing ----------
import { parseMRZ, checkDigit } from '../js/mrz.js';

test('parses a standard TD3 passport MRZ', () => {
  const mrz = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10';
  const r = parseMRZ(mrz);
  assert.equal(r.number, 'L898902C3');
  assert.equal(r.expiry, '2012-04-15');
  assert.equal(r.dob, '1974-08-12');
  assert.equal(r.surname, 'ERIKSSON');
  assert.equal(r.given, 'ANNA MARIA');
  assert.equal(r.nationality, 'UTO');
  assert.equal(r.valid, true);
  assert.equal(checkDigit('L898902C3'), 6);
});

test('parseMRZ tolerates noise and missing data', () => {
  const noisy = 'SOME HEADER TEXT\nblurry line\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10\nfooter';
  assert.equal(parseMRZ(noisy).number, 'L898902C3');
  assert.equal(parseMRZ('nothing useful here'), null);
  assert.equal(parseMRZ(''), null);
});

// ---------- encrypted photo storage ----------
import { encryptPhoto, decryptPhoto } from '../js/photos.js';
import { webcrypto as wc2 } from 'node:crypto';

test('photos encrypt/decrypt round-trip and reject wrong key', async () => {
  const key = await wc2.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const dataUrl = 'data:image/jpeg;base64,/9j/EXAMPLE+IMAGE==';
  const blob = await encryptPhoto(dataUrl, key);
  assert.equal(await decryptPhoto(blob, key), dataUrl);
  const other = await wc2.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await assert.rejects(decryptPhoto(blob, other));
});
