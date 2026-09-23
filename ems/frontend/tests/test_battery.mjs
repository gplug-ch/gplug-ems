/* issue #20 — battery as an observed storage item: the Einstellungen rules
   for its keys, their serialisation, and the Übersicht battery state. */
import test from 'node:test';
import assert from 'node:assert';
import {
  validateProduction, validateDocument, dropBlankGplugKeys
} from '../src/pages/einstellungen.js';
import { batteryInfo, batterySoc } from '../src/pages/uebersicht.js';

function bat(o) {
  return Object.assign({
    id: 'battery-1', productionType: 'BATTERY', integration: 'homeassistant',
    url: 'http://ha/api/states/sensor.speicher_leistung', token: 't'
  }, o);
}

test('validateProduction: battery keys are optional', () => {
  assert.deepStrictEqual(validateProduction(bat({}), []), {});
});

test('validateProduction: battery numbers must be positive, soc_url a URL', () => {
  var e = validateProduction(bat({
    capacity: '-1', maxChargePower: 'abc', maxDischargePower: '0', soc_url: 'nope'
  }), []);
  assert.strictEqual(e.capacity, 'settings.err.capacity');
  assert.strictEqual(e.maxChargePower, 'settings.err.bat_power');
  assert.strictEqual(e.maxDischargePower, 'settings.err.bat_power');
  assert.strictEqual(e.soc_url, 'settings.err.url');
});

test('validateProduction: gplug battery SoC field and scale base', () => {
  var e = validateProduction(bat({
    integration: 'gplug', field: 'W', soc_field: 'Cha State', soc_scale_base: '11'
  }), []);
  assert.strictEqual(e.soc_field, 'settings.err.soc_field');
  assert.strictEqual(e.soc_scale_base, 'settings.err.scale_base');
});

test('validateProduction: battery rules do not apply to PV', () => {
  var e = validateProduction(bat({ productionType: 'PHOTOVOLTAIC', capacity: '-1' }), []);
  assert.deepStrictEqual(e, {});
});

test('validateDocument: battery keys in the Pro JSON', () => {
  var doc = {
    id: 's', loads: [], grid: [],
    productions: [bat({ capacity: 10000, soc_url: 'http://ha/x', invert: true })]
  };
  assert.deepStrictEqual(validateDocument(doc), []);
  doc.productions[0] = bat({ capacity: '10000', soc_scale_base: 20, invert: 'yes' });
  var keys = validateDocument(doc).map(function (x) { return x.path + ' ' + x.key; });
  assert.deepStrictEqual(keys.sort(), [
    'productions[0].capacity settings.err.capacity',
    'productions[0].invert settings.err.invert',
    'productions[0].soc_scale_base settings.err.scale_base'
  ]);
});

test('dropBlankGplugKeys: battery numbers coerced, blanks and a false invert dropped', () => {
  var o = dropBlankGplugKeys(bat({
    capacity: '10000', maxChargePower: '', soc_url: '', invert: false
  }));
  assert.strictEqual(o.capacity, 10000);
  assert.ok(!('maxChargePower' in o) && !('soc_url' in o) && !('invert' in o));
  assert.strictEqual(dropBlankGplugKeys(bat({ invert: true })).invert, true);
});

test('dropBlankGplugKeys: battery keys leave an item switched to PV', () => {
  var o = dropBlankGplugKeys(bat({ productionType: 'PHOTOVOLTAIC', capacity: 10000, invert: true }));
  assert.ok(!('capacity' in o) && !('invert' in o));
});

test('batteryInfo: direction from the signed power, stored energy from SoC', () => {
  assert.deepStrictEqual(batteryInfo({ currentPower: 512, soc: 73, capacity: 10000 }),
    { dir: 'discharge', soc: 73, capacity: 10000, storedWh: 7300 });
  assert.strictEqual(batteryInfo({ currentPower: -2000 }).dir, 'charge');
  assert.strictEqual(batteryInfo({ currentPower: 0.4 }).dir, 'idle');
  var unknown = batteryInfo({ soc: 150 });
  assert.strictEqual(unknown.dir, null);
  assert.strictEqual(unknown.soc, null, 'an out-of-range SoC is no SoC');
});

test('batterySoc: capacity-weighted, else the plain mean', () => {
  var prods = [
    { productionType: 'PHOTOVOLTAIC', soc: 0 },
    { productionType: 'BATTERY', soc: 40, capacity: 10000 },
    { productionType: 'BATTERY', soc: 70, capacity: 5000 }
  ];
  assert.strictEqual(batterySoc(prods), 50);
  delete prods[2].capacity;
  assert.strictEqual(batterySoc(prods), 55);
  assert.strictEqual(batterySoc([{ productionType: 'BATTERY' }]), null);
});
