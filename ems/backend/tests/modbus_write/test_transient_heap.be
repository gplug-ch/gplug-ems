# Heap tests for issue #27: a manual Modbus read (GET /api/modbus/read) and a
# config save (POST /api/config) must leave nothing resident.
#   * main.be's stubs compile modbusservice / configservice per request via
#     fsx.load_transient() instead of `import` — the import cache never
#     evicts, so a lazy import only deferred the heap cost
#   * modbusservice resolves modbustcp without importing it when no item
#     registered it at boot
#   * site.load_config() keeps one copy of each grid / modbusRegisters item,
#     not the parsed config list as well
#
# Run from the backend/ directory:
#   cd tests/modbus_write && berry -m ../.. test_transient_heap.be

import sys
sys.path().push('..')                  # tests/ — tasmota + webserver stubs
sys.path().push('../../integrations')
import gc
import json

var _mb = compile('mbslave.be', 'file')()

import tasmota
tasmota.delay = def(ms) end
import webserver
import fsx
var site = compile('../../site.be', 'file')()
tasmota.set_wifi(true)
site.load_config()
# deliberately NO site.register_integration('modbustcp', ...) and no
# `import modbustcp`: the manual read must bring its own transient copy

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

def heap()
    gc.collect()
    return gc.allocated()
end

# one manual read the way main.be's stub runs it: compile, call, drop
def manual_read()
    var m = fsx.load_transient('modbusservice')
    m.set_site(site)
    var r = m.read({'url': '10.0.0.9:502', 'register': '1001', 'dtype': 'float32'})
    _mb['frames'] = []              # the test slave logs every frame; not ours
    return r
end

# --- transient modules are fresh objects, not the import cache -------------

var a = fsx.load_transient('configservice')
a.set_file('elsewhere.json')
var b = fsx.load_transient('configservice')
check(b.get_file() == 'site.json', "each load_transient() is a fresh module")
a = nil
b = nil
var failed = false
try fsx.load_transient('no_such_module') except 'import_error' failed = true end
check(failed, "unknown module raises import_error")
print("Test 1 passed: fresh module per call")

# --- manual read: no resident growth ---------------------------------------

_mb['regs'][1001] = 0x3FC0          # float32 1.5
var r = manual_read()
check(r[0] == 200 && json.load(r[1])['value'] == 1.5, f"transient read works, got {r}")
manual_read()                       # warm-up: resident deps (logger, nethost, ...)
var h0 = heap()
for i : 1 .. 30 manual_read() end
var h1 = heap()
for i : 1 .. 30 manual_read() end
var h2 = heap()
# the imported modules would add many KB; a transient read may leave only
# a few interned strings behind, and must not grow with the read count
check(h1 - h0 < 1024, f"30 reads leave < 1 KB resident, got {h1 - h0} B")
check(h2 - h1 < 256, f"30 more reads do not grow the heap, got {h2 - h1} B")
print(f"Test 2 passed: manual read heap {h0} -> {h1} -> {h2}")

# --- config save: no resident growth ---------------------------------------

var f = open('site.json', 'r')
var ORIG = f.read()
f.close()

def restore()
    var w = open('site.json', 'w')
    w.write(ORIG)
    w.close()
    site.load_config()
end

def save(body)
    var m = fsx.load_transient('configservice')
    m.set_site(site)
    return m.save(body)
end

# a doc with `n` extra standalone Modbus registers
def doc_with(n)
    var d = json.load(ORIG)
    for i : 1 .. n
        d['modbusRegisters'].push({'id': f"sub{i}", 'friendlyName': f"Submeter {i}",
            'integration': 'modbustcp', 'url': '10.0.0.9:502', 'unit': 1,
            'register': 3000 + i, 'dtype': 'float32', 'unitLabel': 'kWh'})
    end
    return json.dump(d)
end

try
    check(save(ORIG)[0] == 200, "transient save works")
    save(ORIG)                      # warm-up
    var s0 = heap()
    for i : 1 .. 20 save(ORIG) end
    var s1 = heap()
    check(s1 - s0 < 512, f"20 saves leave < 0.5 KB resident, got {s1 - s0} B")
    print(f"Test 3 passed: config save heap {s0} -> {s1}")

    # --- one copy per Modbus item, not two ---------------------------------
    var N = 20
    var body = doc_with(N)
    # heap cost of ONE copy of the N added item maps
    var parsed = json.load(body)['modbusRegisters']
    var c0 = heap()
    var copies = []
    for cfg : parsed
        if cfg['id'][0 .. 2] != 'sub' continue end
        var item = {}
        for k : cfg.keys() item[k] = cfg[k] end
        copies.push(item)
    end
    var one = heap() - c0
    copies = nil
    parsed = nil

    var p0 = heap()
    check(save(body)[0] == 200, "save with extra registers")
    var p1 = heap()
    check(size(site.get_modbus_cached()) >= N, "extra registers loaded")
    check(p1 - p0 < one * 3 / 2,
          f"{N} registers cost about one copy ({one} B), got {p1 - p0} B")
    print(f"Test 4 passed: {N} registers +{p1 - p0} B (one copy {one} B)")
    restore()
except .. as e, m
    restore()
    raise e, m
end

print(f"\n--- All transient heap tests passed ({passed} checks) ---")
