import test from 'node:test';
import assert from 'node:assert/strict';
import { seededShuffle } from '../src/api';
test('seeded shuffle is deterministic and keeps every option', () => {
  const input = ['alpha', 'beta', 'gamma', 'delta'];
  const first = seededShuffle(input, 'session:card:0');
  assert.deepEqual(seededShuffle(input, 'session:card:0'), first);
  assert.deepEqual([...first].sort(), [...input].sort());
});
test('later appearances can place options in a different order', () => {
  const input = ['alpha', 'beta', 'gamma', 'delta'];
  const orders = new Set(
    ['0', '1', '2', '3', '4', '5'].map((n) => seededShuffle(input, `session:card:${n}`).join('|')),
  );
  assert.ok(orders.size > 1);
});
test('seeded shuffle does not mutate the stored option order', () => {
  const input = ['alpha', 'beta', 'gamma', 'delta'];
  seededShuffle(input, 'session:card:2');
  assert.deepEqual(input, ['alpha', 'beta', 'gamma', 'delta']);
});
