import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOn, ageText, nextBirthday, mask } from '../js/family.js';

test('age on a given day', () => {
  assert.equal(ageOn('2019-03-15', '2026-11-23'), 7);
  assert.equal(ageOn('2019-11-23', '2026-11-23'), 7); // birthday today
  assert.equal(ageOn('2019-11-24', '2026-11-23'), 6); // tomorrow
  assert.equal(ageOn('2030-01-01', '2026-11-23'), null);
  assert.equal(ageOn('', '2026-11-23'), null);
});

test('friendly age for babies and children', () => {
  assert.equal(ageText('2026-11-01', '2026-11-23'), 'newborn');
  assert.equal(ageText('2026-05-10', '2026-11-23'), '6 months');
  assert.equal(ageText('2025-11-23', '2026-11-23'), '12 months');
  assert.equal(ageText('2024-06-01', '2026-11-23'), '2 years');
  assert.equal(ageText('2019-03-15', '2026-11-23'), '7 years');
});

test('next birthday, including today and 29 February', () => {
  assert.deepEqual(nextBirthday('2019-12-07', '2026-11-23'), { date: '2026-12-07', turning: 7 });
  assert.deepEqual(nextBirthday('2019-03-15', '2026-11-23'), { date: '2027-03-15', turning: 8 });
  assert.deepEqual(nextBirthday('2019-11-23', '2026-11-23'), { date: '2026-11-23', turning: 7 });
  assert.deepEqual(nextBirthday('2020-02-29', '2026-11-23'), { date: '2027-02-28', turning: 7 });
  assert.deepEqual(nextBirthday('2020-02-29', '2027-12-01'), { date: '2028-02-29', turning: 8 });
});

test('masking keeps only the last 3 characters and the spacing', () => {
  assert.equal(mask('485 777 3456'), '••• ••• •456');
  assert.equal(mask('123456789'), '••••••789');
  assert.equal(mask('AB'), 'AB');
  assert.equal(mask(''), '');
});

test('NHS number check digit', async () => {
  const { nhsNumberValid } = await import('../js/family.js');
  assert.equal(nhsNumberValid('943 476 5919'), true); // NHS's published example
  assert.equal(nhsNumberValid('9434765918'), false); // one digit wrong
  assert.equal(nhsNumberValid('12345'), false);
  assert.equal(nhsNumberValid(''), false);
});
