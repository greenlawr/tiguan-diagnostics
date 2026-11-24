import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractNudge, priceChange, councilTax, guessPolicyKind, policyNudge } from '../js/bills.js';

test('contract nudges: ending soon, out of contract, and paid-off phones', () => {
  assert.equal(contractNudge({ type: 'Broadband', renewal: '2027-06-01' }, '2026-11-24'), null, 'months away');
  assert.match(contractNudge({ type: 'Broadband', renewal: '2026-12-20' }, '2026-11-24').text, /Contract ends 20 Dec 2026 \(26 days\)/);
  assert.equal(contractNudge({ type: 'Broadband', renewal: '2026-12-20' }, '2026-11-24').level, 'soon');
  assert.match(contractNudge({ type: 'TV', renewal: '2026-03-01' }, '2026-11-24').text, /Out of contract since 1 Mar 2026/);
  const phone = contractNudge({ type: 'Mobile', handset: 'included', provider: 'EE', renewal: '2026-05-01' }, '2026-11-24');
  assert.equal(phone.level, 'urgent');
  assert.match(phone.text, /SIM-only/);
  assert.equal(contractNudge({ type: 'Water', renewal: '2026-01-01' }, '2026-11-24'), null, "can't switch water");
});

test('price creep, council tax and policy types', () => {
  assert.deepEqual(priceChange(412, 365), { diff: 47, pct: 13, level: 'urgent', text: 'up 13% on last year' });
  assert.equal(priceChange(300, 320).text, 'down 6% on last year');
  assert.equal(priceChange(300, ''), null);
  assert.deepEqual(councilTax(2400, 10), { instalment: 240, instalments: 10, monthlyAverage: 200 });
  assert.equal(councilTax(2400, 12).instalment, 200);
  assert.equal(guessPolicyKind('Admiral car insurance'), 'car');
  assert.equal(guessPolicyKind('Home & contents — Aviva'), 'home');
  assert.equal(guessPolicyKind('PetPlan for the dog'), 'pet');
  assert.equal(guessPolicyKind('British Gas HomeCare'), 'boiler');
  assert.equal(guessPolicyKind('Something'), 'other');
});

test('policy renewal nudge mentions price rises and auto-renewal', () => {
  const p = { renewal: '2026-12-10', premium: 412, lastPremium: 365, autoRenew: true };
  const n = policyNudge(p, '2026-11-24');
  assert.equal(n.level, 'soon');
  assert.match(n.text, /up 13% on last year/);
  assert.match(n.text, /renews automatically/);
  assert.equal(policyNudge({ renewal: '2027-06-01' }, '2026-11-24'), null);
  assert.equal(policyNudge({ renewal: '2026-11-01' }, '2026-11-24').level, 'urgent');
});
