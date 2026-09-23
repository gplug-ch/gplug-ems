# Tests for the GET /api/meter passthrough (spec 007 FR-701/FR-702).
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_meter_api.be
#
# Covers the shared read-and-parse guard gplug.read_z() (valid `z`, missing
# `z`, malformed JSON, empty string, non-string, foreign sensors) and the pure
# {now, values} payload builder webservice.meter_payload — all without a real
# smart meter or webserver: tasmota.set_sensors() drives read_sensors().

import json
import sys
# integrations/ is flattened into one dir in the built .tapp; in the CLI tests
# it is a subdir, so add it to the module path for `import gplug`.
sys.path().push('../integrations')

# Stub the Tasmota built-in webclient class (site.be integrations import it
# at module scope; webservice pulls site in).
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

# Functional tasmota stub as a global (adds set_sensors/rtc/read_sensors).
import tasmota
# Pre-load the CLI stub for the Tasmota built-in `webserver` so it is in the
# import cache before webservice.be (loaded from ..) resolves it — a module
# imported from another directory cannot see this dir's stub otherwise.
import webserver

import gplug
import webservice

# ---------------------------------------------------------------------------
# gplug.read_z() — the shared, guarded read-and-parse path (FR-701)
# ---------------------------------------------------------------------------

# valid sensor JSON with a z object
tasmota.set_sensors('{"Time":"2026-07-28T10:00:00","z":{"Pi":1200,"Po":0,"U1":231.4}}')
var z = gplug.read_z()
assert(z != nil, "valid z must parse")
assert(z['Pi'] == 1200, f"Pi expected 1200, got {z['Pi']}")
assert(z['U1'] == 231.4, "U1 must round-trip")
print("Test 1 passed: valid z parses to the descriptor map")

# foreign Tasmota sensors: JSON present but no z key -> nil (values:null)
tasmota.set_sensors('{"ENERGY":{"Power":42}}')
assert(gplug.read_z() == nil, "missing z key must yield nil")
print("Test 2 passed: foreign sensors (no z) -> nil")

# malformed JSON -> nil, no exception
tasmota.set_sensors('{"z":{ this is not json ')
assert(gplug.read_z() == nil, "malformed JSON must yield nil, not throw")
print("Test 3 passed: malformed JSON -> nil")

# empty string -> nil
tasmota.set_sensors('')
assert(gplug.read_z() == nil, "empty sensor string must yield nil")
print("Test 4 passed: empty string -> nil")

# nil / no sensor data at all -> nil
tasmota.set_sensors(nil)
assert(gplug.read_z() == nil, "nil sensor data must yield nil")
print("Test 5 passed: nil sensor data -> nil")

# ---------------------------------------------------------------------------
# webservice.meter_payload(utc, z) — pure {now, values} builder (NFR-701)
# ---------------------------------------------------------------------------

# null values branch (no meter / foreign sensors)
var p_null = webservice.meter_payload(1767225600, nil)
assert(p_null == '{"now":1767225600,"values":null}', f"null payload wrong: {p_null}")
print("Test 6 passed: null descriptor -> values:null")

# populated branch: parse it back and check the shape survives
var zin = {"Pi": 800, "U1": 230.1, "Meter_id": "LGZ1030655012345"}
var p = webservice.meter_payload(1767225600, zin)
var back = json.load(p)
assert(back['now'] == 1767225600, "now must be echoed")
assert(back['values']['Pi'] == 800, "values.Pi must survive")
assert(back['values']['Meter_id'] == "LGZ1030655012345", "string fields survive")
print("Test 7 passed: descriptor serialized verbatim under values")

print("")
print("--- All /api/meter tests passed ---")
