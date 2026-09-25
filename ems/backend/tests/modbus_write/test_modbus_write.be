# Tests for modbustcp beyond the single power read (issue #20):
#   * FC 6 / FC 16 / FC 5 request framing, byte-exact, per dtype and swap_words
#   * write -> read round-trip for every dtype x swap_words, inverse scale/kW
#   * reply checks: exception frame, non-echoing reply, no reply
#   * fetch_item reading power + soc / energy / state over ONE connection
#   * set_state receiving the load map from site._actuate_load (real site.be)
#
# Run from the backend/ directory:
#   cd tests/modbus_write && berry -m ../.. test_modbus_write.be
#
# Own directory because site.load_config() reads "site.json" from the CWD.

import sys
sys.path().push('..')                  # tests/ — the tasmota stub
sys.path().push('../../integrations')
import math

# In-memory Modbus TCP slave behind the tcpclient stub (see mbslave.be)
var _mb = compile('mbslave.be', 'file')()

import tasmota
# no real sleeping; `slept` sums what the read loop asked for (issue #30)
var slept = 0
tasmota.delay = def(ms) slept += ms end
import modbustcp

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

def reset()
    _mb['regs'] = {}
    _mb['coils'] = {}
    _mb['exc'] = {}
    _mb['frames'] = []
    _mb['connects'] = 0
    _mb['mute'] = false
    _mb['bad_echo'] = false
    _mb['refuse'] = false
end

# request frame without its (running) transaction id
def last_frame()
    var f = _mb['frames'][-1]
    return f[2..].tohex()
end

var URL = '10.0.0.9:502'
var res

# --- FC 6 / FC 16 / FC 5 framing ---------------------------------------------

reset()
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'uint16'}, 7)
check(res.find('ok', false), f"FC 6 write must succeed, got {res}")
check(last_frame() == "00000006010603E80007", f"FC 6 frame, got {last_frame()}")
check(res['function'] == 6, "uint16 defaults to FC 6")

reset()
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'int32', 'unit': 3}, -70000)
check(res.find('ok', false), f"FC 16 write must succeed, got {res}")
check(last_frame() == "0000000B031003E8000204FFFEEE90", f"FC 16 int32 ABCD frame, got {last_frame()}")
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'int32', 'swap_words': true}, -70000)
check(last_frame() == "0000000B011003E8000204EE90FFFE", f"FC 16 int32 CDAB frame, got {last_frame()}")
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'float32'}, 1.5)
check(last_frame() == "0000000B011003E80002043FC00000", f"FC 16 float32 frame, got {last_frame()}")
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'float32', 'swap_words': true}, 1.5)
check(last_frame() == "0000000B011003E800020400003FC0", f"FC 16 float32 CDAB frame, got {last_frame()}")
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'uint16', 'function': 16}, 7)
check(last_frame() == "00000009011003E80001020007", f"FC 16 forced on uint16, got {last_frame()}")
print("Test 1 passed: FC 6 / FC 16 framing per dtype and swap_words")

reset()
res = modbustcp.write_register(URL, {'register': 5, 'function': 5}, 1)
check(res.find('ok', false) && _mb['coils'][5] == true, f"FC 5 coil on, got {res}")
check(last_frame() == "0000000601050005FF00", f"FC 5 frame, got {last_frame()}")
res = modbustcp.write_register(URL, {'register': 5, 'function': 5}, 0)
check(_mb['coils'][5] == false, "FC 5 coil off")
print("Test 2 passed: FC 5 coil write")

# --- write -> read round-trip ------------------------------------------------

var cases = [['int16', -1234], ['uint16', 54321], ['int32', -70000],
             ['uint32', 3000000000], ['float32', 236.785]]
for c : cases
    for swap : [false, true]
        reset()
        var spec = {'register': 1000, 'dtype': c[0], 'swap_words': swap}
        res = modbustcp.write_register(URL, spec, c[1])
        check(res.find('ok', false), f"{c[0]} swap={swap}: write failed {res}")
        res = modbustcp.read_register(URL, spec)
        check(math.abs(res['value'] - c[1]) < 0.001,
              f"{c[0]} swap={swap}: read back {res.find('value')} != {c[1]}")
        check(size(res['raw']) == (c[0] == 'int16' || c[0] == 'uint16' ? 1 : 2),
              f"{c[0]}: raw word count")
    end
end
print("Test 3 passed: write/read round-trip for every dtype x swap_words")

reset()
res = modbustcp.write_register(URL, {'register': 7, 'dtype': 'uint16', 'scale': 0.01}, 41.92)
check(_mb['regs'][7] == 4192, f"scale 0.01: register must hold 4192, got {_mb['regs'].find(7)}")
res = modbustcp.read_register(URL, {'register': 7, 'dtype': 'uint16', 'scale': 0.01})
check(math.abs(res['value'] - 41.92) < 0.001, f"scale round-trip, got {res['value']}")
res = modbustcp.write_register(URL, {'register': 8, 'dtype': 'float32', 'dimension': 'kW'}, 2500)
res = modbustcp.read_register(URL, {'register': 8, 'dtype': 'float32'})
check(math.abs(res['value'] - 2.5) < 0.0001, f"kW: register must hold 2.5, got {res['value']}")
res = modbustcp.read_register(URL, {'register': 8, 'dtype': 'float32', 'dimension': 'kW'})
check(math.abs(res['value'] - 2500) < 0.01, f"kW round-trip, got {res['value']}")
print("Test 4 passed: inverse scale and kW on write")

# --- rejected before any connection --------------------------------------------

reset()
res = modbustcp.write_register(URL, {'register': 1, 'dtype': 'uint16'}, 70000)
check(res.contains('error') && _mb['connects'] == 0, f"uint16 out of range, got {res}")
res = modbustcp.write_register(URL, {'register': 1, 'dtype': 'int16'}, -40000)
check(res.contains('error'), "int16 out of range")
res = modbustcp.write_register(URL, {'register': 1, 'dtype': 'int32', 'function': 6}, 1)
check(res.contains('error'), "FC 6 cannot carry a 32-bit value")
res = modbustcp.write_register(URL, {'register': 1, 'function': 3}, 1)
check(res.contains('error'), "FC 3 cannot write")
res = modbustcp.write_register(URL, {'register': 1}, 'x')
check(res.contains('error'), "non-numeric value")
check(_mb['connects'] == 0, "no rejected write may connect")
print("Test 5 passed: invalid writes rejected without a connection")

# --- reply handling ------------------------------------------------------------

reset()
_mb['exc'][1000] = 2
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'uint16'}, 1)
check(res.find('exception', nil) == 2, f"exception frame on write, got {res}")
res = modbustcp.read_register(URL, {'register': 1000, 'dtype': 'uint16'})
check(res.find('exception', nil) == 2, f"exception frame on read, got {res}")
_mb['exc'] = {}
_mb['bad_echo'] = true
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'uint16'}, 1)
check(res.contains('error') && !res.contains('ok'), f"non-echoing reply must fail, got {res}")
_mb['bad_echo'] = false
_mb['mute'] = true
res = modbustcp.write_register(URL, {'register': 1000, 'dtype': 'uint16'}, 1)
check(res.contains('error'), f"no reply must fail, got {res}")
print("Test 6 passed: exception, non-echo and silent replies")

# --- read budget: manual ops wait less, and say why they failed (issue #30) -----
# 1500 / 3000 / 1000 = MANUAL_READ_BUDGET_MS / READ_BUDGET_MS / CONNECT_TIMEOUT_MS

reset()
_mb['mute'] = true
slept = 0
res = modbustcp.read_register(URL, {'register': 5, 'dtype': 'uint16', 'manual': true})
check(res.find('reason', nil) == 'timeout' && res['ms'] == 1500,
      f"silent host on a manual read -> reason timeout, got {res}")
check(res['error'] == f"no response within 1500 ms", f"timeout text, got {res}")
check(slept == 1500, f"manual read waits the manual budget, slept {slept}")
slept = 0
res = modbustcp.write_register(URL, {'register': 5, 'dtype': 'uint16', 'manual': true}, 1)
check(res.find('reason', nil) == 'timeout', f"silent host on a manual write -> reason timeout, got {res}")
check(slept == 1500, f"manual write waits the manual budget, slept {slept}")
slept = 0
check(modbustcp.fetch_item(URL, nil, {'register': 5}) == nil, "silent host on a poll -> nil")
check(slept == 3000, f"the poll keeps the long budget, slept {slept}")

reset()
_mb['refuse'] = true
res = modbustcp.read_register(URL, {'register': 5, 'manual': true})
check(res.find('reason', nil) == 'connect' && res['ms'] == 1000,
      f"refused connect -> reason connect, got {res}")
res = modbustcp.write_register(URL, {'register': 5, 'dtype': 'uint16', 'manual': true}, 1)
check(res.find('reason', nil) == 'connect', f"refused connect on write -> reason connect, got {res}")
res = modbustcp.read_register('bad', {'register': 5, 'manual': true})
check(!res.contains('reason'), f"a bad url is no transport failure, got {res}")
print("Test 6b passed: manual read budget and typed transport errors")

# --- fetch_item: extra registers over one connection -----------------------------

reset()
_mb['regs'][200] = 0xFA24          # int16 -1500
_mb['regs'][201] = 735             # 73.5 % in 0.1 %
var bat = {'integration': 'modbustcp', 'function': 4, 'register': 200, 'dtype': 'int16',
           'soc_register': 201, 'soc_scale': 0.1}
res = modbustcp.fetch_item(URL, nil, bat)
check(res['currentPower'] == -1500, f"battery power, got {res.find('currentPower')}")
check(math.abs(res['soc'] - 73.5) < 0.001, f"battery soc, got {res.find('soc')}")
check(_mb['connects'] == 1 && size(_mb['frames']) == 2, "power + soc: one connect, two requests")
check(_mb['frames'][1].get(7, 1) == 4, "soc register inherits the item's function")
_mb['regs'][201] = 1200             # 120 % -> dropped
res = modbustcp.fetch_item(URL, nil, bat)
check(!res.contains('soc'), "soc outside 0..100 is dropped")
_mb['exc'][201] = 2
res = modbustcp.fetch_item(URL, nil, bat)
check(res != nil && res['currentPower'] == -1500 && !res.contains('soc'),
      "failing soc register drops only its field")
print("Test 7 passed: battery soc register on the same connection")

reset()
_mb['regs'][120] = 1234567 >> 16    # uint32 1234567 in 0.01 kWh
_mb['regs'][121] = 1234567 & 0xFFFF
res = modbustcp.fetch_item(URL, nil, {'register': 106, 'dtype': 'float32',
    'energy_register': 120, 'energy_dimension': 'kWh', 'energy_scale': 0.01})
check(math.abs(res['energyCounter'] - 12345670) < 0.5, f"energy counter Wh, got {res.find('energyCounter')}")
res = modbustcp.fetch_item(URL, nil, {'register': 106, 'dtype': 'float32', 'dimension': 'kW',
    'energy_register': 120})
check(math.abs(res['energyCounter'] - 1234567000) < 0.5, "energy follows dimension kW -> kWh")
print("Test 8 passed: energy register -> energyCounter in Wh")

reset()
var load = {'state_register': 1100, 'state': 'WAITING',
            'write': {'register': 1100, 'on': 2, 'off': 1, 'inactive': 0}}
_mb['regs'][1100] = 2
res = modbustcp.fetch_item(URL, nil, load)
check(res['state'] == 'ACTIVE' && !res.contains('currentPower'), f"on value -> ACTIVE, got {res}")
load['state'] = 'ACTIVE'
_mb['regs'][1100] = 1
check(modbustcp.fetch_item(URL, nil, load)['state'] == 'WAITING', "off while ACTIVE -> WAITING")
_mb['regs'][1100] = 0
check(modbustcp.fetch_item(URL, nil, load)['state'] == 'INACTIVE', "distinct inactive value -> INACTIVE")
var relay = {'state_register': 1200, 'state': 'INACTIVE', 'write': {'register': 1200, 'on': 1, 'off': 0}}
_mb['regs'][1200] = 0
check(!modbustcp.fetch_item(URL, nil, relay).contains('state'), "off while INACTIVE keeps INACTIVE")
relay['state'] = 'WAITING'
check(!modbustcp.fetch_item(URL, nil, relay).contains('state'), "off while WAITING keeps WAITING")
_mb['exc'][1200] = 2
check(modbustcp.fetch_item(URL, nil, relay) == nil, "the only register failing -> nil")
print("Test 9 passed: state register mapping")

# --- set_state ----------------------------------------------------------------

reset()
check(modbustcp.set_state(URL, nil, 'ACTIVE') == false, "set_state without cfg -> false")
check(modbustcp.set_state(URL, nil, 'ACTIVE', {'register': 1}) == false, "no write block -> false")
check(_mb['connects'] == 0, "set_state without a write register must not connect")
print("Test 10 passed: set_state needs the load's write block")

# --- through the real site.be scheduler -----------------------------------------

var site = compile('../../site.be', 'file')()
site.register_integration('modbustcp', modbustcp)
tasmota.set_wifi(true)
reset()
_mb['regs'][1100] = 1
site.load_config()

site.set_load_state('boiler', 'ACTIVE')
check(site.actuate_step(), "actuation must run one job")
check(last_frame() == "000000060106044C0002", f"boiler ACTIVE -> FC 6 reg 1100 = 2, got {last_frame()}")
check(_mb['regs'][1100] == 2, "slave register holds the on value")
site.set_load_state('boiler', 'INACTIVE')
site.actuate_step()
check(_mb['regs'][1100] == 0, "INACTIVE writes the inactive value")
site.set_load_state('boiler', 'WAITING')
site.actuate_step()
check(_mb['regs'][1100] == 1, "WAITING writes the off value")
site.set_load_state('relay', 'ACTIVE')
site.actuate_step()
check(_mb['regs'][1200] == 1, "relay ACTIVE writes 1 (default uint16 FC 6)")
print("Test 11 passed: site actuation hands the load map to modbustcp.set_state")

# poll every item once: battery soc, PV energy counter, signed single grid item
reset()
_mb['regs'][200] = 0xFA24
_mb['regs'][201] = 500
_mb['regs'][300] = 0xFFFF           # int32 -800 (export)
_mb['regs'][301] = 0xFCE0
_mb['regs'][1200] = 1
var n = 0
while n < 5
    _mb['connects'] = 0
    site.poll_step()
    check(_mb['connects'] <= 1, "poll_step: at most one Modbus connect per tick")
    n += 1
end
var prods = {}
for p : site.get_productions_cached() prods[p['id']] = p end
check(prods['bat']['currentPower'] == -1500 && prods['bat']['soc'] == 50, "polled battery power + soc")
check(site.get_grid_cached()[0]['currentPower'] == -800, "single signed grid register (export < 0)")
check(site.get_load_by_id('relay')['state'] == 'ACTIVE', "relay state read back")
print("Test 12 passed: site polling of battery, grid and load registers")

print(f"\n--- All modbus write tests passed ({passed} checks) ---")
