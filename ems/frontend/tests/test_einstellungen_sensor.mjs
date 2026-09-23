/* issue #10: gplug items may name the read_sensors() object to read from via
   an optional "sensor" key (e.g. "SMA" for an attached inverter). Blank means
   the smart-meter object "z" and is dropped from site.json on save. */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateProduction, validateGrid, validateDocument, dropBlankGplugKeys
} from '../src/pages/einstellungen.js';

const SMA = { id: 'pv-sma', integration: 'gplug', sensor: 'SMA', field: 'P_AC', dimension: 'kW' };

test('gplug production with sensor SMA is valid', () => {
  assert.deepStrictEqual(validateProduction(SMA, []), {});
});

test('sensor is optional: blank / absent is valid', () => {
  assert.deepStrictEqual(validateProduction({ id: 'pv', integration: 'gplug', field: 'Po' }, []), {});
  assert.deepStrictEqual(validateProduction({ id: 'pv', integration: 'gplug', field: 'Po', sensor: '' }, []), {});
  assert.deepStrictEqual(validateGrid({ id: 'to', integration: 'gplug', field: 'Po', sensor: '  ' }), {});
});

test('sensor with whitespace is rejected in the forms', () => {
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { sensor: 'S MA' }), []),
    { sensor: 'settings.err.sensor' });
  assert.deepStrictEqual(validateGrid({ id: 'from', integration: 'gplug', field: 'Pi', sensor: 'z ' }),
    { sensor: 'settings.err.sensor' });
});

test('sensor is ignored for non-gplug integrations', () => {
  assert.deepStrictEqual(validateGrid({ id: 'from', integration: 'simulator', url: 'http://sim/x', sensor: 'a b' }), {});
});

test('validateDocument flags a bad sensor in productions and grid', () => {
  const doc = {
    id: 'site-1', loads: [],
    productions: [SMA, { id: 'pv-2', integration: 'gplug', field: 'P', sensor: 42 }],
    grid: [{ id: 'from', integration: 'gplug', field: 'Pi', sensor: 'my meter' }]
  };
  assert.deepStrictEqual(validateDocument(doc), [
    { path: 'productions[1].sensor', key: 'settings.err.sensor' },
    { path: 'grid[0].sensor', key: 'settings.err.sensor' }
  ]);
});

test('dropBlankGplugKeys removes only a blank sensor, never mutates', () => {
  const blank = { id: 'pv', integration: 'gplug', field: 'Po', sensor: ' ' };
  const out = dropBlankGplugKeys(blank);
  assert.deepStrictEqual(out, { id: 'pv', integration: 'gplug', field: 'Po' });
  assert.strictEqual(blank.sensor, ' ', 'input must not be mutated');
  assert.strictEqual(dropBlankGplugKeys(SMA), SMA, 'a set sensor passes through as-is');
  const none = { id: 'pv', field: 'Po' };
  assert.strictEqual(dropBlankGplugKeys(none), none);
});

/* issue #12: SunSpec dynamic scale factor — scale_field names the exponent
   register, scale_base the exponent the value is already scaled for. */
test('scale_field / scale_base are optional and valid when well-formed', () => {
  const sf = Object.assign({}, SMA, { scale_field: 'Psf', scale_base: '1' });
  assert.deepStrictEqual(validateProduction(sf, []), {});
  assert.deepStrictEqual(validateGrid({ id: 'to', integration: 'gplug', field: 'W', scale_field: 'Wsf', scale_base: '-3' }), {});
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { scale_field: '', scale_base: '' }), []), {});
});

test('bad scale_field / scale_base are rejected in the forms', () => {
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { scale_field: 'P sf' }), []),
    { scale_field: 'settings.err.scale_field' });
  ['1.5', 'x', '11', '-11'].forEach(v => {
    assert.deepStrictEqual(validateGrid({ id: 'from', integration: 'gplug', field: 'Pi', scale_base: v }),
      { scale_base: 'settings.err.scale_base' }, 'scale_base ' + v);
  });
});

test('validateDocument flags bad scale keys', () => {
  const doc = {
    id: 'site-1', loads: [], grid: [],
    productions: [
      Object.assign({}, SMA, { scale_field: 'Psf', scale_base: 1 }),
      Object.assign({}, SMA, { id: 'b', scale_field: 7, scale_base: '1' }),
      Object.assign({}, SMA, { id: 'c', scale_base: 12 })
    ]
  };
  assert.deepStrictEqual(validateDocument(doc), [
    { path: 'productions[1].scale_field', key: 'settings.err.scale_field' },
    { path: 'productions[1].scale_base', key: 'settings.err.scale_base' },
    { path: 'productions[2].scale_base', key: 'settings.err.scale_base' }
  ]);
});

test('dropBlankGplugKeys drops blank scale keys and coerces scale_base', () => {
  const blank = Object.assign({}, SMA, { scale_field: ' ', scale_base: '' });
  assert.deepStrictEqual(dropBlankGplugKeys(blank), SMA);
  const set = Object.assign({}, SMA, { scale_field: 'Psf', scale_base: '1' });
  assert.deepStrictEqual(dropBlankGplugKeys(set), Object.assign({}, SMA, { scale_field: 'Psf', scale_base: 1 }));
  assert.strictEqual(set.scale_base, '1', 'input must not be mutated');
});

/* issue #13: max_power — plausibility cap in W, a positive number */
test('max_power is optional and must be a positive number', () => {
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { max_power: '20000' }), []), {});
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { max_power: '' }), []), {});
  ['0', '-1', 'x'].forEach(v => {
    assert.deepStrictEqual(validateGrid({ id: 'from', integration: 'gplug', field: 'Pi', max_power: v }),
      { max_power: 'settings.err.max_power' }, 'max_power ' + v);
  });
});

test('validateDocument flags a bad max_power; save coerces it to a number', () => {
  const doc = {
    id: 'site-1', loads: [], productions: [],
    grid: [Object.assign({ id: 'from', integration: 'gplug', field: 'Pi' }, { max_power: '20000' }),
           { id: 'to', integration: 'gplug', field: 'Po', max_power: 0 }]
  };
  assert.deepStrictEqual(validateDocument(doc), [
    { path: 'grid[0].max_power', key: 'settings.err.max_power' },
    { path: 'grid[1].max_power', key: 'settings.err.max_power' }
  ]);
  assert.strictEqual(dropBlankGplugKeys(doc.grid[0]).max_power, 20000);
  assert.ok(!('max_power' in dropBlankGplugKeys({ id: 'x', max_power: ' ' })));
});

/* issue #15: stale detection — stale_after (s) + optional energy_field */
test('stale_after / energy_field: optional, validated, coerced', () => {
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { stale_after: '600', energy_field: 'E_AC' }), []), {});
  ['0', '-5', '1.5', 'x'].forEach(v => {
    assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { stale_after: v }), []),
      { stale_after: 'settings.err.stale_after' }, 'stale_after ' + v);
  });
  assert.deepStrictEqual(validateGrid({ id: 'to', integration: 'gplug', field: 'Po', energy_field: 'E o' }),
    { energy_field: 'settings.err.energy_field' });
  const doc = { id: 's', loads: [], grid: [],
    productions: [Object.assign({}, SMA, { stale_after: '600', energy_field: 3 })] };
  assert.deepStrictEqual(validateDocument(doc), [
    { path: 'productions[0].energy_field', key: 'settings.err.energy_field' },
    { path: 'productions[0].stale_after', key: 'settings.err.stale_after' }
  ]);
  const out = dropBlankGplugKeys(Object.assign({}, SMA, { stale_after: '600', energy_field: '' }));
  assert.strictEqual(out.stale_after, 600);
  assert.ok(!('energy_field' in out));
});

/* issue #14: energy counter unit + own scale factor */
test('energy_dimension / energy_scale_*: optional, validated, coerced', () => {
  const ok = Object.assign({}, SMA, { energy_field: 'E_AC', energy_dimension: 'kWh',
    energy_scale_field: 'Esf', energy_scale_base: '1' });
  assert.deepStrictEqual(validateProduction(ok, []), {});
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { energy_dimension: 'MWh' }), []),
    { energy_dimension: 'settings.err.energy_dimension' });
  assert.deepStrictEqual(validateProduction(Object.assign({}, SMA, { energy_scale_field: 'E sf', energy_scale_base: '20' }), []),
    { energy_scale_field: 'settings.err.scale_field', energy_scale_base: 'settings.err.scale_base' });
  const doc = { id: 's', loads: [], grid: [],
    productions: [Object.assign({}, SMA, { energy_dimension: 'J', energy_scale_field: 1, energy_scale_base: 'x' })] };
  assert.deepStrictEqual(validateDocument(doc), [
    { path: 'productions[0].energy_dimension', key: 'settings.err.energy_dimension' },
    { path: 'productions[0].energy_scale_field', key: 'settings.err.scale_field' },
    { path: 'productions[0].energy_scale_base', key: 'settings.err.scale_base' }
  ]);
  const out = dropBlankGplugKeys(Object.assign({}, ok, { energy_dimension: '' }));
  assert.strictEqual(out.energy_scale_base, 1);
  assert.ok(!('energy_dimension' in out), 'blank unit (auto) is dropped');
});

test('examples/site-gplug.json validates (incl. the SMA production)', () => {
  const p = fileURLToPath(new URL('../../backend/examples/site-gplug.json', import.meta.url));
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepStrictEqual(validateDocument(doc), []);
  assert.ok(doc.productions.some(x => x.integration === 'gplug' && x.sensor === 'SMA' && x.field === 'P_AC'),
    'example must show a gplug SMA production');
});
