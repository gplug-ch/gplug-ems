/* «Einstellungen» — device configuration UI (spec 006).
   Route #/einstellungen/:tab? with five pill tabs (Site, Lasten, Produktion,
   Netzanschluss, Tarife). One in-memory config document per session (FR-602):
   GET /api/config once, edit per tab, each «Speichern» POSTs the whole doc.
   Validation lives in the pure validate* helpers below (node-testable). */
import { html, useState, useEffect } from '../core.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { router } from '../router.js';
import { toast } from '../components.js';
import * as ui from '../ui.js';
import { fmt } from '../format.js';
import * as archive from '../lib/archive.js';

  var TABS = ['site', 'loads', 'productions', 'grid', 'modbus', 'tariffs', 'daten', 'gplug', 'pro'];
  /* URL slug ⇄ internal tab key. German slugs are the canonical route
     (#/einstellungen/tarife); English internal keys drive the logic. */
  var SLUG = { site: 'site', lasten: 'loads', produktion: 'productions', netzanschluss: 'grid', modbus: 'modbus', tarife: 'tariffs', daten: 'daten', gplug: 'gplug', pro: 'pro' };
  var TAB_SLUG = { site: 'site', loads: 'lasten', productions: 'produktion', grid: 'netzanschluss', modbus: 'modbus', tariffs: 'tarife', daten: 'daten', gplug: 'gplug', pro: 'pro' };
  /* full literal keys so bundle.py's i18n check can see the references */
  var TAB_LABEL = {
    site: 'settings.tab.site', loads: 'settings.tab.loads',
    productions: 'settings.tab.productions', grid: 'settings.tab.grid',
    modbus: 'settings.tab.modbus',
    tariffs: 'settings.tab.tariffs',
    daten: 'settings.tab.data',
    gplug: 'settings.tab.gplug', pro: 'settings.tab.pro'
  };
  var PRODTYPE_LABEL = {
    PHOTOVOLTAIC: 'settings.prodtype.PHOTOVOLTAIC',
    BATTERY: 'settings.prodtype.BATTERY'
  };
  var LOAD_INTEGRATIONS = ['simulator', 'shelly', 'homeassistant', 'gplug', 'modbustcp'];
  var PROD_INTEGRATIONS = ['simulator', 'homeassistant', 'gplug', 'modbustcp'];
  var LOAD_TYPES = ['ELECTRICITY', 'HEATPUMP', 'DRYER', 'WALLBOX'];
  var PROD_TYPES = ['PHOTOVOLTAIC', 'BATTERY'];
  /* spec 010 FR-1007 (D-5 guard): a productionType outside PHOTOVOLTAIC/BATTERY
     (e.g. legacy «PV») is silently dropped from /api/power sums by meter.be, so
     the producer would show in the panel but never in the charts. The contract
     stays unchanged (C-1); we warn in the form instead. Case-insensitive. */
  function unknownProdType(v) {
    if (v === undefined || v === null || String(v).trim() === '') return false;
    return PROD_TYPES.indexOf(String(v).toUpperCase()) < 0;
  }
  var DIMENSIONS = ['W', 'kW'];
  /* standalone Modbus registers (site.json "modbusRegisters" ->
     ems/backend/integrations/modbustcp.be): a register that doesn't fit
     loads/productions/grid, e.g. a submeter behind a Modbus TCP gateway.
     "function" mirrors modbustcp's own default (3), "dtype" its decode
     options. */
  var MODBUS_FUNCTIONS = [
    { value: '3', label: '3 – Read Holding Register (0x03)' },
    { value: '4', label: '4 – Read Input Register (0x04)' }
  ];
  var MODBUS_DTYPES = ['float32', 'int16', 'uint16', 'int32', 'uint32'];
  /* gplug energy counter unit (issue #14); blank = follow the power unit */
  var ENERGY_DIMENSIONS = ['Wh', 'kWh'];

  var TARIFF_KEYS = [
    'grid_import_chf_kwh', 'grid_feedin_chf_kwh', 'base_fee_chf_month'
  ];
  var TARIFF_DEFAULTS = {
    grid_import_chf_kwh: 0.26, grid_feedin_chf_kwh: 0.18, base_fee_chf_month: 12.5,
    /* spec 008 FR-805: CO₂ factor g CO₂eq/kWh (Schweizer Verbrauchermix); 0 hides */
    co2_g_kwh: 128
  };

  /* ---------- pure validation helpers (FR-606, testable) ---------- */

  function isBlank(v) { return v === undefined || v === null || String(v).trim() === ''; }
  function isNum(v) { return !isBlank(v) && !isNaN(Number(v)); }
  function isUrl(v) {
    if (isBlank(v)) return false;
    return /^https?:\/\/\S+$/i.test(String(v).trim());
  }

  /* Validate one load form against sibling ids (for duplicate detection).
     Returns a map field->error-key (empty when valid). */
  function validateLoad(load, others) {
    var e = {};
    if (isBlank(load.id)) e.id = 'settings.err.id_required';
    else if (others && others.indexOf(String(load.id)) >= 0) e.id = 'settings.err.id_duplicate';
    if (!isNum(load.currentPower) || Number(load.currentPower) < 0) e.currentPower = 'settings.err.power';
    if (!isNum(load.priority) || Number(load.priority) < 1 || Math.floor(Number(load.priority)) !== Number(load.priority)) e.priority = 'settings.err.priority';
    var integ = load.integration;
    if (integ === 'shelly') {
      var url = load.url || {};
      if (!isUrl(url.on)) e['url.on'] = 'settings.err.url';
      if (!isUrl(url.off)) e['url.off'] = 'settings.err.url';
      if (!isUrl(url.status)) e['url.status'] = 'settings.err.url';
    } else if (integ === 'modbustcp') {
      modbusIntegErrors(load, e);
    } else {
      if (!isUrl(load.url)) e.url = 'settings.err.url';
      if (integ === 'homeassistant' && isBlank(load.token)) e.token = 'settings.err.token';
    }
    return e;
  }

  /* gplug "sensor" (issue #10): the read_sensors() top-level object, e.g.
     "SMA". Optional — blank means the smart-meter object "z" — but a set
     value is a JSON key, so no whitespace. */
  function badSensor(v) { return !isBlank(v) && /\s/.test(String(v)); }

  /* gplug SunSpec scale factor (issue #12): "scale_field" names the register
     holding the exponent (e.g. "Psf"), "scale_base" the exponent the value
     is already scaled for (default 0 = raw register). Both optional; the
     device applies value * 10^(sf - base). SunSpec bounds sf to -10..10. */
  function badScaleBase(v) {
    if (isBlank(v)) return false;
    var n = Number(v);
    return isNaN(n) || Math.floor(n) !== n || n < -10 || n > 10;
  }

  /* gplug plausibility cap (issue #13): "max_power" in W, a positive number;
     a read beyond it (e.g. the SunSpec N/A sentinel at night) is ignored */
  function badMaxPower(v) { return !isBlank(v) && (!isNum(v) || Number(v) <= 0); }

  /* gplug stale detection (issue #15): "stale_after" in s, a positive
     integer (opt-in); "energy_field" the counter key proving freshness */
  function badStaleAfter(v) {
    if (isBlank(v)) return false;
    var n = Number(v);
    return isNaN(n) || Math.floor(n) !== n || n <= 0;
  }

  /* battery (issue #20): capacity (Wh) and the charge / discharge limits (W)
     are optional positive numbers; the SoC comes from "soc_field" (+ its own
     SunSpec scale factor) on gplug, or from a second entity "soc_url" on the
     URL integrations */
  function isBatteryType(v) { return String(v || '').toUpperCase() === 'BATTERY'; }
  function batteryErrors(item, e) {
    if (badMaxPower(item.capacity)) e.capacity = 'settings.err.capacity';
    if (badMaxPower(item.maxChargePower)) e.maxChargePower = 'settings.err.bat_power';
    if (badMaxPower(item.maxDischargePower)) e.maxDischargePower = 'settings.err.bat_power';
    if (item.integration === 'gplug') {
      if (badSensor(item.soc_field)) e.soc_field = 'settings.err.soc_field';
      if (badSensor(item.soc_scale_field)) e.soc_scale_field = 'settings.err.scale_field';
      if (badScaleBase(item.soc_scale_base)) e.soc_scale_base = 'settings.err.scale_base';
    } else if (!isBlank(item.soc_url) && !isUrl(item.soc_url)) {
      e.soc_url = 'settings.err.url';
    }
  }

  function gplugErrors(item, e) {
    if (isBlank(item.field)) e.field = 'settings.err.field';
    if (badSensor(item.sensor)) e.sensor = 'settings.err.sensor';
    if (badSensor(item.scale_field)) e.scale_field = 'settings.err.scale_field';
    if (badScaleBase(item.scale_base)) e.scale_base = 'settings.err.scale_base';
    if (badMaxPower(item.max_power)) e.max_power = 'settings.err.max_power';
    if (badSensor(item.energy_field)) e.energy_field = 'settings.err.energy_field';
    if (badStaleAfter(item.stale_after)) e.stale_after = 'settings.err.stale_after';
    /* issue #14: counter unit + its own SunSpec scale factor */
    if (!isBlank(item.energy_dimension) && ENERGY_DIMENSIONS.indexOf(item.energy_dimension) < 0) {
      e.energy_dimension = 'settings.err.energy_dimension';
    }
    if (badSensor(item.energy_scale_field)) e.energy_scale_field = 'settings.err.scale_field';
    if (badScaleBase(item.energy_scale_base)) e.energy_scale_base = 'settings.err.scale_base';
  }

  /* blank optional gplug keys (sensor, scale_field, scale_base, max_power,
     energy_field, stale_after, energy_dimension, energy_scale_field,
     energy_scale_base) are dropped from site.json (the device defaults them), so an untouched
     form round-trips the document unchanged; set numeric keys are sent as
     numbers. Never mutates the input. */
  var GPLUG_OPT_KEYS = ['sensor', 'scale_field', 'scale_base', 'max_power',
    'energy_field', 'stale_after', 'energy_dimension', 'energy_scale_field',
    'energy_scale_base'];
  var GPLUG_NUM_KEYS = ['scale_base', 'max_power', 'stale_after', 'energy_scale_base'];
  /* battery keys (issue #20) follow the same rule; `invert` is kept only when
     set, and all of them are dropped from an item that is not a battery */
  var BAT_OPT_KEYS = ['capacity', 'maxChargePower', 'maxDischargePower', 'soc_field',
    'soc_scale_field', 'soc_scale_base', 'soc_url'];
  var BAT_NUM_KEYS = ['capacity', 'maxChargePower', 'maxDischargePower', 'soc_scale_base'];
  function dropBlankGplugKeys(item) {
    if (!isObj(item)) return item;
    var o = null;
    var notBattery = item.productionType !== undefined && !isBatteryType(item.productionType);
    GPLUG_OPT_KEYS.concat(BAT_OPT_KEYS).forEach(function (k) {
      if (!(k in item)) return;
      if (isBlank(item[k]) || (notBattery && BAT_OPT_KEYS.indexOf(k) >= 0)) {
        o = o || Object.assign({}, item);
        delete o[k];
      } else if ((GPLUG_NUM_KEYS.indexOf(k) >= 0 || BAT_NUM_KEYS.indexOf(k) >= 0) &&
                 typeof item[k] !== 'number' && isNum(item[k])) {
        o = o || Object.assign({}, item);
        o[k] = Number(item[k]);
      }
    });
    if ('invert' in item && (item.invert !== true || notBattery)) {
      o = o || Object.assign({}, item);
      delete o.invert;
    }
    return o || item;
  }

  /* same numeric-coercion / blank-dropping treatment as the standalone
     "modbusRegisters" tab's own serialize step, but for a load/production/
     grid item that picked "modbustcp" as its integration */
  function dropBlankModbusKeys(item) {
    if (!isObj(item) || item.integration !== 'modbustcp') return item;
    var o = Object.assign({}, item);
    o.function = Number(o.function || 3);
    if (!isBlank(o.register)) o.register = Number(o.register);
    if (isBlank(o.unit)) delete o.unit; else o.unit = Number(o.unit);
    if (isBlank(o.scale) || Number(o.scale) === 1) delete o.scale; else o.scale = Number(o.scale);
    if (o.swap_words !== true) delete o.swap_words;
    return o;
  }

  function validateProduction(prod, others) {
    var e = {};
    if (isBlank(prod.id)) e.id = 'settings.err.id_required';
    else if (others && others.indexOf(String(prod.id)) >= 0) e.id = 'settings.err.id_duplicate';
    if (prod.integration === 'gplug') {
      gplugErrors(prod, e);
    } else if (prod.integration === 'modbustcp') {
      modbusIntegErrors(prod, e);
    } else {
      if (!isUrl(prod.url)) e.url = 'settings.err.url';
      if (prod.integration === 'homeassistant' && isBlank(prod.token)) e.token = 'settings.err.token';
    }
    if (isBatteryType(prod.productionType)) batteryErrors(prod, e);
    return e;
  }

  function validateGrid(g) {
    var e = {};
    if (g.integration === 'gplug') {
      gplugErrors(g, e);
    } else if (g.integration === 'modbustcp') {
      modbusIntegErrors(g, e);
    } else {
      if (!isUrl(g.url)) e.url = 'settings.err.url';
      if (g.integration === 'homeassistant' && isBlank(g.token)) e.token = 'settings.err.token';
    }
    return e;
  }

  /* modbustcp's "url" is "<ip-or-host>:<port>", not http(s) — no scheme, no
     path, so isUrl() doesn't apply here */
  function isHostPort(v) {
    if (isBlank(v)) return false;
    return /^[^\s:]+:\d{1,5}$/.test(String(v).trim());
  }
  function isPosInt(v, min, max) {
    if (!isNum(v)) return false;
    var n = Number(v);
    return Math.floor(n) === n && n >= min && (max === undefined || n <= max);
  }

  /* modbustcp config fields (url/register/unit/scale) — shared by the
     standalone Modbus tab AND any load/production/grid item that picks
     "modbustcp" as its integration (backend accepts it per-item, see
     integrations/modbustcp.be's docstring). */
  function modbusIntegErrors(item, e) {
    if (!isHostPort(item.url)) e.url = 'settings.err.modbus_url';
    if (!isPosInt(item.register, 0)) e.register = 'settings.err.modbus_register';
    if (!isBlank(item.unit) && !isPosInt(item.unit, 1, 247)) e.unit = 'settings.err.modbus_unit';
    if (!isBlank(item.scale) && (!isNum(item.scale) || Number(item.scale) === 0)) {
      e.scale = 'settings.err.modbus_scale';
    }
  }

  function validateModbusReg(item, others) {
    var e = {};
    if (isBlank(item.id)) e.id = 'settings.err.id_required';
    else if (others && others.indexOf(String(item.id)) >= 0) e.id = 'settings.err.id_duplicate';
    modbusIntegErrors(item, e);
    return e;
  }

  function validateSite(cfg) {
    var e = {};
    if (isBlank(cfg.id)) e.id = 'settings.err.id_required';
    if (isBlank(cfg.name)) e.name = 'settings.err.name_required';
    return e;
  }

  function validateTariffs(tar) {
    var e = {};
    TARIFF_KEYS.forEach(function (k) {
      if (!isNum(tar[k]) || Number(tar[k]) < 0) e[k] = 'settings.err.rate';
    });
    /* co2_g_kwh: non-negative integer (spec 008 FR-805, 0 = hidden) */
    var c = tar.co2_g_kwh;
    if (!isNum(c) || Number(c) < 0 || Math.floor(Number(c)) !== Number(c)) {
      e.co2_g_kwh = 'settings.err.co2';
    }
    /* spec 009 FR-901: optional HT/NT rates. Both must be set (numbers ≥ 0) or
       both empty; a lone HT or NT is a save error. */
    var ht = tar.grid_import_ht_chf_kwh, nt = tar.grid_import_nt_chf_kwh;
    var htSet = !isBlank(ht), ntSet = !isBlank(nt);
    if (htSet || ntSet) {
      if (!htSet || !ntSet) {
        e.grid_import_ht_chf_kwh = 'settings.err.rate_ht';
        e.grid_import_nt_chf_kwh = 'settings.err.rate_ht';
      } else {
        if (!isNum(ht) || Number(ht) < 0) e.grid_import_ht_chf_kwh = 'settings.err.rate';
        if (!isNum(nt) || Number(nt) < 0) e.grid_import_nt_chf_kwh = 'settings.err.rate';
      }
    }
    /* ht_windows: each {from,to} must satisfy 0 ≤ from ≤ to ≤ 24 (days is free
       text). An empty list is NOT an error here — it is surfaced as a hint. */
    if (Array.isArray(tar.ht_windows)) {
      for (var i = 0; i < tar.ht_windows.length; i++) {
        var w = tar.ht_windows[i] || {};
        if (!isNum(w.from) || !isNum(w.to) ||
            Number(w.from) < 0 || Number(w.to) > 24 || Number(w.from) > Number(w.to)) {
          e['win.' + i] = 'settings.err.win_hours';
        }
      }
    }
    return e;
  }

  function hasErrors(e) { for (var k in e) if (e.hasOwnProperty(k)) return true; return false; }

  /* ---------- document-level validation (spec 011 FR-1112) ----------
     The device validator (configservice.validate) is gone as of spec 011 step
     2, so the raw «Pro» editor needs the same rules in the browser. These are
     deliberately LENIENT — the device semantics, not the form semantics: every
     field is optional and only checked when present, because a hand-written
     site.json legitimately omits name, currentPower, tariffs or a url (a gplug
     load has none). The strict validate* helpers above keep guarding the
     guided tabs.
     Returns a list of {path, key} findings; [] when the document is clean. */

  /* JSON types, not form strings: mirrors the Berry _is_number */
  function isNumber(v) { return typeof v === 'number' && !isNaN(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  /* lenient url: absent/empty is fine, anything else must be http(s) */
  function isUrlish(v) {
    if (v === undefined || v === null || String(v).trim() === '') return true;
    return /^https?:\/\//i.test(String(v).trim());
  }

  /* full literal keys so the i18n check can see the references */
  var DOC_ERR = {
    object: 'settings.err.doc_object',
    array: 'settings.err.array_required',
    id: 'settings.err.id_required',
    dup: 'settings.err.id_duplicate',
    power: 'settings.err.power',
    priority: 'settings.err.priority',
    url: 'settings.err.url',
    rate: 'settings.err.rate',
    win: 'settings.err.win_hours',
    sensor: 'settings.err.sensor',
    scale_field: 'settings.err.scale_field',
    scale_base: 'settings.err.scale_base',
    max_power: 'settings.err.max_power',
    energy_field: 'settings.err.energy_field',
    stale_after: 'settings.err.stale_after',
    energy_dimension: 'settings.err.energy_dimension',
    capacity: 'settings.err.capacity',
    bat_power: 'settings.err.bat_power',
    soc_field: 'settings.err.soc_field',
    invert: 'settings.err.invert',
    modbus_register: 'settings.err.modbus_register'
  };
  /* every numeric tariff key the device used to bound (≥ 0 when present) */
  var DOC_TARIFF_KEYS = [
    'grid_import_chf_kwh', 'grid_feedin_chf_kwh', 'grid_import_ht_chf_kwh',
    'grid_import_nt_chf_kwh', 'base_fee_chf_month', 'co2_g_kwh'
  ];

  /* modbustcp item (load/production/grid): "url" is host:port (no scheme),
     "register" a required non-negative integer — same shape the standalone
     modbusRegisters loop above already checks */
  function checkModbusItem(it, p, out) {
    if (typeof it.url !== 'string' || !isHostPort(it.url)) out.push({ path: p + '.url', key: DOC_ERR.url });
    if (it.register === undefined || it.register === null || !isNumber(it.register) ||
        it.register < 0 || Math.floor(it.register) !== it.register) {
      out.push({ path: p + '.register', key: DOC_ERR.modbus_register });
    }
  }

  function checkUrlValue(v, path, out) {
    if (typeof v === 'string' || v === undefined || v === null) {
      if (!isUrlish(v)) out.push({ path: path, key: DOC_ERR.url });
      return;
    }
    if (isObj(v)) {
      for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        if (typeof v[k] !== 'string' || !isUrlish(v[k])) out.push({ path: path + '.' + k, key: DOC_ERR.url });
      }
      return;
    }
    out.push({ path: path, key: DOC_ERR.url });
  }

  function checkArray(cfg, key, out) {
    var a = cfg[key];
    if (!Array.isArray(a)) { out.push({ path: key, key: DOC_ERR.array }); return null; }
    var ok = true;
    for (var i = 0; i < a.length; i++) {
      if (!isObj(a[i])) { out.push({ path: key + '[' + i + ']', key: DOC_ERR.array }); ok = false; }
    }
    return ok ? a : null;
  }

  function validateDocument(cfg) {
    var out = [];
    if (!isObj(cfg)) return [{ path: '', key: DOC_ERR.object }];
    if (typeof cfg.id !== 'string' || cfg.id.length === 0) out.push({ path: 'id', key: DOC_ERR.id });
    var loads = checkArray(cfg, 'loads', out);
    var prods = checkArray(cfg, 'productions', out);
    var grid = checkArray(cfg, 'grid', out);
    /* "modbusRegisters" is a NEW, optional top-level key (unlike
       loads/productions/grid) — most existing site.json documents don't
       have it at all, so only validate its shape when the key is present */
    var mregs = cfg.modbusRegisters !== undefined ? checkArray(cfg, 'modbusRegisters', out) : null;
    if (mregs) {
      var mseen = {};
      for (var mi = 0; mi < mregs.length; mi++) {
        var mr = mregs[mi], mp = 'modbusRegisters[' + mi + ']';
        var mid = mr.id;
        if (typeof mid !== 'string' || mid.length === 0) out.push({ path: mp + '.id', key: DOC_ERR.id });
        else if (mseen[mid]) out.push({ path: mp + '.id', key: DOC_ERR.dup });
        else mseen[mid] = true;
        if (mr.register === undefined || mr.register === null || !isNumber(mr.register) ||
            mr.register < 0 || Math.floor(mr.register) !== mr.register) {
          out.push({ path: mp + '.register', key: DOC_ERR.modbus_register });
        }
      }
    }
    /* gplug "sensor" (issue #10) / "scale_field" (issue #12): optional, but a
       string key without spaces; "scale_base" optional int -10..10;
       "max_power" (issue #13) optional positive W; "energy_field" /
       "stale_after" (issue #15) a key string / a positive int in s;
       "energy_dimension" (issue #14) Wh|kWh, energy_scale_* as scale_* */
    [['productions', prods], ['grid', grid]].forEach(function (pair) {
      (pair[1] || []).forEach(function (it, i) {
        var p = pair[0] + '[' + i + ']';
        if (it.integration === 'modbustcp') { checkModbusItem(it, p, out); return; }
        var sv = it.sensor;
        if (sv !== undefined && sv !== null && (typeof sv !== 'string' || badSensor(sv))) {
          out.push({ path: p + '.sensor', key: DOC_ERR.sensor });
        }
        /* issue #12: scale_field a key string, scale_base an int -10..10 */
        var sf = it.scale_field;
        if (sf !== undefined && sf !== null && (typeof sf !== 'string' || badSensor(sf))) {
          out.push({ path: p + '.scale_field', key: DOC_ERR.scale_field });
        }
        var sb = it.scale_base;
        if (sb !== undefined && sb !== null && (!isNumber(sb) || badScaleBase(sb))) {
          out.push({ path: p + '.scale_base', key: DOC_ERR.scale_base });
        }
        /* issue #13: max_power a positive number (W) */
        var mp = it.max_power;
        if (mp !== undefined && mp !== null && (!isNumber(mp) || badMaxPower(mp))) {
          out.push({ path: p + '.max_power', key: DOC_ERR.max_power });
        }
        /* issue #15: energy_field a key string, stale_after a positive int (s) */
        var ef = it.energy_field;
        if (ef !== undefined && ef !== null && (typeof ef !== 'string' || badSensor(ef))) {
          out.push({ path: p + '.energy_field', key: DOC_ERR.energy_field });
        }
        var sa = it.stale_after;
        if (sa !== undefined && sa !== null && (!isNumber(sa) || badStaleAfter(sa))) {
          out.push({ path: p + '.stale_after', key: DOC_ERR.stale_after });
        }
        /* issue #14: counter unit, scale field, scale base */
        var ed = it.energy_dimension;
        if (ed !== undefined && ed !== null && ENERGY_DIMENSIONS.indexOf(ed) < 0) {
          out.push({ path: p + '.energy_dimension', key: DOC_ERR.energy_dimension });
        }
        var esf = it.energy_scale_field;
        if (esf !== undefined && esf !== null && (typeof esf !== 'string' || badSensor(esf))) {
          out.push({ path: p + '.energy_scale_field', key: DOC_ERR.scale_field });
        }
        var esb = it.energy_scale_base;
        if (esb !== undefined && esb !== null && (!isNumber(esb) || badScaleBase(esb))) {
          out.push({ path: p + '.energy_scale_base', key: DOC_ERR.scale_base });
        }
      });
    });

    /* issue #20: battery keys on productions — positive numbers, key strings,
       an int -10..10 soc_scale_base, a URL soc_url and a boolean invert */
    (prods || []).forEach(function (it, i) {
      var p = 'productions[' + i + ']';
      [['capacity', DOC_ERR.capacity], ['maxChargePower', DOC_ERR.bat_power],
       ['maxDischargePower', DOC_ERR.bat_power]].forEach(function (kv) {
        var v = it[kv[0]];
        if (v !== undefined && v !== null && (!isNumber(v) || badMaxPower(v))) {
          out.push({ path: p + '.' + kv[0], key: kv[1] });
        }
      });
      [['soc_field', DOC_ERR.soc_field], ['soc_scale_field', DOC_ERR.scale_field]].forEach(function (kv) {
        var v = it[kv[0]];
        if (v !== undefined && v !== null && (typeof v !== 'string' || badSensor(v))) {
          out.push({ path: p + '.' + kv[0], key: kv[1] });
        }
      });
      var ssb = it.soc_scale_base;
      if (ssb !== undefined && ssb !== null && (!isNumber(ssb) || badScaleBase(ssb))) {
        out.push({ path: p + '.soc_scale_base', key: DOC_ERR.scale_base });
      }
      if (it.soc_url !== undefined && it.soc_url !== null && (typeof it.soc_url !== 'string' || !isUrlish(it.soc_url))) {
        out.push({ path: p + '.soc_url', key: DOC_ERR.url });
      }
      if (it.invert !== undefined && typeof it.invert !== 'boolean') {
        out.push({ path: p + '.invert', key: DOC_ERR.invert });
      }
    });

    if (loads) {
      var seen = {};
      for (var i = 0; i < loads.length; i++) {
        var l = loads[i], p = 'loads[' + i + ']';
        var lid = l.id;
        if (typeof lid !== 'string' || lid.length === 0) out.push({ path: p + '.id', key: DOC_ERR.id });
        else if (seen[lid]) out.push({ path: p + '.id', key: DOC_ERR.dup });
        else seen[lid] = true;
        if (l.currentPower !== undefined && l.currentPower !== null && !isNumber(l.currentPower)) {
          out.push({ path: p + '.currentPower', key: DOC_ERR.power });
        }
        if (l.priority !== undefined && l.priority !== null &&
            (!isNumber(l.priority) || l.priority < 1)) {
          out.push({ path: p + '.priority', key: DOC_ERR.priority });
        }
        if (l.integration === 'modbustcp') checkModbusItem(l, p, out);
        else if (l.url !== undefined && l.url !== null) checkUrlValue(l.url, p + '.url', out);
      }
    }

    var tar = cfg.tariffs;
    if (tar !== undefined && tar !== null) {
      if (!isObj(tar)) { out.push({ path: 'tariffs', key: DOC_ERR.object }); return out; }
      DOC_TARIFF_KEYS.forEach(function (k) {
        var v = tar[k];
        if (v === undefined || v === null) return;
        if (!isNumber(v) || v < 0) out.push({ path: 'tariffs.' + k, key: DOC_ERR.rate });
      });
      var win = tar.ht_windows;
      if (win !== undefined && win !== null) {
        if (!Array.isArray(win)) out.push({ path: 'tariffs.ht_windows', key: DOC_ERR.array });
        else {
          for (var j = 0; j < win.length; j++) {
            var w = win[j], wp = 'tariffs.ht_windows[' + j + ']';
            if (!isObj(w) || !isNumber(w.from) || !isNumber(w.to) ||
                w.from < 0 || w.to > 24 || w.from > w.to) {
              out.push({ path: wp, key: DOC_ERR.win });
            }
          }
        }
      }
    }
    return out;
  }

export {
  validateLoad, validateProduction, validateGrid, validateSite,
  validateTariffs, validateDocument, hasErrors, isUrl, dropBlankGplugKeys,
  validateModbusReg, dropBlankModbusKeys,
};

  /* ---------- small field helpers with inline error support ---------- */

  /* issue #12: suggest the SunSpec scale register for a value field
     (P_AC -> Psf, E_AC -> Esf). Only a placeholder — nothing is scaled
     until the user types it in, since scripts often pre-scale the value. */
  function scaleFieldHint(field) {
    var f = isBlank(field) ? '' : String(field).trim();
    return f ? t('settings.scale_field_hint', { name: f.charAt(0) + 'sf' }) : '';
  }

  function Field(props) {
    /* text/number input with an error slot below the label */
    var err = props.error;
    return html`
      <label class=${'field field-block' + (err ? ' field-invalid' : '')}>
        ${props.label ? html`<span class="field-label">${props.label}</span>` : null}
        <input class="textfield" type=${props.type || 'text'}
          value=${props.value === undefined || props.value === null ? '' : props.value}
          placeholder=${props.placeholder || ''}
          step=${props.step} min=${props.min}
          disabled=${props.disabled}
          onInput=${function (e) { props.onInput(e.target.value); }} />
        ${err ? html`<span class="field-error">${t(err)}</span>` : null}
      </label>`;
  }

  function SelectField(props) {
    return html`
      <label class="field field-block">
        ${props.label ? html`<span class="field-label">${props.label}</span>` : null}
        <span class="select-wrap">
          <select class="select" value=${props.value} disabled=${props.disabled}
            onChange=${function (e) { props.onChange(e.target.value); }}>
            ${props.options.map(function (o) {
              return html`<option key=${o.value} value=${o.value}>${o.label}</option>`;
            })}
          </select>
          <svg class="select-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </span>
      </label>`;
  }

  function TrashButton(props) {
    return html`
      <button type="button" class="icon-btn icon-btn-danger" aria-label=${t('settings.delete')}
        onClick=${props.onClick}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
  }

  function opt(values) {
    return values.map(function (v) { return { value: v, label: v }; });
  }

  /* ---------- Site tab ---------- */

  function SiteTab(props) {
    var cfg = props.cfg;
    var errors = validateSite(cfg);
    function set(k) { return function (v) { props.patch(k, v); }; }
    return html`
      <${ui.Card} group="grid">
        <p class="settings-scope">${t('settings.scope_note')}</p>
        <div class="settings-form">
          <${Field} label=${t('settings.site.id')} value=${cfg.id} error=${errors.id}
            disabled=${props.idLocked} onInput=${set('id')} />
          <${Field} label=${t('settings.site.name')} value=${cfg.name} error=${errors.name} onInput=${set('name')} />
          <${Field} label=${t('settings.site.location')} value=${cfg.location} onInput=${set('location')} />
          <${Field} label=${t('settings.site.description')} value=${cfg.description} onInput=${set('description')} />
        </div>
        <${SaveBar} disabled=${hasErrors(errors)} onSave=${props.onSave} saving=${props.saving} />
      <//>`;
  }

  /* ---------- master-detail generic list ---------- */

  function MasterDetail(props) {
    /* props: items[], selected index or -1, labelFn, onSelect, onAdd, detail (vnode) */
    var mobileDetail = props.selected >= 0;
    return html`
      <div class=${'master-detail' + (mobileDetail ? ' md-show-detail' : '')}>
        <div class="md-list">
          <div class="md-list-head">
            <span class="md-list-title">${props.listTitle}</span>
            <${ui.Button} small onClick=${props.onAdd}>${t('settings.add')}<//>
          </div>
          ${props.items.length === 0
            ? html`<p class="md-empty">${t('settings.empty')}</p>`
            : props.items.map(function (it, i) {
                return html`
                  <button key=${i} type="button"
                    class=${'md-row' + (i === props.selected ? ' md-row-active' : '')}
                    onClick=${function () { props.onSelect(i); }}>${props.labelFn(it, i)}</button>`;
              })}
        </div>
        <div class="md-detail">
          ${props.selected >= 0
            ? html`
                <button type="button" class="md-back" onClick=${function () { props.onSelect(-1); }}>← ${t('settings.back')}</button>
                ${props.detail}`
            : html`<p class="md-empty md-detail-empty">${t('settings.select_hint')}</p>`}
        </div>
      </div>`;
  }

  function SaveBar(props) {
    return html`
      <div class="settings-actions">
        <${ui.Button} disabled=${props.disabled || props.saving} onClick=${props.onSave}>
          ${props.saving ? t('settings.saving') : t('settings.save')}
        <//>
      </div>`;
  }

  /* modbustcp config fields, shared by Load/Production/Grid detail forms
     (the standalone Modbus tab has its own ModbusRegDetail below, plus
     id/name/unitLabel fields those items alone need). */
  function ModbusIntegFields(props) {
    var m = props.item;
    var errors = props.errors;
    function set(k) { return function (v) { props.patch(k, v); }; }
    return html`
      <${Field} label=${t('settings.modbus.url')} value=${m.url} placeholder="192.168.0.102:502"
        error=${errors.url} onInput=${set('url')} />
      <${Field} label=${t('settings.modbus.unit')} type="number" step="1" min="1" max="247"
        value=${m.unit} placeholder="1" error=${errors.unit} onInput=${set('unit')} />
      <${SelectField} label=${t('settings.modbus.function')} value=${String(m.function || 3)}
        options=${MODBUS_FUNCTIONS} onChange=${set('function')} />
      <${Field} label=${t('settings.modbus.register')} type="number" step="1" min="0"
        value=${m.register} error=${errors.register} onInput=${set('register')} />
      <${SelectField} label=${t('settings.modbus.dtype')} value=${m.dtype || 'float32'}
        options=${opt(MODBUS_DTYPES)} onChange=${set('dtype')} />
      <${Field} label=${t('settings.modbus.scale')} type="number" step="any" value=${m.scale}
        placeholder="1" error=${errors.scale} onInput=${set('scale')} />
      <label class="toggle-wrap">
        <input type="checkbox" class="toggle" checked=${m.swap_words === true}
          onChange=${function (e) { props.patch('swap_words', e.target.checked); }} />
        <span>${t('settings.modbus.swap_words')}</span>
      </label>`;
  }

  /* ---------- Loads tab ---------- */

  function LoadDetail(props) {
    var load = props.item;
    var others = props.otherIds;
    var errors = validateLoad(load, others);
    function set(k) { return function (v) { props.patch(k, v); }; }
    function setUrl(k) {
      return function (v) {
        var url = Object.assign({}, load.url || {});
        url[k] = v;
        props.patch('url', url);
      };
    }
    var integ = load.integration || 'simulator';
    var url = (integ === 'shelly') ? (load.url || {}) : {};

    return html`
      <div>
        <div class="md-detail-head">
          <h3 class="md-detail-title">${load.friendlyName || load.id || t('settings.new_entry')}</h3>
          <${TrashButton} onClick=${props.onDelete} />
        </div>
        <div class="settings-form">
          <${Field} label=${t('settings.load.id')} value=${load.id} error=${errors.id} onInput=${set('id')} />
          <${Field} label=${t('settings.load.name')} value=${load.friendlyName} onInput=${set('friendlyName')} />
          <${Field} label=${t('settings.load.power')} type="number" min="0" value=${load.currentPower}
            error=${errors.currentPower} onInput=${set('currentPower')} />
          <${SelectField} label=${t('settings.load.type')} value=${load.loadType || LOAD_TYPES[0]}
            options=${opt(LOAD_TYPES)} onChange=${set('loadType')} />
          <${Field} label=${t('settings.load.priority')} type="number" min="1" value=${load.priority}
            error=${errors.priority} onInput=${set('priority')} />
          <${SelectField} label=${t('settings.integration')} value=${integ}
            options=${opt(LOAD_INTEGRATIONS)} onChange=${set('integration')} />
        </div>
        <div class="settings-subhead">${t('settings.integration_config')}</div>
        <div class="settings-form">
          ${integ === 'shelly' ? html`
            <${Field} label=${t('settings.url.on')} value=${url.on} error=${errors['url.on']} onInput=${setUrl('on')} />
            <${Field} label=${t('settings.url.off')} value=${url.off} error=${errors['url.off']} onInput=${setUrl('off')} />
            <${Field} label=${t('settings.url.status')} value=${url.status} error=${errors['url.status']} onInput=${setUrl('status')} />`
          : integ === 'modbustcp' ? html`
            <${ModbusIntegFields} item=${load} errors=${errors} patch=${props.patch} />`
          : html`
            <${Field} label=${t('settings.url')} value=${load.url} error=${errors.url} onInput=${set('url')} />
            ${integ === 'homeassistant' ? html`
              <${Field} label=${t('settings.token')} type="password" value=${load.token} error=${errors.token} onInput=${set('token')} />` : null}`}
        </div>
      </div>`;
  }

  /* ---------- Production tab ---------- */

  function ProductionDetail(props) {
    var p = props.item;
    var errors = validateProduction(p, props.otherIds);
    function set(k) { return function (v) { props.patch(k, v); }; }
    var integ = p.integration || 'simulator';
    return html`
      <div>
        <div class="md-detail-head">
          <h3 class="md-detail-title">${p.friendlyName || p.id || t('settings.new_entry')}</h3>
          <${TrashButton} onClick=${props.onDelete} />
        </div>
        <div class="settings-form">
          <${Field} label=${t('settings.prod.id')} value=${p.id} error=${errors.id} onInput=${set('id')} />
          <${Field} label=${t('settings.prod.name')} value=${p.friendlyName} onInput=${set('friendlyName')} />
          <${SelectField} label=${t('settings.prod.type')} value=${p.productionType || PROD_TYPES[0]}
            options=${PROD_TYPES.map(function (v) { return { value: v, label: t(PRODTYPE_LABEL[v]) }; })}
            onChange=${set('productionType')} />
          ${unknownProdType(p.productionType) ? html`
            <div class="settings-warn" role="status">${t('settings.prodtype.unknown_warn')}</div>` : null}
          <${SelectField} label=${t('settings.dimension')} value=${p.dimension || 'W'}
            options=${opt(DIMENSIONS)} onChange=${set('dimension')} />
          <${SelectField} label=${t('settings.integration')} value=${integ}
            options=${opt(PROD_INTEGRATIONS)} onChange=${set('integration')} />
        </div>
        <div class="settings-subhead">${t('settings.integration_config')}</div>
        <div class="settings-form">
          ${integ === 'gplug' ? html`
            <${Field} label=${t('settings.sensor')} value=${p.sensor} placeholder="z" error=${errors.sensor} onInput=${set('sensor')} />
            <${Field} label=${t('settings.field')} value=${p.field} error=${errors.field} onInput=${set('field')} />
            <${Field} label=${t('settings.scale_field')} value=${p.scale_field} placeholder=${scaleFieldHint(p.field)} error=${errors.scale_field} onInput=${set('scale_field')} />
            <${Field} label=${t('settings.scale_base')} type="number" step="1" min="-10" value=${p.scale_base} placeholder="0" error=${errors.scale_base} onInput=${set('scale_base')} />
            <${Field} label=${t('settings.max_power')} type="number" step="1" min="1" value=${p.max_power} error=${errors.max_power} onInput=${set('max_power')} />
            <${Field} label=${t('settings.stale_after')} type="number" step="1" min="1" value=${p.stale_after} placeholder="600" error=${errors.stale_after} onInput=${set('stale_after')} />
            <${Field} label=${t('settings.energy_field')} value=${p.energy_field} placeholder="E_AC" error=${errors.energy_field} onInput=${set('energy_field')} />
            <${SelectField} label=${t('settings.energy_dimension')} value=${p.energy_dimension || ''}
              options=${[{ value: '', label: t('settings.energy_dimension_auto') }].concat(opt(ENERGY_DIMENSIONS))}
              onChange=${set('energy_dimension')} />
            <${Field} label=${t('settings.energy_scale_field')} value=${p.energy_scale_field} placeholder=${scaleFieldHint(p.energy_field)} error=${errors.energy_scale_field} onInput=${set('energy_scale_field')} />
            <${Field} label=${t('settings.energy_scale_base')} type="number" step="1" min="-10" value=${p.energy_scale_base} placeholder="0" error=${errors.energy_scale_base} onInput=${set('energy_scale_base')} />`
          : integ === 'modbustcp' ? html`
            <${ModbusIntegFields} item=${p} errors=${errors} patch=${props.patch} />`
          : html`
            <${Field} label=${t('settings.url')} value=${p.url} error=${errors.url} onInput=${set('url')} />
            ${integ === 'homeassistant' ? html`
              <${Field} label=${t('settings.token')} type="password" value=${p.token} error=${errors.token} onInput=${set('token')} />` : null}`}
        </div>
        ${isBatteryType(p.productionType) ? html`
          <div class="settings-subhead">${t('settings.battery')}</div>
          <p class="settings-scope">${t('settings.battery_hint')}</p>
          <div class="settings-form">
            <${Field} label=${t('settings.capacity')} type="number" step="1" min="1" value=${p.capacity} error=${errors.capacity} onInput=${set('capacity')} />
            <${Field} label=${t('settings.max_charge_power')} type="number" step="1" min="1" value=${p.maxChargePower} error=${errors.maxChargePower} onInput=${set('maxChargePower')} />
            <${Field} label=${t('settings.max_discharge_power')} type="number" step="1" min="1" value=${p.maxDischargePower} error=${errors.maxDischargePower} onInput=${set('maxDischargePower')} />
            ${integ === 'gplug' ? html`
              <${Field} label=${t('settings.soc_field')} value=${p.soc_field} placeholder="ChaState" error=${errors.soc_field} onInput=${set('soc_field')} />
              <${Field} label=${t('settings.soc_scale_field')} value=${p.soc_scale_field} placeholder=${scaleFieldHint(p.soc_field)} error=${errors.soc_scale_field} onInput=${set('soc_scale_field')} />
              <${Field} label=${t('settings.soc_scale_base')} type="number" step="1" min="-10" value=${p.soc_scale_base} placeholder="0" error=${errors.soc_scale_base} onInput=${set('soc_scale_base')} />`
            : integ !== 'simulator' ? html`
              <${Field} label=${t('settings.soc_url')} value=${p.soc_url} error=${errors.soc_url} onInput=${set('soc_url')} />` : null}
            <label class="toggle-wrap">
              <input type="checkbox" class="toggle" checked=${p.invert === true}
                onChange=${function (e) { props.patch('invert', e.target.checked); }} />
              <span>${t('settings.invert')}</span>
            </label>
          </div>` : null}
      </div>`;
  }

  /* ---------- Grid tab ---------- */

  function GridDetail(props) {
    var g = props.item;
    var errors = validateGrid(g);
    function set(k) { return function (v) { props.patch(k, v); }; }
    var integ = g.integration || 'simulator';
    var label = g.id === 'to' ? t('settings.grid.to') : t('settings.grid.from');
    return html`
      <div>
        <div class="md-detail-head">
          <h3 class="md-detail-title">${label}</h3>
        </div>
        <div class="settings-form">
          <${SelectField} label=${t('settings.dimension')} value=${g.dimension || 'W'}
            options=${opt(DIMENSIONS)} onChange=${set('dimension')} />
          <${SelectField} label=${t('settings.integration')} value=${integ}
            options=${opt(PROD_INTEGRATIONS)} onChange=${set('integration')} />
        </div>
        <div class="settings-subhead">${t('settings.integration_config')}</div>
        <div class="settings-form">
          ${integ === 'gplug' ? html`
            <${Field} label=${t('settings.sensor')} value=${g.sensor} placeholder="z" error=${errors.sensor} onInput=${set('sensor')} />
            <${Field} label=${t('settings.field')} value=${g.field} error=${errors.field} onInput=${set('field')} />
            <${Field} label=${t('settings.scale_field')} value=${g.scale_field} placeholder=${scaleFieldHint(g.field)} error=${errors.scale_field} onInput=${set('scale_field')} />
            <${Field} label=${t('settings.scale_base')} type="number" step="1" min="-10" value=${g.scale_base} placeholder="0" error=${errors.scale_base} onInput=${set('scale_base')} />
            <${Field} label=${t('settings.max_power')} type="number" step="1" min="1" value=${g.max_power} error=${errors.max_power} onInput=${set('max_power')} />
            <${Field} label=${t('settings.stale_after')} type="number" step="1" min="1" value=${g.stale_after} placeholder="600" error=${errors.stale_after} onInput=${set('stale_after')} />
            <${Field} label=${t('settings.energy_field')} value=${g.energy_field} placeholder="E_AC" error=${errors.energy_field} onInput=${set('energy_field')} />`
          : integ === 'modbustcp' ? html`
            <${ModbusIntegFields} item=${g} errors=${errors} patch=${props.patch} />`
          : html`
            <${Field} label=${t('settings.url')} value=${g.url} error=${errors.url} onInput=${set('url')} />
            ${integ === 'homeassistant' ? html`
              <${Field} label=${t('settings.token')} type="password" value=${g.token} error=${errors.token} onInput=${set('token')} />` : null}`}
        </div>
      </div>`;
  }

  /* ---------- Modbus tab (standalone registers) ---------- */

  function ModbusRegDetail(props) {
    var m = props.item;
    var errors = validateModbusReg(m, props.otherIds);
    function set(k) { return function (v) { props.patch(k, v); }; }
    return html`
      <div>
        <div class="md-detail-head">
          <h3 class="md-detail-title">${m.friendlyName || m.id || t('settings.new_entry')}</h3>
          <${TrashButton} onClick=${props.onDelete} />
        </div>
        <div class="settings-form">
          <${Field} label=${t('settings.modbus.id')} value=${m.id} error=${errors.id} onInput=${set('id')} />
          <${Field} label=${t('settings.modbus.name')} value=${m.friendlyName} onInput=${set('friendlyName')} />
          <${Field} label=${t('settings.modbus.url')} value=${m.url} placeholder="192.168.0.102:502"
            error=${errors.url} onInput=${set('url')} />
          <${Field} label=${t('settings.modbus.unit')} type="number" step="1" min="1" max="247"
            value=${m.unit} placeholder="1" error=${errors.unit} onInput=${set('unit')} />
          <${SelectField} label=${t('settings.modbus.function')} value=${String(m.function || 3)}
            options=${MODBUS_FUNCTIONS} onChange=${set('function')} />
          <${Field} label=${t('settings.modbus.register')} type="number" step="1" min="0"
            value=${m.register} error=${errors.register} onInput=${set('register')} />
          <${SelectField} label=${t('settings.modbus.dtype')} value=${m.dtype || 'float32'}
            options=${opt(MODBUS_DTYPES)} onChange=${set('dtype')} />
          <${Field} label=${t('settings.modbus.scale')} type="number" step="any" value=${m.scale}
            placeholder="1" error=${errors.scale} onInput=${set('scale')} />
          <${Field} label=${t('settings.modbus.unit_label')} value=${m.unitLabel} placeholder="kWh"
            onInput=${set('unitLabel')} />
          <label class="toggle-wrap">
            <input type="checkbox" class="toggle" checked=${m.swap_words === true}
              onChange=${function (e) { props.patch('swap_words', e.target.checked); }} />
            <span>${t('settings.modbus.swap_words')}</span>
          </label>
        </div>
      </div>`;
  }

  /* Generic array tab wiring loads/productions/grid over MasterDetail. */
  function ArrayTab(props) {
    var sel = useState(-1);
    var selected = sel[0], setSelected = sel[1];
    var items = props.items;

    function patchItem(k, v) {
      var next = items.slice();
      var item = Object.assign({}, next[selected]);
      item[k] = v;
      next[selected] = item;
      props.onChange(next);
    }
    function add() {
      var next = items.concat([props.blank()]);
      props.onChange(next);
      setSelected(next.length - 1);
    }
    function del() {
      var removed = items[selected];
      /* only confirm for entries that actually exist on the device; a
         freshly-added, never-saved entry is removed without a prompt. */
      var persisted = (props.persistedIds || []).indexOf(String(removed && removed.id)) !== -1;
      if (persisted && !window.confirm(t(props.confirmKey))) return;
      var next = items.slice();
      next.splice(selected, 1);
      setSelected(-1);
      if (props.onDelete) props.onDelete(removed);
      props.onChange(next);
    }

    /* validate every item so «Speichern» disables on any invalid entry */
    var allErr = items.some(function (it, i) {
      var others = items.filter(function (_, j) { return j !== i; })
        .map(function (x) { return String(x.id); });
      return hasErrors(props.validate(it, others));
    });

    var detail = selected >= 0 && items[selected]
      ? html`<${props.Detail} item=${items[selected]} patch=${patchItem} onDelete=${del}
          otherIds=${items.filter(function (_, j) { return j !== selected; }).map(function (x) { return String(x.id); })} />`
      : null;

    return html`
      <${ui.Card} group=${props.group}>
        <${MasterDetail}
          items=${items} selected=${selected}
          listTitle=${props.listTitle}
          labelFn=${props.labelFn}
          onSelect=${setSelected}
          onAdd=${props.fixedList ? null : add}
          detail=${detail} />
        <${SaveBar} disabled=${allErr} onSave=${props.onSave} saving=${props.saving} />
      <//>`;
  }

  /* ---------- Tariffs tab ---------- */

  function TariffsTab(props) {
    var tar = props.tariffs;
    var errors = validateTariffs(tar);
    function set(k) { return function (v) { props.patch(k, v); }; }

    /* spec 009: ht_windows editing goes through props.setWindows (whole-array
       replace) so the config document stays the single source of truth. */
    var wins = Array.isArray(tar.ht_windows) ? tar.ht_windows : [];
    function setWin(i, k, v) {
      var next = wins.map(function (w, j) {
        if (j !== i) return w;
        var o = Object.assign({}, w); o[k] = v; return o;
      });
      props.setWindows(next);
    }
    function addWin() { props.setWindows(wins.concat([{ days: 'mo-fr', from: 6, to: 21 }])); }
    function delWin(i) { props.setWindows(wins.filter(function (_, j) { return j !== i; })); }

    /* both HT+NT set (numbers) but no windows -> flat with HT rate; warn (hint,
       not a save error — spec 009 edge case). */
    var htBoth = isNum(tar.grid_import_ht_chf_kwh) && isNum(tar.grid_import_nt_chf_kwh);
    var winEmptyWarn = htBoth && wins.length === 0;

    return html`
      <${ui.Card} group="grid">
        <div class="settings-subhead">${t('settings.tariff.grid_import_group')}</div>
        <div class="settings-form">
          <${Field} label=${t('settings.tariff.grid_import_chf_kwh')} type="number" step="0.01" min="0"
            value=${tar.grid_import_chf_kwh} error=${errors.grid_import_chf_kwh} onInput=${set('grid_import_chf_kwh')} />
        </div>

        <div class="settings-subhead">${t('settings.tariff.htnt_group')}</div>
        <p class="settings-scope">${t('settings.tariff.htnt_note')}</p>
        <div class="settings-form">
          <${Field} label=${t('settings.tariff.grid_import_ht_chf_kwh')} type="number" step="0.01" min="0"
            value=${tar.grid_import_ht_chf_kwh} error=${errors.grid_import_ht_chf_kwh} onInput=${set('grid_import_ht_chf_kwh')} />
          <${Field} label=${t('settings.tariff.grid_import_nt_chf_kwh')} type="number" step="0.01" min="0"
            value=${tar.grid_import_nt_chf_kwh} error=${errors.grid_import_nt_chf_kwh} onInput=${set('grid_import_nt_chf_kwh')} />
        </div>

        <div class="settings-subhead">${t('settings.tariff.ht_windows_group')}</div>
        <p class="settings-scope">${t('settings.tariff.ht_windows_note')}</p>
        ${wins.map(function (w, i) {
          return html`
            <div key=${i} class="settings-form ht-window-row">
              <${Field} label=${t('settings.tariff.win_days')} value=${w.days}
                placeholder=${t('settings.tariff.win_days.ph')} onInput=${function (v) { setWin(i, 'days', v); }} />
              <${Field} label=${t('settings.tariff.win_from')} type="number" step="0.5" min="0"
                value=${w.from} error=${errors['win.' + i]} onInput=${function (v) { setWin(i, 'from', num(v)); }} />
              <${Field} label=${t('settings.tariff.win_to')} type="number" step="0.5" min="0"
                value=${w.to} onInput=${function (v) { setWin(i, 'to', num(v)); }} />
              <${TrashButton} onClick=${function () { delWin(i); }} />
            </div>`;
        })}
        <${ui.Button} small secondary onClick=${addWin}>${t('settings.tariff.win_add')}<//>
        ${winEmptyWarn ? html`<p class="settings-warn">${t('settings.tariff.win_empty_warn')}</p>` : null}

        <div class="settings-subhead">${t('settings.tariff.feedin_group')}</div>
        <div class="settings-form">
          <${Field} label=${t('settings.tariff.grid_feedin_chf_kwh')} type="number" step="0.01" min="0"
            value=${tar.grid_feedin_chf_kwh} error=${errors.grid_feedin_chf_kwh} onInput=${set('grid_feedin_chf_kwh')} />
          <${Field} label=${t('settings.tariff.base_fee_chf_month')} type="number" step="0.01" min="0"
            value=${tar.base_fee_chf_month} error=${errors.base_fee_chf_month} onInput=${set('base_fee_chf_month')} />
        </div>
        <div class="settings-subhead">${t('settings.tariff.co2_group')}</div>
        <div class="settings-form">
          <${Field} label=${t('settings.tariff.co2_g_kwh')} type="number" step="1" min="0"
            value=${tar.co2_g_kwh} error=${errors.co2_g_kwh} onInput=${set('co2_g_kwh')} />
        </div>
        <${SaveBar} disabled=${hasErrors(errors)} onSave=${props.onSave} saving=${props.saving} />
      <//>`;
  }

  /* small numeric coerce for input strings: '' -> undefined so an empty field
     is treated as unset (not 0). */
  function num(v) { return isBlank(v) ? undefined : Number(v); }

  /* ---------- gPlug tab (device-level Tasmota operations) ----------
     Independent of the config document: talks straight to Tasmota's own
     `/cm?cmnd=` HTTP API (firmware-level, not webservice.be) for restart and
     Wi-Fi (SSId1/2, Password1/2, WifiScan). See api.js for the command
     wrappers and their rationale (Backlog batching, masked passwords). */

  /* setWifiConfig() batches the four commands as `Backlog a;b;c;d` — a ';' in
     any field would be parsed as a Backlog command separator and silently
     corrupt the credentials sent to the device, so it is rejected client-side. */
  function validateWifi(form) {
    var e = {};
    ['ssid1', 'password1', 'ssid2', 'password2'].forEach(function (k) {
      if (!isBlank(form[k]) && String(form[k]).indexOf(';') >= 0) {
        e[k] = 'settings.err.wifi_semicolon';
      }
    });
    return e;
  }

  function WifiScanRow(props) {
    var n = props.net;
    var rssi = n.RSSI !== undefined ? n.RSSI + '%' : (n.Signal !== undefined ? n.Signal + ' dBm' : '');
    return html`
      <div class="wifi-scan-row">
        <div>
          <div class="wifi-scan-ssid">${n.SSId || n.SSId1 || '?'}</div>
          <div class="wifi-scan-meta">${[rssi, n.Channel !== undefined ? 'Ch ' + n.Channel : '', n.Encryption].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="wifi-scan-actions">
          <${ui.Button} small secondary onClick=${function () { props.onUse(1); }}>${t('settings.gplug.scan_use1')}<//>
          <${ui.Button} small secondary onClick=${function () { props.onUse(2); }}>${t('settings.gplug.scan_use2')}<//>
        </div>
      </div>`;
  }

  function GplugTab() {
    var stForm = useState(null);   /* {ssid1, password1, ssid2, password2} | null while loading */
    var form = stForm[0], setForm = stForm[1];
    var stLoadErr = useState(false);
    var loadErr = stLoadErr[0], setLoadErr = stLoadErr[1];
    var stSaving = useState(false);
    var saving = stSaving[0], setSaving = stSaving[1];
    var stRestarting = useState(false);
    var restarting = stRestarting[0], setRestarting = stRestarting[1];
    var stScan = useState({ scanning: false, networks: null, error: false });
    var scan = stScan[0], setScan = stScan[1];

    function load() {
      setLoadErr(false);
      setForm(null);
      api.getWifiConfig()
        .then(function (cfg) { setForm({ ssid1: cfg.ssid1, password1: '', ssid2: cfg.ssid2, password2: '' }); })
        .catch(function () { setLoadErr(true); });
    }
    useEffect(function () { load(); }, []);

    function set(k) { return function (v) { setForm(function (p) { var n = Object.assign({}, p); n[k] = v; return n; }); }; }

    function restart() {
      if (restarting || !window.confirm(t('settings.gplug.restart_confirm'))) return;
      setRestarting(true);
      api.restartDevice()
        .then(function () { toast(t('settings.gplug.restart_success'), { type: 'info' }); })
        .catch(function () { toast(t('settings.gplug.restart_error'), { type: 'error' }); })
        .then(function () { setRestarting(false); });
    }

    function save() {
      if (saving || !form || hasErrors(validateWifi(form))) return;
      setSaving(true);
      api.setWifiConfig(form)
        .then(function () { toast(t('settings.gplug.wifi_saved'), { type: 'info' }); })
        .catch(function (e) { toast((e && e.message) || t('settings.save_error'), { type: 'error' }); })
        .then(function () { setSaving(false); });
    }

    /* WifiScan 1 starts the scan; poll WifiScan (no arg) up to ~10x/10s — the
       result stays a string ("Scanning"/"Busy") until the network list is
       ready (see api.js wifiScanStart/wifiScanResult). */
    function startScan() {
      setScan({ scanning: true, networks: null, error: false });
      api.wifiScanStart().catch(function () { /* best effort — poll anyway */ });
      var attempts = 0;
      function poll() {
        attempts += 1;
        api.wifiScanResult()
          .then(function (d) {
            var res = (d && (d.WiFiScan !== undefined ? d.WiFiScan : d.WifiScan));
            if (res && typeof res === 'object') {
              var nets = Object.keys(res).map(function (k) { return res[k]; });
              nets.sort(function (a, b) { return (Number(b.RSSI) || 0) - (Number(a.RSSI) || 0); });
              setScan({ scanning: false, networks: nets, error: false });
              return;
            }
            if (attempts >= 10) {
              setScan({ scanning: false, networks: null, error: true });
              return;
            }
            setTimeout(poll, 1000);
          })
          .catch(function () { setScan({ scanning: false, networks: null, error: true }); });
      }
      setTimeout(poll, 1000);
    }

    function useNetwork(slot, ssid) {
      setForm(function (p) { var n = Object.assign({}, p); n['ssid' + slot] = ssid; return n; });
    }

    if (loadErr) {
      return html`
        <${ui.Card} group="grid">
          <p class="placeholder-text">${t('settings.load_error')}</p>
          <${ui.Button} secondary small onClick=${load}>${t('settings.retry')}<//>
        <//>`;
    }
    if (!form) {
      return html`<${ui.Card} group="grid"><p class="placeholder-text">${t('settings.loading')}</p><//>`;
    }
    var wifiErrors = validateWifi(form);
    return html`
      <div>
        <${ui.Card} group="grid" title=${t('settings.gplug.restart_title')}>
          <p class="settings-scope">${t('settings.gplug.restart_desc')}</p>
          <div class="settings-actions">
            <${ui.Button} danger disabled=${restarting} onClick=${restart}>
              ${restarting ? t('settings.gplug.restarting') : t('settings.gplug.restart_button')}
            <//>
          </div>
        <//>

        <${ui.Card} group="grid" title=${t('settings.gplug.wifi_title')}>
          <p class="settings-scope">${t('settings.gplug.wifi_note')}</p>
          <div class="settings-subhead">${t('settings.gplug.wifi_primary')}</div>
          <div class="settings-form">
            <${Field} label=${t('settings.gplug.ssid1')} value=${form.ssid1} error=${wifiErrors.ssid1} onInput=${set('ssid1')} />
            <${Field} label=${t('settings.gplug.password1')} type="password" value=${form.password1} error=${wifiErrors.password1}
              placeholder=${t('settings.gplug.password_placeholder')} onInput=${set('password1')} />
          </div>
          <div class="settings-subhead">${t('settings.gplug.wifi_secondary')}</div>
          <div class="settings-form">
            <${Field} label=${t('settings.gplug.ssid2')} value=${form.ssid2} error=${wifiErrors.ssid2} onInput=${set('ssid2')} />
            <${Field} label=${t('settings.gplug.password2')} type="password" value=${form.password2} error=${wifiErrors.password2}
              placeholder=${t('settings.gplug.password_placeholder')} onInput=${set('password2')} />
          </div>

          <div class="settings-subhead">${t('settings.gplug.scan_button')}</div>
          <${ui.Button} secondary small disabled=${scan.scanning} onClick=${startScan}>
            ${scan.scanning ? t('settings.gplug.scanning') : t('settings.gplug.scan_button')}
          <//>
          ${scan.error ? html`<p class="settings-warn">${t('settings.gplug.scan_error')}</p>` : null}
          ${scan.networks && scan.networks.length === 0 ? html`<p class="placeholder-text">${t('settings.gplug.scan_empty')}</p>` : null}
          ${scan.networks && scan.networks.length > 0 ? html`
            <div class="wifi-scan-list">
              ${scan.networks.map(function (n, i) {
                return html`<${WifiScanRow} key=${i} net=${n} onUse=${function (slot) { useNetwork(slot, n.SSId); }} />`;
              })}
            </div>` : null}

          <${SaveBar} disabled=${hasErrors(wifiErrors)} onSave=${save} saving=${saving} />
        <//>
      </div>`;
  }

  /* ---------- Daten tab (browser archive coverage, spec 011 FR-1107/1109/1110) ----------
     The device only buffers the last few weeks of raw records; the long
     history lives in THIS browser's IndexedDB. This tab is where the user sees
     how much of it there is, whether it has holes, and can move it between
     browsers via export/import. Independent of the shared config document. */
  /* trigger a client-side file download of `text` as `name` (UTF-8) */
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function fmtBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
  }

  function DatenTab() {
    var stCov = useState(null);        /* coverage | null while loading */
    var cov = stCov[0], setCov = stCov[1];
    var stState = useState(archive.state());
    var arch = stState[0], setArch = stState[1];
    var stBusy = useState(false);
    var busy = stBusy[0], setBusy = stBusy[1];

    function refreshCoverage(st) {
      if (!st.available || !st.siteId) { setCov(null); return; }
      archive.coverage(st.siteId).then(setCov, function () { setCov(null); });
    }

    useEffect(function () {
      var stop = archive.onChange(function (st) { setArch(Object.assign({}, st)); refreshCoverage(st); });
      archive.ready().then(function (st) { setArch(Object.assign({}, st)); refreshCoverage(st); });
      return stop;
    }, []);

    function syncNow() {
      if (busy) return;
      setBusy(true);
      archive.refresh(api).then(function (st) {
        refreshCoverage(st);
        toast(t('settings.data.synced'), { type: 'info' });
      }, function () {
        toast(t('settings.data.sync_error'), { type: 'error' });
      }).then(function () { setBusy(false); });
    }

    function doExport() {
      if (!arch.siteId) return;
      archive.exportText(arch.siteId).then(function (text) {
        download('gplug-archiv-' + arch.siteId + '.csv', text);
      }, function () { toast(t('settings.data.export_error'), { type: 'error' }); });
    }

    function doImport(ev) {
      var file = ev.target && ev.target.files && ev.target.files[0];
      if (!file) return;
      ev.target.value = '';
      file.text().then(function (text) {
        return archive.importText(text, arch.siteId);
      }).then(function (c) {
        setCov(c);
        toast(t('settings.data.import_ok', { count: c.count }), { type: 'info' });
      }, function (e) {
        toast((e && e.message) || t('settings.data.import_error'), { type: 'error' });
      });
    }

    if (arch.available === false) {
      return html`
        <${ui.Card} group="grid" title=${t('settings.data.title')}>
          <p class="settings-warn">${t('settings.data.unavailable')}</p>
          <p class="settings-scope">${t('settings.data.multi_client')}</p>
        <//>`;
    }
    if (!cov) {
      return html`<${ui.Card} group="grid"><p class="placeholder-text">${t('settings.loading')}</p><//>`;
    }

    var est = cov.estimate;
    return html`
      <div>
        <${ui.Card} group="grid" title=${t('settings.data.title')}>
          <p class="settings-scope">${t('settings.data.desc')}</p>
          <dl class="data-facts">
            <dt>${t('settings.data.site')}</dt><dd>${cov.siteId}</dd>
            <dt>${t('settings.data.range')}</dt>
            <dd>${cov.firstE15Ts === null ? t('common.nodata')
              : fmt.time(cov.firstE15Ts, '1d') + ' – ' + fmt.time(cov.lastE15Ts, '1d')}</dd>
            <dt>${t('settings.data.records')}</dt><dd>${cov.count} (${cov.days} ${t('settings.data.days')})</dd>
            <dt>${t('settings.data.last_sync')}</dt>
            <dd>${cov.syncedAt ? fmt.time(cov.syncedAt, '15m') : '–'}</dd>
            <dt>${t('settings.data.storage')}</dt>
            <dd>${est ? fmtBytes(est.usage) + ' / ' + fmtBytes(est.quota) : '–'}</dd>
          </dl>

          <div class="settings-subhead">${t('settings.data.gaps')}</div>
          ${cov.gaps && cov.gaps.length ? html`
            <ul class="data-gaps">
              ${cov.gaps.map(function (g, i) {
                return html`<li key=${i}>${fmt.time(g[0], '15m')} – ${fmt.time(g[1], '15m')}</li>`;
              })}
            </ul>` : html`<p class="settings-scope">${t('settings.data.no_gaps')}</p>`}

          <div class="settings-actions">
            <${ui.Button} secondary small disabled=${busy} onClick=${syncNow}>
              ${busy ? t('settings.data.syncing') : t('settings.data.sync')}
            <//>
          </div>
        <//>

        <${ui.Card} group="grid" title=${t('settings.data.transfer_title')}>
          <p class="settings-scope">${t('settings.data.multi_client')}</p>
          <div class="settings-actions">
            <${ui.Button} secondary small onClick=${doExport}>${t('settings.data.export')}<//>
            <label class="btn btn-secondary btn-small data-import-label">
              ${t('settings.data.import')}
              <input type="file" accept=".csv,text/csv" class="data-import-input"
                onChange=${doImport} />
            </label>
          </div>
        <//>
      </div>`;
  }

  /* ---------- Pro tab (raw site.json editor) ----------
     Direct edit of the whole config document. Independent of the shared config
     doc: reads the verbatim file via api.getConfigRaw() and POSTs it back
     through the same /api/config write path the other tabs use. Since spec 011
     step 2 the device no longer validates the document — it only refuses
     unparseable JSON and a config site.load_config() cannot load (then it
     rolls back). So validateDocument() runs here and lists what it finds, but
     as WARNINGS: the Pro tab stays the escape hatch (spec 011 UC-1105), a bad
     url is saved and fails at poll time like an unreachable host. Only a JSON
     parse error disables Save. */
  function prettyJson(raw) {
    /* pretty-print for editing; if the file is already unparseable, show it
       verbatim so the user can still fix it by hand. */
    try { return JSON.stringify(JSON.parse(raw), null, 2); }
    catch (e) { return raw; }
  }

  function ProTab(props) {
    var stText = useState(null);   /* editor text (null = loading) */
    var text = stText[0], setText = stText[1];
    var stErr = useState(false);   /* load error */
    var loadErr = stErr[0], setLoadErr = stErr[1];
    var stSaving = useState(false);
    var saving = stSaving[0], setSaving = stSaving[1];

    function load() {
      setLoadErr(false);
      setText(null);
      api.getConfigRaw()
        .then(function (raw) { setText(prettyJson(raw)); })
        .catch(function () { setLoadErr(true); });
    }
    useEffect(function () { load(); }, []);

    /* live JSON validity check for the Save guard + inline hint (an empty
       editor also counts as invalid, so Save disables and the hint shows) */
    var parseErr = null;
    var findings = [];
    if (text !== null) {
      try { findings = validateDocument(JSON.parse(text)); }
      catch (e) { parseErr = e.message; }
    }

    function save() {
      if (saving || parseErr) return;
      var doc;
      try { doc = JSON.parse(text); } catch (e) { return; }
      setSaving(true);
      api.postConfig(doc)
        .then(function () {
          toast(t('settings.saved'), { type: 'info' });
          if (props.onSaved) props.onSaved();  /* refresh the shared config doc */
          load();
        })
        .catch(function (e) {
          toast((e && e.message) || t('settings.save_error'), { type: 'error' });
        })
        .then(function () { setSaving(false); });
    }

    if (loadErr) {
      return html`
        <${ui.Card} group="grid">
          <p class="placeholder-text">${t('settings.load_error')}</p>
          <${ui.Button} secondary small onClick=${load}>${t('settings.retry')}<//>
        <//>`;
    }
    if (text === null) {
      return html`<${ui.Card} group="grid"><p class="placeholder-text">${t('settings.loading')}</p><//>`;
    }
    return html`
      <${ui.Card} group="grid">
        <p class="settings-scope">${t('settings.pro.subtitle')}</p>
        <textarea class="settings-editor" spellcheck="false" autocapitalize="off"
          autocomplete="off" autocorrect="off"
          value=${text} onInput=${function (e) { setText(e.target.value); }}></textarea>
        ${parseErr ? html`<p class="settings-warn">${t('settings.pro.invalid_json', { msg: parseErr })}</p>` : null}
        ${findings.length ? html`
          <div class="settings-warn">
            <strong>${t('settings.pro.warnings_title')}</strong>
            <ul class="settings-warn-list">
              ${findings.map(function (f, i) {
                return html`<li key=${i}><code>${f.path || '/'}</code> — ${t(f.key)}</li>`;
              })}
            </ul>
            <span>${t('settings.pro.warn_hint')}</span>
          </div>` : null}
        <div class="settings-actions">
          <${ui.Button} secondary disabled=${saving} onClick=${load}>${t('settings.pro.reload')}<//>
          <${ui.Button} disabled=${saving || !!parseErr} onClick=${save}>
            ${saving ? t('settings.saving') : t('settings.save')}
          <//>
        </div>
      <//>`;
  }

  /* ---------- blank-entry factories ---------- */

  function blankLoad() {
    return { id: '', friendlyName: '', loadType: LOAD_TYPES[0], currentPower: '', priority: 1, integration: 'simulator', url: '' };
  }
  function blankProduction() {
    return { id: '', friendlyName: '', productionType: PROD_TYPES[0], dimension: 'W', integration: 'simulator', url: '' };
  }
  function blankModbusReg() {
    return { id: '', friendlyName: '', integration: 'modbustcp', url: '', unit: 1, function: 3, register: '', dtype: 'float32' };
  }

  /* ---------- page ---------- */

  function Einstellungen(props) {
    var slug = (props.params && props.params.tab) || 'site';
    var tab = SLUG[slug] || 'site';

    var st = useState(null);          /* config document (null = loading) */
    var cfg = st[0], setCfg = st[1];
    var errSt = useState(null);       /* load error */
    var loadErr = errSt[0], setLoadErr = errSt[1];
    var savingSt = useState(false);
    var saving = savingSt[0], setSaving = savingSt[1];
    var savedSt = useState(false);    /* has the doc been saved at least once (id lock) */
    var savedOnce = savedSt[0], setSavedOnce = savedSt[1];
    /* ids that came from the device — deleting one of these confirms first;
       a freshly-added (not-yet-saved) entry is removed silently. */
    var persistSt = useState({ loads: [], productions: [], grid: [], modbusRegisters: [] });
    var persistedIds = persistSt[0], setPersistedIds = persistSt[1];

    function idsOf(arr) {
      return (Array.isArray(arr) ? arr : [])
        .map(function (x) { return String(x && x.id); })
        .filter(function (id) { return !isBlank(id); });
    }

    function fetchConfig() {
      setLoadErr(null);
      api.getConfig()
        .then(function (doc) {
          setCfg(normalize(doc));
          setSavedOnce(!isBlank(doc && doc.id));
          setPersistedIds({
            loads: idsOf(doc && doc.loads),
            productions: idsOf(doc && doc.productions),
            grid: idsOf(doc && doc.grid),
            modbusRegisters: idsOf(doc && doc.modbusRegisters),
          });
        })
        .catch(function () { setLoadErr(true); setCfg(null); });
    }

    useEffect(function () { fetchConfig(); }, []);

    function normalize(doc) {
      doc = doc || {};
      var out = Object.assign({}, doc);
      out.loads = Array.isArray(doc.loads) ? doc.loads : [];
      out.productions = Array.isArray(doc.productions) ? doc.productions : [];
      out.grid = Array.isArray(doc.grid) ? doc.grid : [];
      out.modbusRegisters = Array.isArray(doc.modbusRegisters) ? doc.modbusRegisters : [];
      out.tariffs = Object.assign({}, TARIFF_DEFAULTS, doc.tariffs || {});
      return out;
    }

    function patchTop(k, v) {
      setCfg(function (prev) { var n = Object.assign({}, prev); n[k] = v; return n; });
    }
    function patchTariff(k, v) {
      setCfg(function (prev) {
        var n = Object.assign({}, prev);
        n.tariffs = Object.assign({}, prev.tariffs); n.tariffs[k] = v;
        return n;
      });
    }
    /* spec 009: replace the whole ht_windows array (add/edit/remove a window) */
    function setWindows(arr) {
      setCfg(function (prev) {
        var n = Object.assign({}, prev);
        n.tariffs = Object.assign({}, prev.tariffs); n.tariffs.ht_windows = arr;
        return n;
      });
    }
    function setArray(k, arr) {
      setCfg(function (prev) { var n = Object.assign({}, prev); n[k] = arr; return n; });
    }

    /* POST the full in-memory document (FR-602), then re-fetch (FR-606). */
    function save() {
      if (saving) return;
      setSaving(true);
      api.postConfig(serialize(cfg))
        .then(function () {
          toast(t('settings.saved'), { type: 'info' });
          setSavedOnce(true);
          fetchConfig();
        })
        .catch(function (e) {
          toast((e && e.message) || t('settings.save_error'), { type: 'error' });
        })
        .then(function () { setSaving(false); });
    }

    /* coerce numeric string inputs back to numbers before sending */
    function serialize(doc) {
      var out = Object.assign({}, doc);
      out.loads = doc.loads.map(function (l) {
        var o = Object.assign({}, l);
        if (o.currentPower !== '' && o.currentPower !== undefined) o.currentPower = Number(o.currentPower);
        if (o.priority !== '' && o.priority !== undefined) o.priority = Number(o.priority);
        return dropBlankModbusKeys(o);
      });
      out.productions = doc.productions.map(function (p) { return dropBlankModbusKeys(dropBlankGplugKeys(p)); });
      out.grid = doc.grid.map(function (g) { return dropBlankModbusKeys(dropBlankGplugKeys(g)); });
      out.modbusRegisters = doc.modbusRegisters.map(function (m) {
        var o = Object.assign({}, m);
        o.function = Number(o.function || 3);
        o.register = Number(o.register);
        if (isBlank(o.unit)) delete o.unit; else o.unit = Number(o.unit);
        if (isBlank(o.scale) || Number(o.scale) === 1) delete o.scale; else o.scale = Number(o.scale);
        if (isBlank(o.unitLabel)) delete o.unitLabel;
        if (o.swap_words !== true) delete o.swap_words;
        return o;
      });
      /* keep any unknown tariff keys; coerce only the known numeric rates */
      out.tariffs = Object.assign({}, doc.tariffs);
      TARIFF_KEYS.forEach(function (k) { out.tariffs[k] = Number(doc.tariffs[k]); });
      /* co2_g_kwh (spec 008): integer, passthrough via /api/meta tariffs */
      if (doc.tariffs.co2_g_kwh !== undefined && doc.tariffs.co2_g_kwh !== '') {
        out.tariffs.co2_g_kwh = Number(doc.tariffs.co2_g_kwh);
      }
      /* spec 009 FR-901: optional HT/NT rates + ht_windows. Blank HT/NT keys
         are dropped (stay flat); windows are coerced to numeric from/to. */
      ['grid_import_ht_chf_kwh', 'grid_import_nt_chf_kwh'].forEach(function (k) {
        if (isBlank(doc.tariffs[k])) { delete out.tariffs[k]; }
        else { out.tariffs[k] = Number(doc.tariffs[k]); }
      });
      if (Array.isArray(doc.tariffs.ht_windows)) {
        if (doc.tariffs.ht_windows.length === 0) {
          delete out.tariffs.ht_windows;
        } else {
          out.tariffs.ht_windows = doc.tariffs.ht_windows.map(function (w) {
            return { days: w.days, from: Number(w.from), to: Number(w.to) };
          });
        }
      }
      return out;
    }

    /* deleting an active/waiting load turns it off first (FR-604) */
    function onDeleteLoad(load) {
      if (!load || isBlank(load.id)) return;
      api.setLoadState(load.id, 'INACTIVE').catch(function () { /* best effort */ });
    }

    function navTab(target) { router.navigate('/einstellungen/' + TAB_SLUG[target]); }

    var pills = TABS.map(function (tk) {
      return html`
        <button key=${tk} type="button"
          class=${'pill' + (tk === tab ? ' pill-active' : '')}
          onClick=${function () { navTab(tk); }}>${t(TAB_LABEL[tk])}</button>`;
    });

    var body;
    if (loadErr) {
      body = html`
        <${ui.Card}>
          <p class="placeholder-text">${t('settings.load_error')}</p>
          <${ui.Button} secondary small onClick=${fetchConfig}>${t('settings.retry')}<//>
        <//>`;
    } else if (!cfg) {
      body = html`<${ui.Card}><p class="placeholder-text">${t('settings.loading')}</p><//>`;
    } else if (tab === 'site') {
      body = html`<${SiteTab} cfg=${cfg} patch=${patchTop} idLocked=${savedOnce}
        onSave=${save} saving=${saving} />`;
    } else if (tab === 'tariffs') {
      body = html`<${TariffsTab} tariffs=${cfg.tariffs} patch=${patchTariff}
        setWindows=${setWindows} onSave=${save} saving=${saving} />`;
    } else if (tab === 'daten') {
      body = html`<${DatenTab} />`;
    } else if (tab === 'gplug') {
      body = html`<${GplugTab} />`;
    } else if (tab === 'pro') {
      body = html`<${ProTab} onSaved=${fetchConfig} />`;
    } else if (tab === 'loads') {
      body = html`<${ArrayTab} group="loads"
        items=${cfg.loads} onChange=${function (a) { setArray('loads', a); }}
        listTitle=${t('settings.tab.loads')}
        labelFn=${function (l) { return l.friendlyName || l.id || t('settings.new_entry'); }}
        blank=${blankLoad} confirmKey="settings.confirm_delete_load"
        persistedIds=${persistedIds.loads}
        onDelete=${onDeleteLoad}
        validate=${validateLoad} Detail=${LoadDetail}
        onSave=${save} saving=${saving} />`;
    } else if (tab === 'productions') {
      body = html`<${ArrayTab} group="production"
        items=${cfg.productions} onChange=${function (a) { setArray('productions', a); }}
        listTitle=${t('settings.tab.productions')}
        labelFn=${function (p) { return p.friendlyName || p.id || t('settings.new_entry'); }}
        blank=${blankProduction} confirmKey="settings.confirm_delete_production"
        persistedIds=${persistedIds.productions}
        validate=${function (p, o) { return validateProduction(p, o); }} Detail=${ProductionDetail}
        onSave=${save} saving=${saving} />`;
    } else if (tab === 'grid') {
      body = html`<${ArrayTab} group="grid" fixedList
        items=${cfg.grid} onChange=${function (a) { setArray('grid', a); }}
        listTitle=${t('settings.tab.grid')}
        labelFn=${function (g) { return g.id === 'to' ? t('settings.grid.to') : t('settings.grid.from'); }}
        blank=${function () { return { id: 'from', dimension: 'W', integration: 'simulator', url: '' }; }}
        confirmKey="settings.confirm_delete_load"
        persistedIds=${persistedIds.grid}
        validate=${function (g) { return validateGrid(g); }} Detail=${GridDetail}
        onSave=${save} saving=${saving} />`;
    } else if (tab === 'modbus') {
      body = html`<${ArrayTab} group="grid"
        items=${cfg.modbusRegisters} onChange=${function (a) { setArray('modbusRegisters', a); }}
        listTitle=${t('settings.tab.modbus')}
        labelFn=${function (m) { return m.friendlyName || m.id || t('settings.new_entry'); }}
        blank=${blankModbusReg} confirmKey="settings.confirm_delete_load"
        persistedIds=${persistedIds.modbusRegisters}
        validate=${validateModbusReg} Detail=${ModbusRegDetail}
        onSave=${save} saving=${saving} />`;
    }

    return html`
      <div>
        <${ui.PageHeader} title=${t('page.settings')} />
        <div class="pill-bar">${pills}</div>
        ${body}
      </div>`;
  }

export { Einstellungen };
