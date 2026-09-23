# Tests for webservice's batched item streaming (issue #1, point 4) — the
# path GET /loads and GET /productions take. Run from the backend/ directory:
#   cd tests && berry -m .. test_webservice_stream.be
#
# json.dump of a whole list builds ONE transient string sized by the site
# config, and the UI polls both lists every 2 s per connected browser.
# _stream_items sends the array in ~1 KB batches instead. The byte stream the
# client sees must stay IDENTICAL to json.dump(list) whatever the batch
# boundaries — a split in the wrong place would emit invalid JSON.

import json
import sys
sys.path().push('../integrations')

# Stub the Tasmota built-in webclient (site/integrations import it at scope).
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

import tasmota
# preload the CLI stubs so webservice.be (loaded from ..) resolves them
import webserver
import webservice

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

def stream(items)
    webserver.reset()
    webservice.stream_items(items)
    return webserver.body()
end

# --- empty list -------------------------------------------------------------
var body = stream([])
check(body == '[]', f"empty list must stream as [], got '{body}'")
check(webserver.last_code() == 200, "empty list must still send HTTP 200")
check(webserver.last_mime() == 'application/json', "mime must be application/json")
print("Test 1 passed: empty list streams as []")

# --- single item ------------------------------------------------------------
var one = [{'id': 'boiler-1', 'state': 'ACTIVE', 'power': 2000}]
body = stream(one)
check(body == json.dump(one), f"single item must match json.dump, got '{body}'")
print("Test 2 passed: single item matches json.dump")

# --- a realistic load list (under one batch) --------------------------------
var loads = [
    {'id': 'boiler-1', 'name': 'Boiler', 'integration': 'shelly', 'power': 2000,
     'priority': 1, 'state': 'ACTIVE', 'currentPower': 1980},
    {'id': 'wallbox-1', 'name': 'Wallbox', 'integration': 'simulator',
     'power': 11000, 'priority': 2, 'state': 'WAITING', 'currentPower': 0},
    {'id': 'hp-1', 'name': 'Waermepumpe', 'integration': 'gplug', 'power': 3000,
     'priority': 3, 'state': 'INACTIVE', 'currentPower': 0}
]
body = stream(loads)
check(body == json.dump(loads), "load list must match json.dump")
var parsed = json.load(body)
check(size(parsed) == 3, "streamed list must parse back to 3 items")
check(parsed[1]['id'] == 'wallbox-1', "item order must be preserved")
print("Test 3 passed: 3-load list matches json.dump and round-trips")

# --- past the 1 KB batch boundary -------------------------------------------
# 40 items force several content_send() calls; the concatenated body must
# still be exactly the array json.dump would have produced.
var many = []
var i = 0
while i < 40
    many.push({'id': f"load-{i}", 'name': f"Verbraucher Nummer {i}",
               'integration': 'simulator', 'power': 1000 + i, 'priority': i,
               'state': 'WAITING', 'currentPower': 0,
               'url': f"http://192.168.1.50:9090/simulator/sites/s1/loads/load-{i}"})
    i += 1
end
body = stream(many)
check(size(body) > 4096, f"test needs a multi-batch body, got {size(body)} bytes")
check(body == json.dump(many), "multi-batch stream must match json.dump byte for byte")
parsed = json.load(body)
check(parsed != nil, "multi-batch stream must be valid JSON")
check(size(parsed) == 40, f"multi-batch stream must parse back to 40 items, got {size(parsed)}")
check(parsed[0]['id'] == 'load-0' && parsed[39]['id'] == 'load-39',
      "first and last item must survive the batching")
print("Test 4 passed: 40-item list streams in batches, identical to json.dump")

# --- nested structures (shelly url map) survive the batching ----------------
var nested = [{'id': 'boiler-1', 'power': 2000,
               'url': {'on': 'http://192.168.0.148/relay/0?turn=on',
                       'off': 'http://192.168.0.148/relay/0?turn=off',
                       'status': 'http://192.168.0.148/relay/0'}}]
body = stream(nested)
check(body == json.dump(nested), "nested url map must match json.dump")
parsed = json.load(body)
check(parsed[0]['url']['status'] == 'http://192.168.0.148/relay/0',
      "nested url map must round-trip")
print("Test 5 passed: nested url map survives streaming")

print(f"\n--- All webservice stream tests passed ({passed} checks) ---")
