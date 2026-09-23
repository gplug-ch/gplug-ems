/* Tests for lib/metercat.js — the browser-side smart-meter field catalog and
   derivations (spec 007). Pure functions, no DOM. */
import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeName, lookup, schieflast, cosphi, kwToW, isStale, voltageStat, peakStat,
  foldPair, powerScale,
} from '../src/lib/metercat.js';

/* --- normalizeName --- */
test('normalizeName strips case and punctuation', () => {
  assert.strictEqual(normalizeName('U_L1'), 'ul1');
  assert.strictEqual(normalizeName('32_7_0'), '3270');
  assert.strictEqual(normalizeName('32.7.0'), '3270');
  assert.strictEqual(normalizeName('Voltage L1'), 'voltagel1');
  assert.strictEqual(normalizeName(null), '');
});

/* --- lookup: canonical + variants + OBIS + unknown --- */
test('lookup resolves the gPlug default fields', () => {
  assert.strictEqual(lookup('Pi').group, 'power');
  assert.strictEqual(lookup('Pi').kind, 'live');
  assert.strictEqual(lookup('Po').i18nKey, 'meter.f.power_export');
});

test('lookup resolves per-phase voltage by name variants and OBIS', () => {
  for (const name of ['U1', 'U_L1', 'volt_l1', 'Voltage_L1', '32.7.0', '32_7_0']) {
    const d = lookup(name);
    assert.ok(d, 'expected a descriptor for ' + name);
    assert.strictEqual(d.group, 'phases');
    assert.strictEqual(d.role, 'voltage');
    assert.strictEqual(d.phase, 1);
    assert.strictEqual(d.unit, 'V');
  }
});

test('lookup resolves per-phase current and power for L2/L3', () => {
  assert.strictEqual(lookup('I2').role, 'current');
  assert.strictEqual(lookup('I2').phase, 2);
  assert.strictEqual(lookup('61.7.0').role, 'power'); // P3
  assert.strictEqual(lookup('61.7.0').phase, 3);
});

test('lookup marks energy registers as authoritative registers', () => {
  assert.strictEqual(lookup('E_in').kind, 'register');
  assert.strictEqual(lookup('1.8.0').i18nKey, 'meter.f.energy_import');
  assert.strictEqual(lookup('2.8.0').unit, 'kWh');
});

test('lookup resolves tariff and meter id as meta', () => {
  assert.strictEqual(lookup('Tariff').group, 'tariff');
  assert.strictEqual(lookup('Meter_id').group, 'meta');
});

test('lookup returns null for unknown fields', () => {
  assert.strictEqual(lookup('Frequency'), null);
  assert.strictEqual(lookup('totally_unknown_42'), null);
});

/* --- schieflast --- */
test('schieflast is max−min of present phases', () => {
  assert.strictEqual(schieflast([1000, 800, 600]), 400);
});
test('schieflast ignores missing phases, needs ≥2', () => {
  assert.strictEqual(schieflast([1000, null, undefined]), null);
  assert.strictEqual(schieflast([1000, 700]), 300);
  assert.strictEqual(schieflast([]), null);
});

/* --- cosphi --- */
test('cosphi = |P|/√(P²+Q²)', () => {
  assert.strictEqual(cosphi(3, 4), 0.6);      // |3|/5
  assert.ok(Math.abs(cosphi(1000, 0) - 1) < 1e-9);
});
test('cosphi needs both P and Q, guards zero apparent power', () => {
  assert.strictEqual(cosphi(1000, null), null);
  assert.strictEqual(cosphi(0, 0), null);
});

/* --- kwToW --- */
test('kwToW normalises kW to W, passes W through', () => {
  assert.strictEqual(kwToW(1.5, 'kW'), 1500);
  assert.strictEqual(kwToW(1500, 'W'), 1500);
  assert.strictEqual(kwToW(null, 'kW'), null);
});

/* --- isStale --- */
test('isStale fires when the import register is frozen while importing', () => {
  const frozen = [];
  for (let i = 0; i < 6; i++) frozen.push({ reg: 12345.6, importing: true });
  assert.strictEqual(isStale(frozen), true);
});
test('isStale is false when the register still moves', () => {
  const moving = [];
  for (let i = 0; i < 6; i++) moving.push({ reg: 12345.6 + i * 0.01, importing: true });
  assert.strictEqual(isStale(moving), false);
});
test('isStale is false when not importing or too few samples', () => {
  const frozenExport = [];
  for (let i = 0; i < 6; i++) frozenExport.push({ reg: 100, importing: false });
  assert.strictEqual(isStale(frozenExport), false);
  assert.strictEqual(isStale([{ reg: 1, importing: true }]), false);
});
test('isStale is false when register readings are missing', () => {
  const withNull = [];
  for (let i = 0; i < 6; i++) withNull.push({ reg: null, importing: true });
  assert.strictEqual(isStale(withNull), false);
});

/* --- voltageStat (zero-glitch rule) --- */
test('voltageStat ignores exact-zero voltage glitches', () => {
  let s = null;
  s = voltageStat(s, 231.2);
  s = voltageStat(s, 0);       // glitch — must not become the new min
  s = voltageStat(s, 229.8);
  assert.strictEqual(s.min, 229.8);
  assert.strictEqual(s.max, 231.2);
});
test('voltageStat handles first reading and non-numbers', () => {
  assert.deepStrictEqual(voltageStat(null, 230), { min: 230, max: 230 });
  assert.strictEqual(voltageStat(null, 'x'), null);
});

/* --- peakStat --- */
test('peakStat tracks the running maximum', () => {
  let p = 0;
  p = peakStat(p, 1200);
  p = peakStat(p, 800);
  p = peakStat(p, 1500);
  assert.strictEqual(p, 1500);
});


/* --- real gPlug SMI descriptor (Landis+Gyr via 192.168.0.130) --------------
   Totals in kW, per-phase in W, per-phase power as an import/export pair. */
const LIVE = {
  V1: 237, V2: 236, V3: 237,
  I1: 2.08, I2: 1.16, I3: 1.77,
  Pi: 0, Po: 0.117,
  P1i: 0, P1o: 154, P2i: 23, P2o: 0, P3i: 14, P3o: 0,
  rPi: 0, rPo: 838, pf1: 0.39,
  Ei: 55909.734375, Eo: 42118, rEi: 10468.893555, rEo: 26030.423828,
  SMid: 32942200,
};

test('lookup resolves every field of the live gPlug descriptor', () => {
  for (const name of Object.keys(LIVE)) {
    assert.ok(lookup(name), 'no descriptor for ' + name);
  }
});

test('lookup maps the live descriptor to the right roles', () => {
  assert.strictEqual(lookup('V2').role, 'voltage');
  assert.strictEqual(lookup('V2').phase, 2);
  assert.strictEqual(lookup('P1o').role, 'power');
  assert.strictEqual(lookup('P1o').phase, 1);
  assert.strictEqual(lookup('P1o').dir, 'out');
  assert.strictEqual(lookup('P1i').dir, 'in');
  assert.strictEqual(lookup('pf1').role, 'pf');
  assert.strictEqual(lookup('rPo').i18nKey, 'meter.f.reactive_export');
  assert.strictEqual(lookup('Ei').i18nKey, 'meter.f.energy_import');
  assert.strictEqual(lookup('Eo').kind, 'register');
  assert.strictEqual(lookup('rEi').i18nKey, 'meter.f.reactive_energy_import');
  assert.strictEqual(lookup('SMid').group, 'meta');
});

test('the signed P1..P3 rows stay pair-free so the page can tell them apart', () => {
  assert.strictEqual(lookup('P1').dir, undefined);
  assert.strictEqual(lookup('61.7.0').dir, undefined);
});

/* --- foldPair --- */
test('foldPair folds an import/export pair into a signed value', () => {
  assert.strictEqual(foldPair(0, 154), -154);
  assert.strictEqual(foldPair(23, 0), 23);
  assert.strictEqual(foldPair(null, 117), -117);
  assert.strictEqual(foldPair(800, null), 800);
  assert.strictEqual(foldPair(null, null), null);
});

/* --- powerScale --- */
test('powerScale detects kW totals against the per-phase sum', () => {
  /* live case: Pi−Po = −0.117 kW, phases sum to −117 W */
  assert.strictEqual(powerScale(-0.117, -117), 1000);
  assert.strictEqual(powerScale(0.117, -117), 1000); // sign-agnostic
});

test('powerScale leaves W totals alone', () => {
  assert.strictEqual(powerScale(-117, -117), 1);
  assert.strictEqual(powerScale(1200, 1201), 1);
});

test('powerScale refuses to judge without a usable comparison', () => {
  assert.strictEqual(powerScale(-0.117, null), 1);
  assert.strictEqual(powerScale(-0.117, 2), 1);   // phase sum too small
  assert.strictEqual(powerScale(0, 117), 1);      // no total to scale
  assert.strictEqual(powerScale(NaN, 117), 1);
});
