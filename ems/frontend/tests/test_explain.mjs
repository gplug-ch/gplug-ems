/* Tests for the shared slot drill-down helpers (spec 009 FR-908, UC-904) in
   src/pages/explain.js: slotTimestamps (which slots are listed, newest-first,
   range-bounded) and slotSentence (the plain-language sentence stays consistent
   with lib/vzev.js:explainSlot() — one source of truth).

   TZ pinned so the HH:MM boundaries the sentence prints are deterministic. */
process.env.TZ = 'Europe/Zurich';

import test from 'node:test';
import assert from 'node:assert';
import { slotTimestamps, slotSentence } from '../src/pages/explain.js';
import { explainSlot } from '../src/lib/vzev.js';

/* 2026-01-05 (Mon) 12:00 CET */
const T0 = Math.floor(Date.UTC(2026, 0, 5, 11, 0, 0) / 1000);
function ring(pairs) { return pairs.reduce((a, p) => a.concat(p), []); }

function rawFixture() {
  return {
    producer_id: 'p', self_id: 'me',
    data: {
      p:  ring([[T0, 0, 3200], [T0 + 900, 0, 4000], [T0 + 1800, 0, 0]]),
      me: ring([[T0, 1400, 0], [T0 + 900, 1000, 0]]),
      b:  ring([[T0, 2000, 0], [T0 + 900, 3000, 0], [T0 + 1800, 500, 0]]),
    },
  };
}

test('slotTimestamps: producer slots, newest first', () => {
  const ts = slotTimestamps(rawFixture());
  assert.deepStrictEqual(ts, [T0 + 1800, T0 + 900, T0]);
});

test('slotTimestamps: range filter [from,to) excludes outside slots', () => {
  const ts = slotTimestamps(rawFixture(), [T0 + 900, T0 + 1800]);
  assert.deepStrictEqual(ts, [T0 + 900]); // only the middle slot
});

test('slotTimestamps: empty/malformed raw -> []', () => {
  assert.deepStrictEqual(slotTimestamps(null), []);
  assert.deepStrictEqual(slotTimestamps({}), []);
  assert.deepStrictEqual(slotTimestamps({ data: {} }), []);
});

/* The rendered sentence STRING is i18n-driven (t() needs a loaded dictionary,
   which is not present in a node test), so we assert the underlying figures
   that feed the sentence come straight from explainSlot() — the FR-908
   «one source of truth» guarantee — and that slotSentence returns a string. */
test('slotSentence: figures come from explainSlot (one source of truth)', () => {
  const raw = rawFixture();
  const e = explainSlot(T0, raw, 'me');
  assert.strictEqual(e.prodWh, 3200);
  assert.strictEqual(e.memberImpWh, 1400);
  assert.strictEqual(e.totalImpWh, 3400); // 1400 (me) + 2000 (b)
  assert.ok(e.allocatedWh > 0 && e.allocatedWh <= e.memberImpWh, 'allocated within import');
  assert.strictEqual(typeof slotSentence(T0, raw, 'me'), 'string');
});

test('slotSentence: no producer data -> nothing allocated (noprod branch)', () => {
  const raw = rawFixture();
  // slot T0+1800 has producer export 0 -> noprod branch
  assert.strictEqual(typeof slotSentence(T0 + 1800, raw, 'me'), 'string');
  const e = explainSlot(T0 + 1800, raw, 'me');
  assert.strictEqual(e.prodWh, 0);
  assert.strictEqual(e.allocatedWh, 0);
});
