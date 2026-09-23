import test from 'node:test';
import assert from 'node:assert';

/* --- mergeHistory: archived sparkline points folded into the live ring ---- */
import { mergeHistory } from '../src/pages/uebersicht.js';

test('mergeHistory prepends archived points, oldest first', () => {
  const map = { pv1: [{ t: 300, y: 30 }] };
  mergeHistory(map, { pv1: [{ t: 100, y: 10 }, { t: 200, y: 20 }] });
  assert.deepStrictEqual(map.pv1,
    [{ t: 100, y: 10 }, { t: 200, y: 20 }, { t: 300, y: 30 }]);
});

test('mergeHistory keeps the live point on a duplicate timestamp', () => {
  const map = { pv1: [{ t: 100, y: 99 }] };
  mergeHistory(map, { pv1: [{ t: 100, y: 10 }] });
  assert.deepStrictEqual(map.pv1, [{ t: 100, y: 99 }]);
});

test('mergeHistory creates rings for ids the poll has not seen yet', () => {
  const map = {};
  mergeHistory(map, { dryer: [{ t: 100, y: 0 }] });
  assert.deepStrictEqual(map.dryer, [{ t: 100, y: 0 }]);
});

test('mergeHistory drops the oldest beyond MAX_SAMPLES (90)', () => {
  const map = { pv1: [{ t: 1000, y: 1 }] };
  const stored = [];
  for (let i = 0; i < 120; i++) stored.push({ t: i, y: i });
  mergeHistory(map, { pv1: stored });
  assert.strictEqual(map.pv1.length, 90);
  assert.strictEqual(map.pv1[map.pv1.length - 1].t, 1000, 'newest survives');
  assert.strictEqual(map.pv1[0].t, 31);
});

test('mergeHistory on empty archive leaves the ring untouched', () => {
  const map = { pv1: [{ t: 100, y: 1 }] };
  mergeHistory(map, {});
  mergeHistory(map, null);
  assert.deepStrictEqual(map.pv1, [{ t: 100, y: 1 }]);
});

/* --- staleNote (issue #15): «no current data» note for a stale production -- */
import { staleNote } from '../src/pages/uebersicht.js';

test('staleNote: only for stale:true', () => {
  assert.strictEqual(staleNote({ id: 'pv', currentPower: 500 }, 1790000000), null);
  assert.strictEqual(staleNote({ id: 'pv', stale: false, lastUpdate: 1 }, 1790000000), null);
  assert.strictEqual(staleNote(null, 1790000000), null);
});

test('staleNote: stale with / without lastUpdate', () => {
  /* no dictionary loaded in node: t() returns the key */
  assert.strictEqual(staleNote({ stale: true, lastUpdate: 1790000000 }, 1790003600), 'prod.stale');
  assert.strictEqual(staleNote({ stale: true }, 1790003600), 'prod.stale_unknown');
});
