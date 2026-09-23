/* Tests for the Verlauf chart window (verlauf.js:chartWindow). The bar chart is
   a fixed recent window on a CONTINUOUS time grid: missing slots become blank
   sentinels so gaps stay visible and bars from different days never collapse
   next to each other. */
import test from 'node:test';
import assert from 'node:assert';
import { chartWindow, prevSlot, CHART_SLOTS } from '../src/pages/verlauf.js';

var HOUR = 3600, Q = 900, DAY = 86400;
/* rows are newest-first, as the component passes them */
function rowsDesc(startTs, step, n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ ts: startTs - i * step, imp_wh: 100 });
  return out;
}

test('1h window caps at CHART_SLOTS[1h] = 24, newest-first, contiguous', () => {
  var newest = 1_700_000_000 - (1_700_000_000 % HOUR);
  var rows = rowsDesc(newest, HOUR, 100);
  var w = chartWindow(rows, '1h');
  assert.strictEqual(w.length, 24, '24 slots');
  assert.strictEqual(w[0].ts, newest, 'starts at newest');
  for (var i = 1; i < w.length; i++) {
    assert.strictEqual(w[i].ts, w[i - 1].ts - HOUR, 'each step is one hour back');
    assert.ok(!w[i].__blank, 'no blanks when data is contiguous');
  }
});

test('15m window caps at 32 slots of 15 minutes', () => {
  var newest = 1_700_000_000 - (1_700_000_000 % Q);
  var w = chartWindow(rowsDesc(newest, Q, 240), '15m');
  assert.strictEqual(w.length, 32);
  assert.strictEqual(w[31].ts, newest - 31 * Q, 'spans exactly 32 quarter-hours');
});

test('missing hours become blank sentinels (days not mixed)', () => {
  var newest = 1_700_000_000 - (1_700_000_000 % HOUR);
  /* present: newest and newest-5h only; the four hours between are missing */
  var rows = [{ ts: newest, imp_wh: 100 }, { ts: newest - 5 * HOUR, imp_wh: 100 }];
  var w = chartWindow(rows, '1h');
  /* clamped to the oldest row → 6 slots (newest … newest-5h) */
  assert.strictEqual(w.length, 6, 'clamped to oldest row, not padded to 24');
  assert.ok(!w[0].__blank && w[0].imp_wh === 100, 'newest present');
  assert.ok(w[1].__blank && w[2].__blank && w[3].__blank && w[4].__blank, 'gap slots blank');
  assert.ok(!w[5].__blank, 'oldest present');
  /* the gap is preserved as 4 explicit blanks — not collapsed */
  var blanks = w.filter(function (s) { return s.__blank; }).length;
  assert.strictEqual(blanks, 4);
});

test('does not step older than the oldest row (no pre-data blanks)', () => {
  var newest = 1_700_000_000 - (1_700_000_000 % HOUR);
  var w = chartWindow(rowsDesc(newest, HOUR, 5), '1h'); /* only 5h of data */
  assert.strictEqual(w.length, 5, 'stops at oldest, no leading blanks');
  assert.ok(w.every(function (s) { return !s.__blank; }));
});

test('empty rows → empty window', () => {
  assert.deepStrictEqual(chartWindow([], '1h'), []);
});

test('prevSlot: constant-length resolutions step by seconds', () => {
  assert.strictEqual(prevSlot(1_700_000_000, '1h'), 1_700_000_000 - HOUR);
  assert.strictEqual(prevSlot(1_700_000_000, '15m'), 1_700_000_000 - Q);
  assert.strictEqual(prevSlot(1_700_000_000, '1d'), 1_700_000_000 - DAY);
  assert.strictEqual(prevSlot(1_700_000_000, '1w'), 1_700_000_000 - 7 * DAY);
});

test('prevSlot: months/quarters step by calendar (UTC), variable length', () => {
  var mar1 = Math.floor(Date.UTC(2026, 2, 1) / 1000); /* 2026-03-01 */
  var feb1 = Math.floor(Date.UTC(2026, 1, 1) / 1000);
  assert.strictEqual(prevSlot(mar1, '1mo'), feb1, 'March → February (28-day gap handled)');
  var apr1 = Math.floor(Date.UTC(2026, 3, 1) / 1000);
  var jan1 = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  assert.strictEqual(prevSlot(apr1, '1q'), jan1, 'Q2 → Q1');
});

test('CHART_SLOTS carries the requested fine-resolution windows', () => {
  assert.strictEqual(CHART_SLOTS['1h'], 24);
  assert.strictEqual(CHART_SLOTS['15m'], 32);
});
