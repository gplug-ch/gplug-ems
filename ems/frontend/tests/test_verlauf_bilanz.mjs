/* Tests for the Verlauf «Bilanz» chart layout (issue #17). The mode used to
   draw two side-by-side stacks per slot, and since prodSelf === consSelf the
   self-use share showed up as two identical yellow bars. It is now ONE signed
   stack: self-use + Einspeisung above the 0-axis, Netzbezug below it. */
import test from 'node:test';
import assert from 'node:assert';
import { buildChart } from '../src/pages/verlauf.js';
import { stackExtents, yDomain } from '../src/charts.js';

var Q = 900, T0 = 1_700_000_000 - (1_700_000_000 % Q);

/* one raw 15-min record */
function rec(ts, pv, exp, imp) {
  return { ts: ts, pv_wh: pv, exp_wh: exp, imp_wh: imp };
}
function segs(point) { return point.bars[0].segments; }
function byLabel(point, label) {
  return segs(point).filter(function (s) { return s.label === label; })[0];
}

/* i18n is not loaded in tests, so t() returns the key itself */
var SELF = 'history.bilanz.selfuse';
var FEED = 'history.bilanz.feedin';
var IMP = 'history.bilanz.import';

test('bilanz: one bar per slot, self-use drawn exactly once', () => {
  var c = buildChart([rec(T0, 3000, 1000, 500)], 'bilanz', false, null);
  var p = c.points[0];
  assert.strictEqual(p.bars.length, 1, 'a single stack per period');
  var selfSegs = segs(p).filter(function (s) { return s.label === SELF; });
  assert.strictEqual(selfSegs.length, 1, 'self-use appears once, not twice');
});

test('bilanz: production stacks up, grid import stacks down', () => {
  var c = buildChart([rec(T0, 3000, 1000, 500)], 'bilanz', false, null);
  var p = c.points[0];
  assert.strictEqual(byLabel(p, SELF).value, 2, 'selbst verbraucht = (pv - exp) kWh');
  assert.strictEqual(byLabel(p, FEED).value, 1, 'eingespeist = exp kWh');
  assert.strictEqual(byLabel(p, IMP).value, -0.5, 'Netzbezug below the 0-axis');
});

test('bilanz: up-stack is the production, |down-stack| the import', () => {
  var c = buildChart([rec(T0, 3000, 1000, 500)], 'bilanz', false, null);
  var ext = stackExtents(c.points[0].bars[0]);
  assert.strictEqual(ext[0], 3, 'up = PV production');
  assert.strictEqual(ext[1], -0.5, 'down = grid import');
});

test('bilanz: night slot (no PV) is a pure downward bar', () => {
  var c = buildChart([rec(T0, 0, 0, 800)], 'bilanz', false, null);
  var ext = stackExtents(c.points[0].bars[0]);
  assert.strictEqual(ext[0], 0, 'nothing above the axis');
  assert.strictEqual(ext[1], -0.8, 'import only');
});

test('bilanz: blank slots stay blank (no zero-height bar)', () => {
  var c = buildChart([{ ts: T0, __blank: true }], 'bilanz', false, null);
  assert.strictEqual(c.points[0].y, null);
  assert.strictEqual(c.points[0].bars, undefined);
});

test('bilanz: legend keeps the three colours/labels', () => {
  var c = buildChart([rec(T0, 3000, 1000, 500)], 'bilanz', false, null);
  assert.deepStrictEqual(c.legend.map(function (l) { return l.label; }),
    [SELF, FEED, IMP]);
  assert.strictEqual(c.yUnit, 'kWh');
});

test('stackExtents: up and down totals never cancel each other out', () => {
  var bar = { segments: [{ value: 2 }, { value: 1 }, { value: -2 }] };
  assert.deepStrictEqual(stackExtents(bar), [3, -2]);
  /* the y-domain must cover both sides */
  var dom = yDomain([3, -2], true);
  assert.ok(dom[0] < -2 && dom[1] > 3, 'domain spans the whole signed stack');
});

test('stackExtents: empty / missing segments → [0, 0]', () => {
  assert.deepStrictEqual(stackExtents({}), [0, 0]);
  assert.deepStrictEqual(stackExtents(null), [0, 0]);
});

/* ---- Netz mode: same sign convention as Bilanz (issue #17 follow-up) ----
   The site GIVES → above the 0-axis, the site TAKES → below it. Netz-kWh used
   to draw Netzbezug upward, i.e. mirrored against Bilanz and against the CHF
   saldo (where a negative value is money owed). */

test('netz kWh: Netzbezug is drawn below the 0-axis', () => {
  var c = buildChart([rec(T0, 0, 0, 1200)], 'net', false, false);
  var p = c.points[0];
  assert.strictEqual(p.y, -1.2, 'import is negative');
  assert.strictEqual(p.color, 'var(--c-import)');
  assert.strictEqual(p.label, 'history.chart.legend_import');
});

test('netz kWh: feed-in is drawn above the 0-axis', () => {
  var r = rec(T0, 3000, 2000, 0);
  var c = buildChart([r], 'net', false);
  var p = c.points[0];
  assert.strictEqual(p.y, 2, 'export is positive');
  assert.strictEqual(p.color, 'var(--c-export)');
  assert.strictEqual(p.label, 'history.chart.legend_export');
});

test('netz kWh: tooltip shows magnitudes (sign is a direction)', () => {
  var c = buildChart([rec(T0, 0, 0, 1200)], 'net', false, false);
  assert.strictEqual(c.signedMagnitude, true);
});

test('netz CHF: the saldo keeps its own sign (a negative saldo is a cost)', () => {
  var r = rec(T0, 0, 0, 1200);
  r.cost_import_chf = 0.5; r.revenue_feedin_chf = 0;
  var c = buildChart([r], 'net', true, false);
  assert.strictEqual(c.points[0].y, -0.5, 'cost below the axis');
  assert.strictEqual(c.signedMagnitude, false, 'CHF stays signed in the tooltip');
});

test('all modes agree: taking is negative, giving is positive', () => {
  var imp = rec(T0, 0, 0, 1000);
  var netY = buildChart([imp], 'net', false, false).points[0].y;
  var bilanzDown = stackExtents(buildChart([imp], 'bilanz', false, false).points[0].bars[0])[1];
  assert.ok(netY < 0 && bilanzDown < 0, 'grid import points down in both modes');
  assert.strictEqual(netY, bilanzDown, 'and by the same amount');
});
