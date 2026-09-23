/* Tests for the Verlauf BarChart x-axis tick selection (charts.js:barTicks).
   Regression guard for the "same entries / duplicate labels" bug: ticks used to
   be placed at evenly-spaced *interpolated* timestamps, so at coarse
   resolutions two adjacent ticks fell inside one bucket and rendered the SAME
   label. barTicks now samples ACTUAL bar timestamps, so every tick maps to a
   real bar and no label repeats. */
import test from 'node:test';
import assert from 'node:assert';
import { barTicks } from '../src/charts.js';

/* build N points spaced `slot` seconds apart starting at t0 */
function pts(n, slot, t0) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ t: (t0 || 0) + i * slot, y: i });
  return out;
}
/* the per-resolution label formatters used by verlauf.chartTick */
function dm(ts) { var d = new Date(ts * 1000); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.'; }
function mo(ts) { var d = new Date(ts * 1000); return p2(d.getMonth() + 1) + '.' + d.getFullYear(); }
function q(ts) { var d = new Date(ts * 1000); return d.getFullYear() + ' Q' + (Math.floor(d.getMonth() / 3) + 1); }
function p2(n) { return (n < 10 ? '0' : '') + n; }

function noDupLabels(ticks, fmt, msg) {
  var labels = ticks.map(fmt);
  assert.strictEqual(new Set(labels).size, labels.length, msg + ' — labels: ' + labels.join(' | '));
}
function allRealBars(ticks, points, msg) {
  var known = new Set(points.map(function (p) { return p.t; }));
  ticks.forEach(function (ts) { assert.ok(known.has(ts), msg + ' — tick ' + ts + ' is not a bar'); });
}

test('barTicks: every tick is an actual bar timestamp (daily)', () => {
  var p = pts(10, 86400, 1700000000);
  var ticks = barTicks(p, 600, dm);
  allRealBars(ticks, p, 'daily ticks align to bars');
});

test('barTicks: no duplicate DAY labels with few daily bars (the bug)', () => {
  /* 3 daily bars in a 600px chart — the old timeTicks path produced ~6 ticks
     and repeated dates like "24.05." twice. */
  var p = pts(3, 86400, 1700000000);
  var ticks = barTicks(p, 600, dm);
  noDupLabels(ticks, dm, 'daily');
  assert.ok(ticks.length <= 3 && ticks.length >= 1, 'at most one tick per bar');
});

test('barTicks: single bar yields a single tick', () => {
  var p = pts(1, 86400, 1700000000);
  var ticks = barTicks(p, 600, dm);
  assert.strictEqual(ticks.length, 1);
  assert.strictEqual(ticks[0], p[0].t);
});

test('barTicks: no duplicate QUARTER labels (2026 Q2 shown once)', () => {
  /* quarter buckets ~90d apart; formatting is very low-resolution so the old
     interpolated ticks repeated the same "YYYY Qn" label. */
  var p = [];
  for (var yr = 0; yr < 6; yr++) p.push({ t: Math.floor(Date.UTC(2025, yr * 3, 1) / 1000), y: yr });
  var ticks = barTicks(p, 500, q);
  noDupLabels(ticks, q, 'quarterly');
  allRealBars(ticks, p, 'quarter ticks align to bars');
});

test('barTicks: no duplicate MONTH labels across a full year', () => {
  var p = [];
  for (var m = 0; m < 12; m++) p.push({ t: Math.floor(Date.UTC(2026, m, 1) / 1000), y: m });
  var ticks = barTicks(p, 700, mo);
  noDupLabels(ticks, mo, 'monthly');
  allRealBars(ticks, p, 'month ticks align to bars');
});

test('barTicks: dense series is subsampled, never crowded', () => {
  /* 240 fifteen-minute bars in a 600px chart: innerW≈554 → ≤ ~8 ticks. */
  var p = pts(240, 900, 1700000000);
  var innerW = 554;
  var ticks = barTicks(p, innerW + 60 /*width*/, function (ts) { return String(ts); });
  assert.ok(ticks.length <= Math.floor(innerW / 64) + 1, 'not crowded: ' + ticks.length);
  assert.ok(ticks.length >= 2, 'at least first + last-ish');
  allRealBars(ticks, p, '15m ticks align to bars');
});

test('barTicks: includes first and last bar for a small series', () => {
  var p = pts(5, 604800, 1700000000); /* weekly */
  var ticks = barTicks(p, 600, dm);
  assert.strictEqual(ticks[0], p[0].t, 'first bar labelled');
  assert.strictEqual(ticks[ticks.length - 1], p[p.length - 1].t, 'last bar labelled');
});

test('barTicks: empty points -> no ticks', () => {
  assert.deepStrictEqual(barTicks([], 600, dm), []);
});
