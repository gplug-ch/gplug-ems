# Tests for the manual Modbus read/write endpoints (issue #20,
# modbusservice.be): GET /api/modbus/read by free parameters or by a
# configured item id, POST /api/modbus/write (holding registers only), the
# error mapping (400 bad parameters, 404 unknown id, 502 transport error,
# 200 + "exception" when the device answers with one) and the webserver
# wrappers.
#
# Run from the backend/ directory:
#   cd tests/modbus_write && berry -m ../.. test_modbusservice.be

import sys
sys.path().push('..')                  # tests/ — tasmota + webserver stubs
sys.path().push('../../integrations')
import json
import math

var _mb = compile('mbslave.be', 'file')()

import tasmota
tasmota.delay = def(ms) end
import webserver
import modbustcp
var site = compile('../../site.be', 'file')()
site.register_integration('modbustcp', modbustcp)
tasmota.set_wifi(true)
site.load_config()
import modbusservice
modbusservice.set_site(site)
modbusservice.set_modbus(modbustcp)

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

def reset()
    _mb['regs'] = {}
    _mb['exc'] = {}
    _mb['frames'] = []
    _mb['connects'] = 0
    _mb['mute'] = false
end

var r
var body

# --- read ----------------------------------------------------------------------

reset()
_mb['regs'][1001] = 0x3FC0          # float32 1.5
r = modbusservice.read({'url': '10.0.0.9:502', 'register': '1001', 'dtype': 'float32'})
body = json.load(r[1])
check(r[0] == 200 && body['value'] == 1.5, f"free read float32, got {r}")
check(body['raw'][0] == 0x3FC0 && body['raw'][1] == 0, "raw words")
r = modbusservice.read({'url': '10.0.0.9:502', 'register': '1001', 'dtype': 'float32',
                        'swap_words': 'true', 'function': '4', 'unit': '2'})
check(r[0] == 200, "free read with swap/function/unit")
check(_mb['frames'][-1].get(6, 1) == 2 && _mb['frames'][-1].get(7, 1) == 4, "unit + function reach the frame")
print("Test 1 passed: read by free parameters")

reset()
_mb['regs'][200] = 0xFA24
_mb['regs'][201] = 500
_mb['regs'][1100] = 2
r = modbusservice.read({'id': 'bat'})
check(r[0] == 200 && json.load(r[1])['value'] == -1500, f"read by id (power), got {r}")
r = modbusservice.read({'id': 'bat', 'field': 'soc'})
check(r[0] == 200 && json.load(r[1])['value'] == 50, f"read by id (soc, scaled), got {r}")
r = modbusservice.read({'id': 'boiler', 'field': 'write'})
check(r[0] == 200 && json.load(r[1])['value'] == 2, f"read a load's write register, got {r}")
check(_mb['frames'][-1].get(7, 1) == 3, "write register is read as a holding register")
print("Test 2 passed: read by item id and field")

reset()
check(modbusservice.read({'url': 'http://x', 'register': '1'})[0] == 400, "bad url -> 400")
check(modbusservice.read({'url': '10.0.0.9:502', 'register': 'abc'})[0] == 400, "non-numeric register -> 400")
check(modbusservice.read({'url': '10.0.0.9:502', 'register': '70000'})[0] == 400, "register > 65535 -> 400")
check(modbusservice.read({'url': '10.0.0.9:502', 'register': '1', 'dtype': 'foo'})[0] == 400, "bad dtype -> 400")
check(modbusservice.read({'url': '10.0.0.9:502', 'register': '1', 'function': '6'})[0] == 400, "FC 6 read -> 400")
check(modbusservice.read({'id': 'nope'})[0] == 404, "unknown id -> 404")
check(modbusservice.read({'id': 'bat', 'field': 'state'})[0] == 404, "item without that register -> 404")
check(_mb['connects'] == 0, "rejected reads never connect")
_mb['exc'][5] = 2
r = modbusservice.read({'url': '10.0.0.9:502', 'register': '5', 'dtype': 'uint16'})
check(r[0] == 200 && json.load(r[1])['exception'] == 2, f"device exception -> 200 + exception, got {r}")
_mb['mute'] = true
r = modbusservice.read({'url': '10.0.0.9:502', 'register': '5', 'dtype': 'uint16'})
check(r[0] == 502 && json.load(r[1]).contains('error'), f"no reply -> 502, got {r}")
print("Test 3 passed: read errors")

# --- write ---------------------------------------------------------------------

reset()
r = modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1000, 'dtype': 'uint16', 'value': 42}))
check(r[0] == 200 && json.load(r[1])['ok'] == true, f"free write uint16, got {r}")
check(_mb['regs'][1000] == 42, "slave holds the written value")
r = modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': '1000', 'dtype': 'float32',
                                   'swap_words': true, 'value': '1.5'}))
check(r[0] == 200 && _mb['regs'][1000] == 0 && _mb['regs'][1001] == 0x3FC0, "string params, float32 CDAB")
print("Test 4 passed: write by free parameters")

reset()
r = modbusservice.write(json.dump({'id': 'boiler', 'field': 'write', 'value': 2}))
check(r[0] == 200 && _mb['regs'][1100] == 2, f"write a load's write register by id, got {r}")
r = modbusservice.write(json.dump({'id': 'static', 'value': 2.25}))
check(r[0] == 200 && _mb['regs'][1001] == 0x4010, f"write a holding item register by id (FC 16), got {r}")
check(_mb['frames'][-1].get(7, 1) == 16, "float32 goes out as FC 16")
print("Test 5 passed: write by item id")

reset()
check(modbusservice.write(json.dump({'id': 'bat', 'value': 1}))[0] == 400, "input register item -> 400")
check(modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1, 'function': 5, 'value': 1}))[0] == 400,
      "free coil write -> 400")
check(modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1, 'function': 4, 'value': 1}))[0] == 400,
      "FC 4 write -> 400")
check(modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1, 'value': 'abc'}))[0] == 400,
      "non-numeric value -> 400")
check(modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1}))[0] == 400, "missing value -> 400")
check(modbusservice.write('not json')[0] == 400, "invalid json -> 400")
check(modbusservice.write(json.dump({'id': 'nope', 'value': 1}))[0] == 404, "unknown id -> 404")
check(_mb['connects'] == 0, "rejected writes never connect")
_mb['exc'][1000] = 2
r = modbusservice.write(json.dump({'url': '10.0.0.9:502', 'register': 1000, 'dtype': 'uint16', 'value': 1}))
check(r[0] == 200 && json.load(r[1])['exception'] == 2, f"device exception on write, got {r}")
print("Test 6 passed: write errors")

# --- webserver wrappers --------------------------------------------------------

reset()
_mb['regs'][1001] = 0x3FC0
webserver.reset()
webserver.set_args({'id': 'static'})
modbusservice.readrequest()
check(webserver.last_code() == 200 && webserver.last_mime() == 'application/json', "readrequest answers JSON")
check(json.load(webserver.body())['value'] == 1.5, "readrequest body")
webserver.reset()
webserver.set_args({'plain': json.dump({'url': '10.0.0.9:502', 'register': 7, 'dtype': 'uint16', 'value': 9})})
modbusservice.writerequest()
check(webserver.last_code() == 200 && _mb['regs'][7] == 9, "writerequest reads the POST body")
webserver.reset()
modbusservice.writerequest()
check(webserver.last_code() == 400, "writerequest without a body -> 400")
print("Test 7 passed: webserver wrappers")

# --- manual ops vs. the host backoff (panel "connect failed" 502) -----------

import nethost
tasmota.set_utc(1700000000)         # RTC synced: nethost backoff is live
var U = '10.0.0.7:502'
reset()
nethost.fail(U)                     # e.g. a poll of this host just failed
check(nethost.skipping(U), "host is in backoff")
check(modbustcp.fetch_item(U, nil, {'register': 1}) == nil && _mb['connects'] == 0,
      "a poll still honours the backoff")
_mb['regs'][1001] = 0x3FC0
r = modbusservice.read({'url': U, 'register': '1001', 'dtype': 'float32'})
check(r[0] == 200 && json.load(r[1])['value'] == 1.5, f"manual read ignores the backoff, got {r}")
check(!nethost.skipping(U), "a manual success clears the backoff")
r = modbusservice.write(json.dump({'url': U, 'register': 7, 'dtype': 'uint16', 'value': 3}))
check(r[0] == 200, "manual write ignores the backoff")

reset()
_mb['mute'] = true
r = modbusservice.read({'url': U, 'register': '5', 'dtype': 'uint16'})
var body = json.load(r[1])
check(r[0] == 502 && body['reason'] == 'timeout' && body['ms'] == 1500,
      f"silent device -> 502 + reason timeout, got {r}")
check(!nethost.skipping(U), "a manual failure does not put the host in backoff")
r = modbusservice.read({'url': 'nocolon', 'register': '5'})
check(r[0] == 400, "malformed url is a 400 before any connect")
check(modbustcp.read_register('bad', {'register': 5, 'manual': true})['error']
      == "bad url 'bad', expected <ip>:<port>", "bad url names itself")
tasmota.set_utc(0)
print("Test 8 passed: manual ops bypass the host backoff")

print(f"\n--- All modbusservice tests passed ({passed} checks) ---")
