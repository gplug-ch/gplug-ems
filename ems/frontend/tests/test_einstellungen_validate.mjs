/* spec 011 FR-1112: the site.json rules that used to live in the Berry
   configservice.validate() now run in the browser. This file is the parity
   suite — the cases deleted from ems/backend/tests/test_configservice.be
   (tests 1, 3, 4, 6c) are asserted here, plus the leniency the device had and
   the strict form validators do not. */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDocument, validateLoad, validateProduction, validateGrid,
  validateModbusReg, dropBlankModbusKeys } from '../src/pages/einstellungen.js';

/* a document the old device validator accepted */
function valid() {
  return {
    id: 'site-1', name: 'Testsite',
    loads: [{ id: 'dryer-1', currentPower: 2000, priority: 1, url: 'http://192.168.0.10/on' }],
    productions: [{ id: 'pv-1', integration: 'gplug', field: 'Pi' }],
    grid: [{ id: 'from', integration: 'gplug', field: 'Pi' }]
  };
}
function paths(f) { return f.map(x => x.path); }
function keys(f) { return f.map(x => x.key); }

/* ---------- clean documents ---------- */

test('a valid document has no findings', () => {
  assert.deepStrictEqual(validateDocument(valid()), []);
});

test('examples/site-1.json validates (backend test 7 parity)', () => {
  const p = fileURLToPath(new URL('../../backend/examples/site-1.json', import.meta.url));
  assert.deepStrictEqual(validateDocument(JSON.parse(readFileSync(p, 'utf8'))), []);
});

/* ---------- structure (backend test 1 + 3 parity) ---------- */

test('non-object document', () => {
  assert.deepStrictEqual(validateDocument(null), [{ path: '', key: 'settings.err.doc_object' }]);
  assert.deepStrictEqual(validateDocument([]), [{ path: '', key: 'settings.err.doc_object' }]);
});

test('missing or empty id', () => {
  const c = valid(); delete c.id;
  assert.deepStrictEqual(paths(validateDocument(c)), ['id']);
  const c2 = valid(); c2.id = '';
  assert.deepStrictEqual(keys(validateDocument(c2)), ['settings.err.id_required']);
});

test('loads as an object instead of an array', () => {
  const c = valid(); c.loads = { a: 1 };
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads', key: 'settings.err.array_required' }]);
});

test('every array is required', () => {
  const c = valid(); delete c.productions; delete c.grid;
  assert.deepStrictEqual(paths(validateDocument(c)), ['productions', 'grid']);
});

test('array entries must be objects', () => {
  const c = valid(); c.grid = [{ id: 'from' }, 'nope'];
  assert.deepStrictEqual(validateDocument(c), [{ path: 'grid[1]', key: 'settings.err.array_required' }]);
});

/* ---------- loads (backend tests 3 + 4 parity) ---------- */

test('load id must be a non-empty string', () => {
  const c = valid(); c.loads[0].id = '';
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[0].id', key: 'settings.err.id_required' }]);
});

test('duplicate load id', () => {
  const c = valid(); c.loads.push({ id: 'dryer-1' });
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[1].id', key: 'settings.err.id_duplicate' }]);
});

test('currentPower must be numeric when present', () => {
  const c = valid(); c.loads[0].currentPower = 'lots';
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[0].currentPower', key: 'settings.err.power' }]);
});

test('priority must be a number >= 1 when present', () => {
  const c = valid(); c.loads[0].priority = 0;
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[0].priority', key: 'settings.err.priority' }]);
  const c2 = valid(); c2.loads[0].priority = '2';
  assert.deepStrictEqual(keys(validateDocument(c2)), ['settings.err.priority']);
});

test('url must be http(s)', () => {
  const c = valid(); c.loads[0].url = 'ftp://nope';
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[0].url', key: 'settings.err.url' }]);
});

test('shelly url map: strings ok, non-string and bad scheme flagged', () => {
  const ok = valid();
  ok.loads[0].url = { on: 'http://h/relay/0?turn=on', off: 'http://h/relay/0?turn=off', status: 'http://h/status' };
  assert.deepStrictEqual(validateDocument(ok), []);
  const bad = valid();
  bad.loads[0].url = { on: 123, off: 'ftp://h' };
  assert.deepStrictEqual(validateDocument(bad), [
    { path: 'loads[0].url.on', key: 'settings.err.url' },
    { path: 'loads[0].url.off', key: 'settings.err.url' }
  ]);
});

test('url of an unsupported type', () => {
  const c = valid(); c.loads[0].url = 42;
  assert.deepStrictEqual(validateDocument(c), [{ path: 'loads[0].url', key: 'settings.err.url' }]);
});

/* ---------- tariffs (backend test 6c parity) ---------- */

test('flat tariffs and full HT/NT tariffs both pass', () => {
  const flat = valid();
  flat.tariffs = { grid_import_chf_kwh: 0.26, grid_feedin_chf_kwh: 0.08 };
  assert.deepStrictEqual(validateDocument(flat), []);
  const full = valid();
  full.tariffs = {
    grid_import_chf_kwh: 0.26, grid_feedin_chf_kwh: 0.08,
    grid_import_ht_chf_kwh: 0.3, grid_import_nt_chf_kwh: 0.2,
    base_fee_chf_month: 12.5, co2_g_kwh: 128,
    ht_windows: [{ days: 'mon-fri', from: 7, to: 20 }]
  };
  assert.deepStrictEqual(validateDocument(full), []);
});

test('empty ht_windows is not an error', () => {
  const c = valid(); c.tariffs = { ht_windows: [] };
  assert.deepStrictEqual(validateDocument(c), []);
});

test('tariffs must be an object', () => {
  const c = valid(); c.tariffs = [];
  assert.deepStrictEqual(validateDocument(c), [{ path: 'tariffs', key: 'settings.err.doc_object' }]);
});

test('negative or non-numeric tariff values', () => {
  const c = valid(); c.tariffs = { grid_import_ht_chf_kwh: -0.1, co2_g_kwh: 'lots' };
  assert.deepStrictEqual(validateDocument(c), [
    { path: 'tariffs.grid_import_ht_chf_kwh', key: 'settings.err.rate' },
    { path: 'tariffs.co2_g_kwh', key: 'settings.err.rate' }
  ]);
});

test('ht_windows shape and bounds', () => {
  const notList = valid(); notList.tariffs = { ht_windows: {} };
  assert.deepStrictEqual(validateDocument(notList), [{ path: 'tariffs.ht_windows', key: 'settings.err.array_required' }]);
  const cases = [{ days: 'mon' }, { from: 20, to: 7 }, { from: 7, to: 25 }, { from: -1, to: 7 }, 'nope'];
  for (const w of cases) {
    const c = valid(); c.tariffs = { ht_windows: [w] };
    assert.deepStrictEqual(validateDocument(c),
      [{ path: 'tariffs.ht_windows[0]', key: 'settings.err.win_hours' }], JSON.stringify(w));
  }
});

/* ---------- leniency: the device semantics, not the form semantics ---------- */

test('a gplug load without a url is clean (the form would demand one)', () => {
  const c = valid();
  c.loads[0] = { id: 'boiler-1', integration: 'gplug', currentPower: 800, priority: 2 };
  assert.deepStrictEqual(validateDocument(c), []);
  assert.ok(validateLoad(c.loads[0], []).url, 'the strict form validator still requires a url');
});

test('absent name, currentPower, priority, url and tariffs are all clean', () => {
  assert.deepStrictEqual(validateDocument({
    id: 'site-1', loads: [{ id: 'l1' }], productions: [], grid: []
  }), []);
});

test('empty url strings are allowed', () => {
  const c = valid(); c.loads[0].url = '';
  assert.deepStrictEqual(validateDocument(c), []);
});

test('unknown keys are preserved, not flagged (FR-603 forward compatibility)', () => {
  const c = valid(); c.loads[0].futureKey = { deeply: ['nested'] }; c.somethingNew = 7;
  assert.deepStrictEqual(validateDocument(c), []);
});

/* ---------- several findings at once ---------- */

/* ---------- modbusRegisters: new, optional top-level key ---------- */

test('a document without modbusRegisters at all is unaffected (backward compatible)', () => {
  assert.deepStrictEqual(validateDocument(valid()), []);
});

test('modbusRegisters must be an array when present', () => {
  const c = valid(); c.modbusRegisters = {};
  assert.deepStrictEqual(validateDocument(c), [{ path: 'modbusRegisters', key: 'settings.err.array_required' }]);
});

test('a valid modbusRegisters entry has no findings', () => {
  const c = valid();
  c.modbusRegisters = [{ id: 'heat-1', integration: 'modbustcp', url: '192.168.0.102:502', register: 194 }];
  assert.deepStrictEqual(validateDocument(c), []);
});

test('modbusRegisters entries need an id and a numeric, non-negative integer register', () => {
  const c = valid();
  c.modbusRegisters = [
    { integration: 'modbustcp', url: '10.0.0.1:502' },
    { id: 'r2', integration: 'modbustcp', url: '10.0.0.1:502', register: -1 },
    { id: 'r2', integration: 'modbustcp', url: '10.0.0.1:502', register: 5 },
  ];
  assert.deepStrictEqual(validateDocument(c), [
    { path: 'modbusRegisters[0].id', key: 'settings.err.id_required' },
    { path: 'modbusRegisters[0].register', key: 'settings.err.modbus_register' },
    { path: 'modbusRegisters[1].register', key: 'settings.err.modbus_register' },
    { path: 'modbusRegisters[2].id', key: 'settings.err.id_duplicate' },
  ]);
});

/* validateModbusReg: the strict per-item form validator (settings.pages
   Modbus tab), independent of the raw-document checker above */
test('validateModbusReg: a well-formed entry is clean', () => {
  assert.deepStrictEqual(validateModbusReg(
    { id: 'heat-1', url: '192.168.0.102:502', register: 194, unit: 1 }, []), {});
});

test('validateModbusReg: url must be host:port, not http(s)', () => {
  const e = validateModbusReg({ id: 'a', url: 'http://192.168.0.102:502', register: 1 }, []);
  assert.strictEqual(e.url, 'settings.err.modbus_url');
});

test('validateModbusReg: register must be a non-negative integer', () => {
  assert.strictEqual(validateModbusReg({ id: 'a', url: '1.2.3.4:502', register: -1 }, []).register,
    'settings.err.modbus_register');
  assert.strictEqual(validateModbusReg({ id: 'a', url: '1.2.3.4:502', register: 1.5 }, []).register,
    'settings.err.modbus_register');
  assert.strictEqual(validateModbusReg({ id: 'a', url: '1.2.3.4:502' }, []).register,
    'settings.err.modbus_register');
});

test('validateModbusReg: unit, when set, must be 1..247', () => {
  const base = { id: 'a', url: '1.2.3.4:502', register: 1 };
  assert.strictEqual(validateModbusReg(Object.assign({}, base, { unit: 0 }), []).unit,
    'settings.err.modbus_unit');
  assert.strictEqual(validateModbusReg(Object.assign({}, base, { unit: 248 }), []).unit,
    'settings.err.modbus_unit');
  assert.strictEqual(validateModbusReg(Object.assign({}, base, { unit: '' }), []).unit, undefined);
});

test('validateModbusReg: scale, when set, must be a non-zero number', () => {
  const base = { id: 'a', url: '1.2.3.4:502', register: 1 };
  assert.strictEqual(validateModbusReg(Object.assign({}, base, { scale: 0 }), []).scale,
    'settings.err.modbus_scale');
  assert.strictEqual(validateModbusReg(Object.assign({}, base, { scale: 0.01 }), []).scale, undefined);
});

/* ---------- modbustcp as a load/production/grid integration ---------- */

test('validateLoad accepts modbustcp with host:port url + register', () => {
  assert.deepStrictEqual(validateLoad(
    { id: 'boiler-1', currentPower: 500, priority: 1, integration: 'modbustcp',
      url: '192.168.0.102:502', register: 2834 }, []), {});
});

test('validateLoad flags modbustcp with an http(s) url or missing register', () => {
  const e = validateLoad({ id: 'x', currentPower: 1, priority: 1, integration: 'modbustcp',
    url: 'http://192.168.0.102:502' }, []);
  assert.strictEqual(e.url, 'settings.err.modbus_url');
  assert.strictEqual(e.register, 'settings.err.modbus_register');
});

test('validateProduction and validateGrid accept modbustcp the same way', () => {
  const item = { id: 'wug-ww', integration: 'modbustcp', url: '192.168.0.102:502', register: 2834 };
  assert.deepStrictEqual(validateProduction(item, []), {});
  assert.deepStrictEqual(validateGrid(item), {});
});

test('validateDocument checks host:port + register for modbustcp loads/productions/grid', () => {
  const c = valid();
  c.loads = [{ id: 'l1', integration: 'modbustcp', url: 'http://bad', currentPower: 1, priority: 1 }];
  c.productions = [{ id: 'p1', integration: 'modbustcp', url: '10.0.0.1:502' }];
  c.grid = [{ id: 'from', integration: 'modbustcp', url: '10.0.0.1:502', register: 1 }];
  assert.deepStrictEqual(validateDocument(c), [
    { path: 'productions[0].register', key: 'settings.err.modbus_register' },
    { path: 'loads[0].url', key: 'settings.err.url' },
    { path: 'loads[0].register', key: 'settings.err.modbus_register' },
  ]);
});

test('dropBlankModbusKeys coerces numbers and drops blanks, only for modbustcp items', () => {
  const m = dropBlankModbusKeys({ id: 'l1', integration: 'modbustcp',
    url: '192.168.0.102:502', register: '2834', unit: '', scale: '1', swap_words: false });
  assert.strictEqual(m.register, 2834);
  assert.strictEqual(m.function, 3);
  assert.strictEqual('unit' in m, false);
  assert.strictEqual('scale' in m, false);
  assert.strictEqual('swap_words' in m, false);

  const other = { id: 'l2', integration: 'gplug', field: 'Pi' };
  assert.strictEqual(dropBlankModbusKeys(other), other);
});

test('findings accumulate across the document', () => {
  const c = { id: '', loads: [{ id: 'x', priority: 0 }, { id: 'x' }], productions: [], grid: [], tariffs: { base_fee_chf_month: -1 } };
  assert.deepStrictEqual(validateDocument(c), [
    { path: 'id', key: 'settings.err.id_required' },
    { path: 'loads[0].priority', key: 'settings.err.priority' },
    { path: 'loads[1].id', key: 'settings.err.id_duplicate' },
    { path: 'tariffs.base_fee_chf_month', key: 'settings.err.rate' }
  ]);
});
