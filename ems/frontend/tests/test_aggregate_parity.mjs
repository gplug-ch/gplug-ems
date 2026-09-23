/* Roll-up parity (spec 011 FR-1106): the browser's 1d/1mo roll-up must equal
   the roll-up the DEVICE produced for the same 15-min input, so moving the
   history into the browser archive (issue #7) changes no number the user sees.

   The fixture was generated once from the pre-removal store.be with
   ems/backend/tests/gen_rollup_fixture.be. Issue #8 (spec 011 step 3b) deleted
   both the device roll-ups and that generator, so the committed JSON is the
   frozen source of truth from here on — its last working revision is commit
   66e1d7a (`git show 66e1d7a:ems/backend/tests/gen_rollup_fixture.be`). */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as agg from '../src/lib/aggregate.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/rollup_parity.json', import.meta.url)));
const WH = ['imp_wh', 'exp_wh', 'pv_wh'];

function byTs(rows) {
  const m = new Map();
  rows.forEach(function (r) { m.set(r.ts, r); });
  return m;
}

/* The fixture also carries the device's former community-share fields; only
   the raw Wh fields are compared. */
function parity(target, deviceRows) {
  const js = agg.aggregate(fx.input, '15m', target, {});
  const dev = byTs(deviceRows);
  assert.strictEqual(js.length, deviceRows.length,
    target + ': bucket count differs (js ' + js.length + ' vs device ' + deviceRows.length + ')');
  const newest = deviceRows.length ? deviceRows[deviceRows.length - 1].ts : -1;
  js.forEach(function (r) {
    const d = dev.get(r.ts);
    assert.ok(d, target + ': device has no bucket at ts ' + r.ts);
    WH.forEach(function (f) {
      const dv = d[f] === undefined ? null : d[f];
      const jv = r[f] === undefined ? null : r[f];
      assert.strictEqual(jv, dv, target + ' ts ' + r.ts + ' field ' + f);
    });
    /* `partial` semantics: the device flags a bucket only when a summed field
       stayed nil for the whole bucket (or the record is still open); the
       browser flags it additionally when SOME contributing slot had a hole.
       The browser flag must therefore be a superset — never the reverse, which
       would hide incomplete data.

       The one exception is the newest bucket: the device knows its running
       record is still open, which is not derivable from the records alone —
       the page marks the bucket containing `now` as open instead. */
    if (d.partial && r.ts !== newest) {
      assert.ok(r.partial, target + ' ts ' + r.ts + ': device partial not propagated');
    }
  });
}

test('1d roll-up matches the device', function () {
  parity('1d', fx.day);
});

test('1mo roll-up matches the device', function () {
  parity('1mo', fx.month);
});

test('fixture is the pre-removal device output', function () {
  assert.ok(fx.input.length > 500 && fx.day.length > 60 && fx.month.length >= 3,
    'fixture too small to prove day and month boundaries');
});
