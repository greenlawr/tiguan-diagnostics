import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../js/vault.js';

const memStorage = () => { const m = new Map(); let writes = 0; return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { writes++; m.set(k, v); }, removeItem: (k) => m.delete(k), get writes() { return writes; } }; };

test('a big vault (1 MB+) still saves and opens again', async () => {
  const storage = memStorage();
  const v = new Vault(storage);
  await v.setup('correct horse battery');
  const events = {};
  for (let i = 0; i < 3000; i++) events['e' + i] = { id: 'e' + i, type: 'event', title: 'Swimming lesson number ' + i, date: '2026-12-01', where: 'Leisure centre, somewhere in town' };
  await v.set('tiguan-shared', events);
  const again = new Vault(storage);
  await again.unlock('correct horse battery');
  assert.equal(Object.keys(again.get('tiguan-shared', {})).length, 3000);
});

test('many saves in a row share one write, and the last value wins', async () => {
  const storage = memStorage();
  const v = new Vault(storage);
  await v.setup('correct horse battery');
  const before = storage.writes;
  const all = [];
  for (let i = 0; i < 50; i++) all.push(v.set('n', i));
  await Promise.all(all);
  assert.ok(storage.writes - before <= 2, `only ${storage.writes - before} writes`);
  const again = new Vault(storage);
  await again.unlock('correct horse battery');
  assert.equal(again.get('n'), 49);
});
