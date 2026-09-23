# Tests for standalone Modbus register monitoring in the real site.be poll
# scheduler ("modbusRegisters" in site.json — registers that don't fit
# loads/productions/grid, e.g. a submeter behind a Modbus TCP gateway):
#   * each configured register gets its own round-robin pollable, one TCP
#     connect per tick, live value merged into the item as "currentPower"
#   * GET /api/modbus (webservice) would just stream site.get_modbus_cached()
#     verbatim — that part is plain data, covered here via the getter itself
#
# Run from the backend/ directory:
#   cd tests/modbus && berry -m ../.. test_modbus_site.be
#
# Own directory because site.load_config() reads "site.json" from the CWD.

import sys
sys.path().push('..')                  # tests/ — the tasmota stub
sys.path().push('../../integrations')

# Canned Modbus TCP responses keyed by register address (parsed out of the
# request bytes at offset 8, big-endian — see modbustcp._build_request).
var _tcp = {'pending': nil, 'connect_calls': 0, 'by_register': {}}

class _TcpClientStub
    def connect(host, port, timeout_ms)
        _tcp['connect_calls'] = _tcp['connect_calls'] + 1
        return true
    end
    def connected() return true end
    def close() end
    def write(content)
        _tcp['pending'] = content.get(8, -2)
        return content.size()
    end
    def readbytes()
        var r = _tcp['by_register'].find(_tcp['pending'], nil)
        _tcp['pending'] = nil
        return r
    end
end
tcpclient = _TcpClientStub

def _mb_response(unit, func, data)
    var r = bytes()
    r.add(1, -2)
    r.add(0, -2)
    r.add(3 + data.size(), -2)
    r.add(unit, 1)
    r.add(func, 1)
    r.add(data.size(), 1)
    return r .. data
end

# register 194: float32, ~236.785 (le -> reverse-add trick, see modbustcp)
var f32 = bytes()
f32.resize(4)
f32.setfloat(0, 236.785)
var w194 = bytes()
w194.add(f32.get(0, 4), -4)
_tcp['by_register'][194] = _mb_response(1, 3, w194)

# register 330: int16 signed, -1097
var w330 = bytes()
w330.add(-1097, -2)
_tcp['by_register'][330] = _mb_response(1, 4, w330)

import tasmota
tasmota.delay = def(ms) end
# tests/site.be is a stub that shadows the real module on the CLI module path,
# so compile the real one by path (the file returns its module object).
var site = compile('../../site.be', 'file')()
import modbustcp
site.register_integration('modbustcp', modbustcp)

var passed = 0
def check(cond, msg)
    assert(cond, msg)
    passed += 1
end

def by_id(id)
    for m : site.get_modbus_cached()
        if m['id'] == id return m end
    end
    return nil
end

tasmota.set_wifi(true)
site.load_config()
check(size(site.get_modbus_cached()) == 2, "two configured registers must both be pollable items")

# round-robin: one connect per tick, covers both registers
var i = 0
while i < 2
    _tcp['connect_calls'] = 0
    site.poll_step()
    check(_tcp['connect_calls'] <= 1, "poll_step must fire at most one Modbus connect")
    i += 1
end

var heat = by_id('heat-ug01')
var batt = by_id('batt-power')
check(heat != nil && batt != nil, "both configured ids must be present after polling")
var v = heat.find('currentPower', nil)
check(v != nil && (v - 236.785 < 0.001) && (v - 236.785 > -0.001),
      f"heat-ug01: expected ~236.785, got {v}")
check(batt['currentPower'] == -1097, f"batt-power: expected -1097, got {batt.find('currentPower')}")
print("Test 1 passed: each modbusRegisters entry polls independently, one connect per tick")

# config fields (friendlyName/register/unit/...) survive the merge untouched
check(heat['friendlyName'] == 'Waermemessung UG01', "friendlyName must survive the poll merge")
check(heat['register'] == 194, "register must survive the poll merge")
print("Test 2 passed: static config fields are not clobbered by the live merge")

# the entries are NOT loads/productions/grid — they must not leak in there
check(size(site.get_loads_cached()) == 0, "modbus registers must not appear as loads")
check(size(site.get_productions_cached()) == 0, "modbus registers must not appear as productions")
check(size(site.get_grid_cached()) == 0, "modbus registers must not appear as grid")
print("Test 3 passed: modbus registers stay in their own list")

print(f"\n--- All modbus site tests passed ({passed} checks) ---")
