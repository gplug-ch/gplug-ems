# Tests for the integration fetch_item contract (gplug / homeassistant /
# shelly / simulator / modbustcp). Run from the backend/ directory:
#   cd tests && berry -m .. test_integrations.be
#
# Contract under test: fetch_item returns nil (read failed) or a SMALL map
# holding ONLY the fields that fetch produced — never a copy of the item map
# it was handed. site._refresh_item() merges that map into the item, and the
# item IS the cfg passed in, so copying cfg into the result meant two whole-map
# copies per poll tick on a ~30 KB Berry heap (issue #1, point 1).
#
# Also covers the kW-scaling guard: an unguarded result["currentPower"] read
# raised key_error when the fetch produced no value, and that throw propagated
# through site.poll_step() into ems.every_second().

import json
import math
import sys
# integrations/ is flattened into one dir in the built .tapp; in the CLI tests
# it is a subdir, so add it to the module path.
sys.path().push('../integrations')

# --- Tasmota built-in stubs -------------------------------------------------
# Canned HTTP response for the webclient stub; tests set status/body per case.
var _http = {'status': 200, 'body': '{}', 'url': nil, 'calls': 0}

class _WebclientStub
    def begin(url)
        _http['url'] = url
        _http['calls'] = _http['calls'] + 1
        return true
    end
    def add_header(k, v) end
    def GET() return _http['status'] end
    def PUT(payload) return _http['status'] end
    def POST(payload) return _http['status'] end
    def get_string() return _http['body'] end
    def close() end
end
webclient = _WebclientStub

# Canned Modbus TCP transport for the modbustcp stub. connect_ok toggles a
# refused connection; response is the bytes readbytes() hands back on its
# FIRST call, then nil (mirrors a real socket: one chunk, then nothing more
# until the next poll). connect_calls / writes record what the integration
# actually sent, for assertions.
var _tcp = {'connect_ok': true, 'response': nil, 'connect_calls': [], 'writes': []}

class _TcpClientStub
    var _connected
    def connect(host, port, timeout_ms)
        _tcp['connect_calls'].push({'host': host, 'port': port, 'timeout_ms': timeout_ms})
        self._connected = _tcp['connect_ok']
        return self._connected
    end
    def connected() return self._connected end
    def close() self._connected = false end
    def write(content)
        _tcp['writes'].push(content)
        return content.size()
    end
    def readbytes()
        var r = _tcp['response']
        _tcp['response'] = nil
        return r
    end
end
tcpclient = _TcpClientStub

# Functional tasmota stub (set_sensors/rtc/delay). rtc() stays at utc 0, which
# keeps nethost out of the way: below MIN_EPOCH it never skips a host.
import tasmota

import gplug
import homeassistant
import shelly
import simulator
import modbustcp

# Modbus TCP response/exception frame builders (MBAP header + PDU), used only
# by the modbustcp tests below — verified byte-for-byte against a live
# Anybus M-Bus->Modbus TCP gateway (192.168.0.102:502) in the session that
# added this integration (2026-09-22).
def _mb_response(unit, func, data)
    var r = bytes()
    r.add(1, -2)                  # transaction id, unused by the client
    r.add(0, -2)                  # protocol id
    r.add(3 + data.size(), -2)    # length: unit + func + byte_count + data
    r.add(unit, 1)
    r.add(func, 1)
    r.add(data.size(), 1)
    return r .. data
end

def _mb_exception(unit, func, code)
    var r = bytes()
    r.add(1, -2)
    r.add(0, -2)
    r.add(3, -2)                  # unit + (func|0x80) + code
    r.add(unit, 1)
    r.add(func | 0x80, 1)
    r.add(code, 1)
    return r
end

# n-byte big-endian two's-complement wire encoding of an int
def _int_wire(v, n)
    var w = bytes()
    w.add(v, -n)
    return w
end

# big-endian wire encoding of a float32 (bytes.getfloat/setfloat are native
# little-endian, so build little-endian then byte-reverse via re-add — the
# same trick modbustcp._decode uses in reverse)
def _float_wire(v)
    var le = bytes()
    le.resize(4)
    le.setfloat(0, v)
    var w = bytes()
    w.add(le.get(0, 4), -4)
    return w
end

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

# site._refresh_item()'s merge, reproduced so the tests can assert what the
# item map looks like AFTER a poll tick without pulling in the whole site
# module (which needs webserver/store/tasmota driver stubs).
def merge(item, data)
    if data != nil
        for k: data.keys() item[k] = data[k] end
    end
    return item
end

# every fetch_item result must be fetched fields only — no config echo
def check_no_cfg_echo(result, label)
    for k: ['integration', 'power', 'priority', 'token', 'field', 'dimension', 'name']
        check(!result.contains(k), f"{label}: config key '{k}' leaked into result")
    end
end

# ---------------------------------------------------------------------------
# gplug — local sensor read, no webclient
# ---------------------------------------------------------------------------

tasmota.set_sensors('{"Time":"2026-08-14T10:00:00","z":{"Pi":1234,"Po":0}}')
var cfg = {'id': 'grid-in', 'integration': 'gplug', 'field': 'Pi',
           'name': 'Netzbezug', 'power': 0, 'currentPower': 0}
var res = gplug.fetch_item('', nil, cfg)
check(res != nil, "gplug: valid sensor must return a result")
check(size(res) == 1, f"gplug: result must hold ONE fetched field, got {size(res)}")
check(res['currentPower'] == 1234, f"gplug: currentPower expected 1234, got {res['currentPower']}")
check_no_cfg_echo(res, "gplug")
print("Test 1 passed: gplug returns only the fetched field")

# the merge into the item map keeps every configured value
var item = {'id': 'grid-in', 'integration': 'gplug', 'field': 'Pi',
            'name': 'Netzbezug', 'power': 0, 'currentPower': 0}
merge(item, gplug.fetch_item('', nil, item))
check(item['id'] == 'grid-in', "gplug merge: config id must survive")
check(item['name'] == 'Netzbezug', "gplug merge: config name must survive")
check(item['field'] == 'Pi', "gplug merge: config field must survive")
check(item['currentPower'] == 1234, "gplug merge: live value must land in the item")
check(size(item) == 6, f"gplug merge: item must not grow, got {size(item)} keys")
print("Test 2 passed: gplug merge preserves config, adds live value")

# dimension kW scales the fetched value
tasmota.set_sensors('{"z":{"Pi":1.5}}')
res = gplug.fetch_item('', nil, {'field': 'Pi', 'dimension': 'kW'})
check(res['currentPower'] == 1500, f"gplug: kW must scale to 1500, got {res['currentPower']}")
print("Test 3 passed: gplug kW scaling")

# REGRESSION: field absent from the sensor + dimension kW must NOT raise
# key_error (the old code read result["currentPower"] unconditionally)
tasmota.set_sensors('{"z":{"Po":0}}')
res = gplug.fetch_item('', nil, {'field': 'Pi', 'dimension': 'kW'})
check(res != nil, "gplug: missing field must still return a map")
check(size(res) == 0, f"gplug: missing field must yield an empty result, got {size(res)}")
print("Test 4 passed: gplug missing field + kW does not throw")

# no z object at all -> nil (item keeps its cached values)
tasmota.set_sensors('{"Time":"2026-08-14T10:00:00"}')
check(gplug.fetch_item('', nil, {'field': 'Pi'}) == nil, "gplug: no z must return nil")
print("Test 5 passed: gplug without z returns nil")

# fallback path: no "field" in the config -> Power/power key
tasmota.set_sensors('{"z":{"Power":42}}')
res = gplug.fetch_item('', nil, {'id': 'x'})
check(res['currentPower'] == 42, "gplug: Power fallback")
check(!res.contains('id'), "gplug: fallback path must not echo config either")
print("Test 6 passed: gplug Power fallback, no echo")

# issue #10: "sensor" selects another read_sensors() object — here the SMA
# inverter block a gPlug publishes next to z (captured 2026-09-11)
var SMA_SENSORS = '{"Time":"2026-09-11T14:49:11",' +
    '"z":{"SMid":"3130343837303239","Pi":0.000,"Po":14.421,"P1i":0,"P2i":0,"P3i":0,' +
    '"P1o":4954,"P2o":4832,"P3o":4632,"V1":229.1,"V2":229.5,"V3":229.1,"I1":22,"I2":21,' +
    '"I3":20,"Ei1":18752.361,"Ei2":24226.039,"Eo1":118116.025,"Eo2":50.288},' +
    '"SMA":{"spM":103,"spMl":50,"Iac":null,"Iac1":23.3,"Iac2":23.3,"Iac3":23.4,"Isf":-1,' +
    '"U1":229.5,"U2":230.0,"U3":229.6,"Usf":-1,"P_AC":16.07,"Psf":1,"f_AC":49.99,"fsf":-2,' +
    '"Pa_AC":16.07,"Pa_sf":1,"Pr_AC":null,"Pr_sf":1,"pf_AC":0.999,"pfsf":-3,' +
    '"E_AC":30451.047,"Esf":1},' +
    '"ESP32":{"Temperature":42.7},"TempUnit":"C"}'
tasmota.set_sensors(SMA_SENSORS)
cfg = {'id': 'pv-sma', 'integration': 'gplug', 'sensor': 'SMA', 'field': 'P_AC',
       'dimension': 'kW'}
res = gplug.fetch_item('', nil, cfg)
check(res != nil && size(res) == 1, "gplug SMA: must return ONE fetched field")
check(math.abs(res['currentPower'] - 16070) < 0.01,
      f"gplug SMA: P_AC 16.07 kW expected 16070 W, got {res['currentPower']}")
check(!res.contains('sensor'), "gplug SMA: config key 'sensor' leaked into result")
check_no_cfg_echo(res, "gplug SMA")
print("Test 6a passed: gplug sensor=SMA reads P_AC")

# no sensor key (and an empty one) still reads z, as before issue #10
res = gplug.fetch_item('', nil, {'field': 'Po', 'dimension': 'kW'})
check(math.abs(res['currentPower'] - 14421) < 0.01,
      f"gplug: default sensor z, Po expected 14421, got {res['currentPower']}")
res = gplug.fetch_item('', nil, {'sensor': '', 'field': 'Po', 'dimension': 'kW'})
check(math.abs(res['currentPower'] - 14421) < 0.01, "gplug: empty sensor falls back to z")
print("Test 6b passed: gplug without sensor defaults to z")

# a JSON null value produces nothing — the item keeps its cached power
item = {'id': 'pv-sma', 'sensor': 'SMA', 'field': 'Pr_AC', 'currentPower': 500}
res = gplug.fetch_item('', nil, item)
check(res != nil && size(res) == 0, "gplug: null value must yield an empty result")
merge(item, res)
check(item['currentPower'] == 500, "gplug: null value must not clear the cached power")
print("Test 6c passed: gplug null value leaves the item untouched")

# unknown object -> nil; scalar top-level entry is not an object -> nil;
# unknown field in a known object -> empty result
check(gplug.fetch_item('', nil, {'sensor': 'Fronius', 'field': 'P_AC'}) == nil,
      "gplug: unknown sensor object must return nil")
check(gplug.fetch_item('', nil, {'sensor': 'TempUnit', 'field': 'x'}) == nil,
      "gplug: scalar top-level entry must return nil")
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'nope'})
check(res != nil && size(res) == 0, "gplug: unknown field must yield an empty result")
print("Test 6d passed: gplug unknown sensor / scalar / field do not throw")

# read_z() (GET /api/meter) is unchanged by the sensor selection
check(gplug.read_z()['SMid'] == '3130343837303239', "gplug: read_z must still serve z")
check(gplug.read_sensor('ESP32')['Temperature'] == 42.7, "gplug: read_sensor reads any object")
print("Test 6e passed: gplug read_z / read_sensor")

# issue #12: SunSpec dynamic scale factor, opt-in via "scale_field".
# The SMA script already scales P_AC for Psf 1 -> scale_base 1: no change
# while the inverter reports Psf 1 ...
cfg = {'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW',
       'scale_field': 'Psf', 'scale_base': 1}
res = gplug.fetch_item('', nil, cfg)
check(size(res) == 1 && math.abs(res['currentPower'] - 16070) < 0.01,
      f"gplug sf: Psf == base must leave 16070 W, got {res['currentPower']}")
# ... and corrects by 10^(sf - base) once it switches (here Psf 0)
tasmota.set_sensors('{"SMA":{"P_AC":1.607,"Psf":0,"E_AC":30451.047,"Esf":1}}')
res = gplug.fetch_item('', nil, cfg)
check(math.abs(res['currentPower'] - 160.7) < 0.001,
      f"gplug sf: Psf 0 vs base 1 must give 160.7 W, got {res['currentPower']}")
print("Test 6f passed: gplug scale_field with scale_base")

# raw register (scale_base defaults to 0): value * 10^sf, before the kW step
tasmota.set_sensors('{"SMA":{"P_AC":1607,"Psf":1,"W":-5,"Wsf":-1,"Xsf":"1","Ysf":null,"Zsf":99}}')
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'scale_field': 'Psf'})
check(math.abs(res['currentPower'] - 16070) < 0.01,
      f"gplug sf: raw 1607 * 10^1 expected 16070, got {res['currentPower']}")
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'W', 'scale_field': 'Wsf'})
check(math.abs(res['currentPower'] + 0.5) < 0.0001,
      f"gplug sf: negative sf -5 * 10^-1 expected -0.5, got {res['currentPower']}")
# no scale_field -> no implicit derivation, value unscaled
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC'})
check(res['currentPower'] == 1607, f"gplug sf: no scale_field must not scale, got {res['currentPower']}")
print("Test 6g passed: gplug raw register scaling, opt-in only")

# guard: missing / string / null / out-of-range sf -> unscaled, no throw
for sff: ['Nosf', 'Xsf', 'Ysf', 'Zsf', '']
    res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'scale_field': sff})
    check(res != nil && res['currentPower'] == 1607,
          f"gplug sf: invalid scale field '{sff}' must leave the value unscaled")
end
# a non-numeric scale_base counts as 0
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'scale_field': 'Psf', 'scale_base': 'x'})
check(math.abs(res['currentPower'] - 16070) < 0.01, "gplug sf: bad scale_base must count as 0")
# missing value + scale_field: still an empty result
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'nope', 'scale_field': 'Psf'})
check(res != nil && size(res) == 0, "gplug sf: missing value must yield an empty result")
print("Test 6h passed: gplug invalid scale factors do not throw")

# issue #13: max_power cap. Night-time SMA sentinel 0x8000 pre-scaled by the
# script's /100 -> P_AC 327.68 kW; with max_power it reads as missing.
tasmota.set_sensors('{"SMA":{"P_AC":327.68,"Psf":1}}')
item = {'id': 'pv-sma', 'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW',
        'scale_field': 'Psf', 'scale_base': 1, 'max_power': 20000, 'currentPower': 1200}
res = gplug.fetch_item('', nil, item)
check(res != nil && size(res) == 0, f"gplug cap: 327.68 kW must be rejected, got {res}")
merge(item, res)
check(item['currentPower'] == 1200, "gplug cap: rejected read must keep the cached power")
# repeated rejection: still empty, no throw
res = gplug.fetch_item('', nil, item)
check(size(res) == 0, "gplug cap: repeated rejection stays empty")
print("Test 6i passed: gplug max_power rejects the pre-scaled sentinel")

# plausible value passes; the cap is in W after the kW step; |p| checked
tasmota.set_sensors('{"SMA":{"P_AC":16.07,"Psf":1},"z":{"Pi":-25.5}}')
res = gplug.fetch_item('', nil, item)
check(math.abs(res['currentPower'] - 16070) < 0.01, "gplug cap: 16070 W under 20000 W must pass")
res = gplug.fetch_item('', nil, {'field': 'Pi', 'dimension': 'kW', 'max_power': 20000})
check(size(res) == 0, "gplug cap: |-25500| W must be rejected")
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW', 'max_power': 16070})
check(math.abs(res['currentPower'] - 16070) < 0.01, "gplug cap: value == max_power must pass")
# no / zero / non-numeric cap -> no check (as before issue #13)
for c: [nil, 0, 'x', -5]
    var cf = {'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW'}
    if c != nil cf['max_power'] = c end
    res = gplug.fetch_item('', nil, cf)
    check(math.abs(res['currentPower'] - 16070) < 0.01, f"gplug cap: max_power {c} must not filter")
end
print("Test 6j passed: gplug max_power passes plausible values, opt-in only")

# issue #15: stale detection, opt-in via "stale_after" (s). Clock set past
# MIN_EPOCH; below it nothing is judged.
var T0 = 1790000000
var pv = {'id': 'pv-st', 'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW',
          'energy_field': 'E_AC', 'stale_after': 600}
tasmota.set_utc(T0)
tasmota.set_sensors('{"SMA":{"P_AC":11.9,"E_AC":30492.710}}')
res = gplug.fetch_item('', nil, pv)
check(math.abs(res['currentPower'] - 11900) < 0.01 && res['stale'] == false && res['lastUpdate'] == T0,
      f"gplug stale: first read must be fresh, got {res}")
# energy counter rises, power steady -> still fresh (no false alarm)
tasmota.set_utc(T0 + 300)
tasmota.set_sensors('{"SMA":{"P_AC":11.9,"E_AC":30493.700}}')
res = gplug.fetch_item('', nil, pv)
check(res['stale'] == false && res['lastUpdate'] == T0 + 300, "gplug stale: rising counter at steady power is fresh")
# sunset: script freezes everything. Within stale_after: last value, not stale
tasmota.set_utc(T0 + 800)
res = gplug.fetch_item('', nil, pv)
check(res['stale'] == false && math.abs(res['currentPower'] - 11900) < 0.01 && res['lastUpdate'] == T0 + 300,
      "gplug stale: frozen counter within stale_after keeps the value")
# past stale_after: power 0, stale, lastUpdate = last fresh observation
tasmota.set_utc(T0 + 901)
res = gplug.fetch_item('', nil, pv)
check(res['currentPower'] == 0 && res['stale'] == true && res['lastUpdate'] == T0 + 300,
      f"gplug stale: frozen counter past stale_after must zero the power, got {res}")
item = {'id': 'pv-st', 'currentPower': 11900}
merge(item, res)
check(item['currentPower'] == 0 && item['stale'] == true, "gplug stale: merged item must read 0 / stale")
print("Test 6k passed: gplug stale via frozen energy counter")

# sunrise: counter moves again -> fresh, value back, stale false
tasmota.set_utc(T0 + 5000)
tasmota.set_sensors('{"SMA":{"P_AC":0.5,"E_AC":30493.710}}')
res = gplug.fetch_item('', nil, pv)
merge(item, res)
check(item['stale'] == false && math.abs(item['currentPower'] - 500) < 0.01 && item['lastUpdate'] == T0 + 5000,
      "gplug stale: moving counter recovers")
# a real 0 never goes stale, however long it stays frozen
tasmota.set_sensors('{"SMA":{"P_AC":0,"E_AC":30493.710}}')
tasmota.set_utc(T0 + 9000)
res = gplug.fetch_item('', nil, pv)
check(res['currentPower'] == 0 && res['stale'] == false, "gplug stale: frozen 0 is fresh")
print("Test 6l passed: gplug stale recovery / zero is fresh")

# no energy_field: fresh when the power value changes
var pw = {'id': 'pv-val', 'sensor': 'SMA', 'field': 'P_AC', 'stale_after': 120}
tasmota.set_sensors('{"SMA":{"P_AC":100}}')
tasmota.set_utc(T0)
check(gplug.fetch_item('', nil, pw)['stale'] == false, "gplug stale(value): first read fresh")
tasmota.set_sensors('{"SMA":{"P_AC":101}}')
tasmota.set_utc(T0 + 100)
check(gplug.fetch_item('', nil, pw)['lastUpdate'] == T0 + 100, "gplug stale(value): changed value is fresh")
tasmota.set_utc(T0 + 221)
res = gplug.fetch_item('', nil, pw)
check(res['stale'] == true && res['currentPower'] == 0, "gplug stale(value): unchanged value past limit is stale")
print("Test 6m passed: gplug stale via unchanged value")

# rejected (max_power) and vanished reads age the item out as well
var pc = {'id': 'pv-cap', 'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW',
          'max_power': 20000, 'stale_after': 600}
tasmota.set_sensors('{"SMA":{"P_AC":5.0}}')
tasmota.set_utc(T0)
gplug.fetch_item('', nil, pc)
tasmota.set_sensors('{"SMA":{"P_AC":327.68}}')
tasmota.set_utc(T0 + 60)
res = gplug.fetch_item('', nil, pc)
check(!res.contains('currentPower') && res['stale'] == false, "gplug stale: rejected read within limit keeps the value")
tasmota.set_utc(T0 + 601)
res = gplug.fetch_item('', nil, pc)
check(res['currentPower'] == 0 && res['stale'] == true, "gplug stale: rejected reads past limit go stale")
tasmota.set_sensors('{"z":{"Pi":1}}')
tasmota.set_utc(T0 + 700)
res = gplug.fetch_item('', nil, pc)
check(res != nil && res['stale'] == true && res['currentPower'] == 0, "gplug stale: vanished sensor object stays stale")
print("Test 6n passed: gplug stale after rejected / vanished reads")

# opt-in: no stale_after -> no stale/lastUpdate keys; pre-NTP clock -> no judgement
tasmota.set_sensors('{"SMA":{"P_AC":5.0}}')
res = gplug.fetch_item('', nil, {'id': 'pv-x', 'sensor': 'SMA', 'field': 'P_AC'})
check(size(res) == 1, "gplug stale: without stale_after only currentPower")
tasmota.set_utc(0)
res = gplug.fetch_item('', nil, {'id': 'pv-ntp', 'sensor': 'SMA', 'field': 'P_AC', 'stale_after': 1})
check(size(res) == 1 && res['currentPower'] == 5, "gplug stale: pre-NTP clock judges nothing")
check(gplug.fetch_item('', nil, {'id': 'pv-ntp2', 'sensor': 'nope', 'field': 'P', 'stale_after': 1}) == nil,
      "gplug stale: pre-NTP + vanished sensor stays nil")
print("Test 6o passed: gplug stale detection is opt-in and NTP-guarded")

# issue #14: energy counter reported in Wh as energyCounter
tasmota.set_sensors('{"SMA":{"P_AC":16.07,"Psf":1,"E_AC":30492.710,"Esf":1,"WH":3049271,"WHsf":1}}')
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW', 'energy_field': 'E_AC'})
check(math.abs(res['energyCounter'] - 30492710) < 1, f"gplug energy: kW implies kWh -> Wh, got {res['energyCounter']}")
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'dimension': 'kW',
                                 'energy_field': 'E_AC', 'energy_dimension': 'Wh'})
check(math.abs(res['energyCounter'] - 30492.710) < 0.001, "gplug energy: explicit Wh overrides the kW default")
# raw SunSpec register with its own scale factor: 3049271 * 10^1 Wh
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'energy_field': 'WH',
                                 'energy_scale_field': 'WHsf'})
check(math.abs(res['energyCounter'] - 30492710) < 1, f"gplug energy: raw * 10^WHsf, got {res['energyCounter']}")
# no energy_field -> no key; unreadable counter -> explicit nil (clears the item)
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC'})
check(!res.contains('energyCounter'), "gplug energy: no energy_field, no energyCounter")
item = {'id': 'pv-e', 'energyCounter': 123}
res = gplug.fetch_item('', nil, {'sensor': 'SMA', 'field': 'P_AC', 'energy_field': 'nope'})
check(res.contains('energyCounter') && res['energyCounter'] == nil, "gplug energy: missing counter reports nil")
merge(item, res)
check(item.find('energyCounter') == nil, "gplug energy: nil must clear the previous reading")
print("Test 6p passed: gplug energyCounter in Wh")

# issue #20: battery SoC via "soc_field", optional SunSpec scale factor
tasmota.set_sensors('{"BAT":{"W":-2500,"ChaState":6400,"ChaState_SF":-2,"Bad":150}}')
cfg = {'sensor': 'BAT', 'field': 'W', 'productionType': 'BATTERY',
       'soc_field': 'ChaState', 'soc_scale_field': 'ChaState_SF'}
res = gplug.fetch_item('', nil, cfg)
check(res['currentPower'] == -2500, f"gplug battery: signed power kept, got {res['currentPower']}")
check(math.abs(res['soc'] - 64) < 0.001, f"gplug soc: 6400 * 10^-2 must give 64, got {res.find('soc')}")
cfg['soc_field'] = 'Bad'
cfg.remove('soc_scale_field')
res = gplug.fetch_item('', nil, cfg)
check(!res.contains('soc'), "gplug soc: a value beyond 100 % must be dropped")
cfg['soc_field'] = 'Missing'
res = gplug.fetch_item('', nil, cfg)
check(!res.contains('soc') && res['currentPower'] == -2500, "gplug soc: missing field reports no soc")
cfg = {'sensor': 'BAT', 'field': 'W', 'max_power': 2000}
res = gplug.fetch_item('', nil, cfg)
check(!res.contains('currentPower'), "gplug max_power must compare the magnitude of a charging battery")
print("Test 6q passed: gplug battery soc_field / scale factor / signed max_power")

# ---------------------------------------------------------------------------
# homeassistant — state string -> currentPower
# ---------------------------------------------------------------------------

_http['status'] = 200
_http['body'] = '{"state":"800","attributes":{"unit":"W"}}'
cfg = {'id': 'pv-1', 'integration': 'homeassistant', 'url': 'http://ha/api/x',
       'token': 'secret', 'power': 5000, 'productionType': 'PHOTOVOLTAIC'}
res = homeassistant.fetch_item(cfg['url'], cfg['token'], cfg)
check(size(res) == 1, f"ha: result must hold ONE field, got {size(res)}")
check(res['currentPower'] == 800, f"ha: currentPower expected 800, got {res['currentPower']}")
check(!res.contains('url'), "ha: url must not be echoed back")
check(!res.contains('productionType'), "ha: productionType must not be echoed back")
check_no_cfg_echo(res, "ha")
print("Test 7 passed: homeassistant returns only currentPower")

# kW scaling
_http['body'] = '{"state":"1.2"}'
res = homeassistant.fetch_item('http://ha/api/x', nil, {'dimension': 'kW'})
check(res['currentPower'] == 1200, f"ha: kW must scale to 1200, got {res['currentPower']}")
print("Test 8 passed: homeassistant kW scaling")

# REGRESSION: response without a state + dimension kW must not raise
_http['body'] = '{"attributes":{}}'
res = homeassistant.fetch_item('http://ha/api/x', nil, {'dimension': 'kW'})
check(res != nil && size(res) == 0, "ha: stateless response must yield an empty result")
print("Test 9 passed: homeassistant stateless response + kW does not throw")

# non-200 -> nil, nothing merged
_http['status'] = 500
_http['body'] = ''
check(homeassistant.fetch_item('http://ha/api/x', nil, {'id': 'pv-1'}) == nil,
      "ha: HTTP 500 must return nil")
print("Test 10 passed: homeassistant HTTP error returns nil")

# issue #20: a non-numeric state is no value — real() would fake 0 W
_http['status'] = 200
_http['body'] = '{"state":"unavailable"}'
res = homeassistant.fetch_item('http://ha/api/x', nil, {'dimension': 'kW'})
check(res != nil && size(res) == 0, f"ha: 'unavailable' must yield an empty result, got {res}")
_http['body'] = '{"state":"-8.589"}'
res = homeassistant.fetch_item('http://ha/api/x', nil, {'dimension': 'kW'})
check(math.abs(res['currentPower'] + 8589) < 0.01, f"ha: signed kW must scale to -8589, got {res.find('currentPower')}")
print("Test 10a passed: homeassistant non-numeric state / signed battery power")

# ---------------------------------------------------------------------------
# shelly — /status -> state
# ---------------------------------------------------------------------------

var shelly_url = {'on': 'http://192.168.0.148/relay/0?turn=on',
                  'off': 'http://192.168.0.148/relay/0?turn=off',
                  'status': 'http://192.168.0.148/relay/0'}
_http['status'] = 200
_http['body'] = '{"ison":true,"has_timer":false}'
cfg = {'id': 'boiler-1', 'integration': 'shelly', 'url': shelly_url,
       'power': 2000, 'priority': 3, 'state': 'INACTIVE'}
res = shelly.fetch_item(shelly_url, nil, cfg)
check(size(res) == 1, f"shelly: result must hold ONE field, got {size(res)}")
check(res['state'] == 'ACTIVE', "shelly: ison true -> ACTIVE")
check(!res.contains('url'), "shelly: url map must not be echoed back")
check_no_cfg_echo(res, "shelly")
print("Test 11 passed: shelly returns only state")

_http['body'] = '{"ison":false}'
res = shelly.fetch_item(shelly_url, nil, cfg)
check(res['state'] == 'INACTIVE', "shelly: ison false -> INACTIVE")

# simulator-backed shelly load reports a state string instead of ison
_http['body'] = '{"state":"WAITING"}'
res = shelly.fetch_item(shelly_url, nil, cfg)
check(res['state'] == 'WAITING', "shelly: state string passes through")
print("Test 12 passed: shelly ison false / simulator state string")

# neither ison nor state -> empty result, item keeps its cached state
_http['body'] = '{"has_timer":false}'
item = {'id': 'boiler-1', 'state': 'ACTIVE', 'power': 2000}
merge(item, shelly.fetch_item(shelly_url, nil, item))
check(item['state'] == 'ACTIVE', "shelly: unknown payload must not clear the state")
check(size(item) == 3, "shelly: unknown payload must not grow the item")
print("Test 13 passed: shelly unknown payload leaves the item untouched")

# url map without a status entry -> nil, and no request is made
_http['calls'] = 0
check(shelly.fetch_item({'on': 'http://x/on'}, nil, cfg) == nil,
      "shelly: url without status must return nil")
check(_http['calls'] == 0, "shelly: url without status must not issue a request")
print("Test 14 passed: shelly without status url makes no request")

# ---------------------------------------------------------------------------
# simulator — response fields win, except the two the config owns
# ---------------------------------------------------------------------------

_http['status'] = 200
_http['body'] = '{"id":"in","name":"Netz","state":"ACTIVE","currentPower":900,"productionType":"PV"}'
cfg = {'id': 'from', 'integration': 'simulator', 'url': 'http://sim/grid/in',
       'productionType': 'PHOTOVOLTAIC', 'power': 3000, 'dimension': 'kW'}
res = simulator.fetch_item(cfg['url'], nil, cfg)
check(!res.contains('id'), "simulator: config id is authoritative, must be skipped")
check(!res.contains('productionType'),
      "simulator: config productionType is authoritative, must be skipped")
check(res['currentPower'] == 900, "simulator: currentPower must come from the response")
check(res['state'] == 'ACTIVE', "simulator: state must come from the response")
check(!res.contains('url'), "simulator: url must not be echoed back")
check(!res.contains('integration'), "simulator: config keys must not be echoed back")
print("Test 15 passed: simulator skips the config-owned fields")

# merged item: config identity survives, live values land
item = {'id': 'from', 'integration': 'simulator', 'url': 'http://sim/grid/in',
        'productionType': 'PHOTOVOLTAIC', 'power': 3000, 'dimension': 'kW'}
merge(item, simulator.fetch_item(item['url'], nil, item))
check(item['id'] == 'from', "simulator merge: config id must survive the response id")
check(item['productionType'] == 'PHOTOVOLTAIC',
      "simulator merge: config productionType must survive the response's 'PV'")
check(item['currentPower'] == 900, "simulator merge: live power must land")
check(item['url'] == 'http://sim/grid/in', "simulator merge: url must survive")
check(item['power'] == 3000, "simulator merge: rated power must survive")
print("Test 16 passed: simulator merge keeps config identity")

# a config WITHOUT id/productionType (the meter sentinel pollable) takes the
# response's own fields verbatim — site caches that map as the /api/meter
# descriptor, so nothing may be filtered out of it
_http['body'] = '{"id":"z","Pi":1200,"Po":0,"U1":231.4}'
res = simulator.fetch_item('http://sim/meter', nil,
                           {'_meter': true, 'integration': 'simulator',
                            'url': 'http://sim/meter', 'token': nil})
check(res['id'] == 'z', "simulator: response id passes through when the config has none")
check(res['Pi'] == 1200, "simulator: descriptor fields pass through")
check(res['U1'] == 231.4, "simulator: descriptor reals pass through")
check(size(res) == 4, f"simulator: descriptor must be verbatim, got {size(res)} keys")
check(!res.contains('_meter'), "simulator: sentinel key must not appear in the descriptor")
check(!res.contains('token'), "simulator: token must not appear in the descriptor")
print("Test 17 passed: simulator meter descriptor passes through verbatim")

# dimension "kW" is deliberately ignored (simulator always serves watts)
_http['body'] = '{"currentPower":900}'
res = simulator.fetch_item('http://sim/x', nil, {'dimension': 'kW'})
check(res['currentPower'] == 900, "simulator: kW tag must not scale")
print("Test 18 passed: simulator ignores the kW tag")

# non-200 -> nil
_http['status'] = 500
check(simulator.fetch_item('http://sim/x', nil, {'id': 'a'}) == nil,
      "simulator: HTTP 500 must return nil")
print("Test 19 passed: simulator HTTP error returns nil")

# ---------------------------------------------------------------------------
# modbustcp — direct Modbus TCP master (Anybus M-Bus->Modbus TCP gateway etc.)
# ---------------------------------------------------------------------------

# default unit(1)/function(3), float32, dimension kW: request bytes, connect
# args and decode all verified against a live gateway (2026-09-22)
_tcp['connect_calls'] = []
_tcp['writes'] = []
_tcp['response'] = _mb_response(1, 3, _float_wire(236.785))
cfg = {'id': 'wug-ug01-kw', 'integration': 'modbustcp', 'url': '192.168.0.102:502',
       'register': 194, 'dimension': 'kW', 'power': 5000}
res = modbustcp.fetch_item(cfg['url'], nil, cfg)
check(size(res) == 1, f"modbustcp: result must hold ONE field, got {size(res)}")
check(math.abs(res['currentPower'] - 236785) < 0.01,
      f"modbustcp: 236.785 kW must scale to 236785 W, got {res['currentPower']}")
check_no_cfg_echo(res, "modbustcp")
check(size(_tcp['connect_calls']) == 1, "modbustcp: must connect exactly once")
check(_tcp['connect_calls'][0]['host'] == '192.168.0.102' && _tcp['connect_calls'][0]['port'] == 502,
      "modbustcp: url must split into host/port")
check(_tcp['writes'][0].tohex() == "000100000006010300C20002",
      f"modbustcp: request frame mismatch, got {_tcp['writes'][0].tohex()}")
print("Test 20 passed: modbustcp float32 read, default unit/function, kW scaling")

# int16 signed / uint16 unsigned, no dimension tag -> raw units
_tcp['response'] = _mb_response(1, 4, _int_wire(-1097, 2))
res = modbustcp.fetch_item('192.168.0.102:502', nil,
    {'register': 330, 'unit': 1, 'function': 4, 'dtype': 'int16'})
check(res['currentPower'] == -1097, f"modbustcp: int16 signed expected -1097, got {res['currentPower']}")
_tcp['response'] = _mb_response(1, 4, _int_wire(96, 2))
res = modbustcp.fetch_item('192.168.0.102:502', nil,
    {'register': 422, 'function': 4, 'dtype': 'uint16'})
check(res['currentPower'] == 96, f"modbustcp: uint16 expected 96, got {res['currentPower']}")
print("Test 21 passed: modbustcp int16/uint16 decode")

# int32 / uint32
_tcp['response'] = _mb_response(1, 3, _int_wire(8785393, 4))
res = modbustcp.fetch_item('192.168.0.102:502', nil, {'register': 6983, 'dtype': 'uint32'})
check(res['currentPower'] == 8785393, f"modbustcp: uint32 expected 8785393, got {res['currentPower']}")
_tcp['response'] = _mb_response(1, 3, _int_wire(-70000, 4))
res = modbustcp.fetch_item('192.168.0.102:502', nil, {'register': 57, 'dtype': 'int32'})
check(res['currentPower'] == -70000, f"modbustcp: int32 expected -70000, got {res['currentPower']}")
print("Test 22 passed: modbustcp int32/uint32 decode")

# swap_words: word-swapped (CDAB) 32-bit value decodes correctly once told to
var normal = _float_wire(236.785)
var swapped_data = normal[2..3] .. normal[0..1]
_tcp['response'] = _mb_response(1, 3, swapped_data)
res = modbustcp.fetch_item('192.168.0.102:502', nil,
    {'register': 194, 'dtype': 'float32', 'swap_words': true})
check(math.abs(res['currentPower'] - 236.785) < 0.001,
      f"modbustcp: swap_words must undo CDAB order, got {res['currentPower']}")
print("Test 23 passed: modbustcp swap_words")

# static "scale" multiplier — for fixed-point registers with no dynamic
# SunSpec-style scale-factor register to read (unlike gplug's scale_field)
_tcp['response'] = _mb_response(1, 4, _int_wire(4192, 2))
res = modbustcp.fetch_item('192.168.0.102:502', nil,
    {'register': 429, 'function': 4, 'dtype': 'uint16', 'scale': 0.01})
check(math.abs(res['currentPower'] - 41.92) < 0.001,
      f"modbustcp: scale 0.01 * 4192 expected 41.92, got {res['currentPower']}")
print("Test 24 passed: modbustcp static scale multiplier")

# missing 'register' -> nil, no connection even attempted
_tcp['connect_calls'] = []
check(modbustcp.fetch_item('192.168.0.102:502', nil, {'id': 'x'}) == nil,
      "modbustcp: missing register must return nil")
check(size(_tcp['connect_calls']) == 0, "modbustcp: missing register must not connect")
print("Test 25 passed: modbustcp missing register makes no request")

# connect failure -> nil, no throw
_tcp['connect_ok'] = false
check(modbustcp.fetch_item('192.168.0.102:502', nil, {'register': 194}) == nil,
      "modbustcp: connect failure must return nil")
_tcp['connect_ok'] = true
print("Test 26 passed: modbustcp connect failure returns nil, does not throw")

# Modbus exception response (function byte's high bit set) -> nil
_tcp['response'] = _mb_exception(1, 3, 2)  # ILLEGAL DATA ADDRESS
check(modbustcp.fetch_item('192.168.0.102:502', nil, {'register': 9999}) == nil,
      "modbustcp: Modbus exception response must return nil")
print("Test 27 passed: modbustcp Modbus exception response returns nil")

# no response at all (dead-air timeout) -> nil, and the bounded wait loop
# actually terminates (tasmota.delay is a no-op stub, so this runs instantly
# instead of hanging for real time)
_tcp['response'] = nil
check(modbustcp.fetch_item('192.168.0.102:502', nil, {'register': 194}) == nil,
      "modbustcp: no response must return nil, not hang")
print("Test 28 passed: modbustcp no response times out to nil")

print(f"\n--- All integration tests passed ({passed} checks) ---")
