import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countryCode, checkPassport, tripChecks, tripStatus, tripCalendarRows, matchTrip, timeline, flag } from '../js/travel.js';

const trip = { id: 't1', title: 'Mallorca', destinations: [{ iso: 'ES' }], start: '2027-02-13', end: '2027-02-20', bookings: [] };

test('works out the country from places people type', () => {
  assert.equal(countryCode('Spain'), 'ES');
  assert.equal(countryCode('Mallorca'), 'ES');
  assert.equal(countryCode('Orlando, Florida'), 'US');
  assert.equal(countryCode('fr'), 'FR');
  assert.equal(countryCode('Narnia'), '');
  assert.equal(flag('ES'), '🇪🇸');
});

test('Schengen: valid 3 months after you leave, and issued under 10 years ago', () => {
  assert.equal(checkPassport({ name: 'Maddy', passportExpiry: '2030-01-01', passportIssued: '2025-01-01' }, trip, 'ES'), null);
  assert.match(checkPassport({ name: 'Maddy', passportExpiry: '2027-04-01' }, trip, 'ES').text, /3 months after you leave/);
  assert.equal(checkPassport({ name: 'Maddy', passportExpiry: '2027-05-20' }, trip, 'ES'), null, 'exactly 3 months is fine');
  // issued 10+ years before arrival (an old 10y9m passport)
  assert.match(checkPassport({ name: 'Lawrence', passportExpiry: '2027-09-01', passportIssued: '2016-12-01' }, trip, 'ES').text, /10 years/);
  assert.match(checkPassport({ name: 'Jess', passportExpiry: '2027-02-15' }, trip, 'ES').text, /runs out before you get home/);
  assert.equal(checkPassport({ name: 'Jess' }, trip, 'ES').level, 'info');
});

test('other destinations: Turkey 150 days, UAE 6 months from arrival, USA for the stay', () => {
  assert.ok(checkPassport({ name: 'A', passportExpiry: '2027-06-01' }, trip, 'TR'), '108 days is too short');
  assert.equal(checkPassport({ name: 'A', passportExpiry: '2027-07-20' }, trip, 'TR'), null);
  assert.ok(checkPassport({ name: 'A', passportExpiry: '2027-07-01' }, trip, 'AE'));
  assert.equal(checkPassport({ name: 'A', passportExpiry: '2027-02-21' }, trip, 'US'), null);
});

test('trip checks: passports, ESTA, GHIC, insurance and check-in at the right time', () => {
  const people = [{ id: 'c1', name: 'Maddy', passportExpiry: '2027-03-01' }, { id: 'c2', name: 'Sam', passportExpiry: '2032-01-01', ghicExpiry: '2030-01-01' }];
  const far = tripChecks(trip, people, '2026-11-24');
  assert.deepEqual(far.map((c) => c.kind), ['passport'], 'only the passport, months ahead');
  const near = tripChecks({ ...trip, bookings: [{ kind: 'flight', flightNo: 'BA2650', depart: '2027-02-13T08:40' }] }, people, '2027-02-12');
  assert.deepEqual(near.map((c) => c.kind).sort(), ['auth', 'checkin', 'ghic', 'insurance', 'passport']);
  assert.match(near.find((c) => c.kind === 'ghic').text, /Maddy has/);
  const usa = tripChecks({ ...trip, destinations: [{ iso: 'US' }] }, [], '2027-01-20');
  assert.match(usa.find((c) => c.kind === 'auth').text, /ESTA/);
  assert.deepEqual(tripChecks(trip, people, '2027-03-01'), [], 'nothing once the trip is over');
  assert.equal(tripChecks({ ...trip, travellers: ['c2'] }, people, '2026-11-24').length, 0, 'only the people going');
});

test('status, calendar rows, booking order and matching', () => {
  assert.equal(tripStatus(trip, '2027-02-01'), 'in 12 days');
  assert.equal(tripStatus(trip, '2027-02-15'), 'day 3 of 8');
  assert.equal(tripStatus(trip, '2027-02-20'), 'home today');
  const t2 = { ...trip, bookings: [{ id: 'b2', kind: 'stay', name: 'Hotel Sol', checkIn: '2027-02-13T15:00' }, { id: 'b1', kind: 'flight', flightNo: 'BA2650', from: 'LGW', to: 'PMI', depart: '2027-02-13T08:40' }] };
  const rows = tripCalendarRows(t2, '2027-02-12', '2027-02-14');
  assert.equal(rows.filter((r) => !r.time).length, 2, 'one all-day row per day in range');
  assert.ok(rows.some((r) => r.time === '08:40' && /BA2650 LGW→PMI/.test(r.title)));
  assert.deepEqual(timeline(t2).map((b) => b.id), ['b1', 'b2']);
  assert.equal(matchTrip([trip], '2027-02-21')?.id, 't1');
  assert.equal(matchTrip([trip], '2027-03-01'), null);
});

test('airport codes find the country', () => {
  assert.equal(countryCode('CDG'), 'FR');
  assert.equal(countryCode('pmi'), 'ES');
  assert.equal(countryCode('DLM'), 'TR');
});
