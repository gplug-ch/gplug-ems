# Tests for the two record streams GET /api/energy and GET /api/power.
# Run from the backend/ directory:
#   cd tests && berry -m .. test_webservice_energy.be
#
# Both build their response through the reused `bytes` buffer flushed at ~1 KB
# (_new_buf/_put/_flush in webservice.be). Berry strings are IMMUTABLE, so the
# former `buf += piece` loop reallocated the whole batch on every record —
# ~71 KB allocated to serve one 96-record /api/energy. The regression these
# tests guard: a response long enough to cross several flush boundaries must
# still parse as ONE valid JSON document with every record in ring order.

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
import webserver
import store
import meter
import webservice

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

# --- GET /api/energy over several flush boundaries --------------------------
store.set_prefix('/tmp/ws_energy_test_')
store.reset()

var n = 96
var i = 0
while i < n
    # ts on exact 15-min boundaries, distinct values per record so ordering
    # and off-by-one at a flush boundary are both visible
    store.push_15m(900 * (i + 1), 1000 + i, 2000 + i, 3000 + i)
    i += 1
end

webserver.reset()
webserver.set_args({'res': '15m', 'count': str(n)})
webservice.energy_request()

var body = webserver.body()
check(webserver.last_code() == 200, "energy must answer 200")
check(webserver.last_mime() == 'application/json', "energy mime must be application/json")
check(size(body) > 2048, f"test needs a multi-batch body, got {size(body)} bytes")

var recs = json.load(body)
check(recs != nil, "multi-batch energy body must be valid JSON")
check(size(recs) == n, f"energy must return {n} records, got {size(recs)}")
check(recs[0]['ts'] == 900, "first record survives batching")
check(recs[n - 1]['ts'] == 900 * n, "last record survives batching")
var ordered = true
var k = 1
while k < n
    if recs[k]['ts'] <= recs[k - 1]['ts']
        ordered = false
    end
    k += 1
end
check(ordered, "records stay in ascending ts order across flushes")
print("Test 1 passed: 96-record /api/energy streams as one valid JSON array")

# --- count clamping still holds with the buffered writer --------------------
webserver.reset()
webserver.set_args({'res': '15m', 'count': '10'})
webservice.energy_request()
recs = json.load(webserver.body())
check(size(recs) == 10, f"count=10 must return the newest 10 records, got {size(recs)}")
check(recs[9]['ts'] == 900 * n, "count window must end at the newest record")
print("Test 2 passed: count window unaffected by the buffered writer")

# --- `from` pages FORWARD (spec 011 FR-1103) --------------------------------
# The browser archive syncs incrementally: it asks for everything newer than
# its last archived slot in <= 384-record pages. Without `from` the endpoint
# still returns the NEWEST `count` records (unchanged behaviour).
webserver.reset()
webserver.set_args({'res': '15m', 'count': '10', 'from': str(900 * 51)})
webservice.energy_request()
recs = json.load(webserver.body())
check(size(recs) == 10, f"from+count must page 10 records, got {size(recs)}")
check(recs[0]['ts'] == 900 * 51, f"page must START at `from`, got {recs[0]['ts']}")
check(recs[9]['ts'] == 900 * 60, "page must be the 10 OLDEST records at/after `from`")

# the next page resumes after the last record of the previous one
webserver.reset()
webserver.set_args({'res': '15m', 'count': '10', 'from': str(900 * 61)})
webservice.energy_request()
recs = json.load(webserver.body())
check(recs[0]['ts'] == 900 * 61, "second page starts where the first ended")

# a `from` beyond the newest record yields an empty page -> sync stops
webserver.reset()
webserver.set_args({'res': '15m', 'count': '10', 'from': str(900 * (n + 5))})
webservice.energy_request()
check(webserver.body() == '[]', f"from past the buffer must be [], got '{webserver.body()}'")

# `to` still clamps the upper end
webserver.reset()
webserver.set_args({'res': '15m', 'count': '96', 'from': str(900 * 51), 'to': str(900 * 55)})
webservice.energy_request()
recs = json.load(webserver.body())
check(size(recs) == 5, f"from+to window must return 5 records, got {size(recs)}")
print("Test 3 passed: `from` pages forward in `count`-sized pages")

# --- empty ring streams as [] ----------------------------------------------
store.reset()
webserver.reset()
webserver.set_args({'res': '15m'})
webservice.energy_request()
check(webserver.body() == '[]', f"empty ring must stream as [], got '{webserver.body()}'")
print("Test 4 passed: empty ring streams as []")

# --- spec 011 FR-1122: 15m is the only resolution the device serves ---------
store.reset()
i = 0
while i < 4
    store.push_15m(900 * i, 100 + i, 10, 50)
    i += 1
end
for bad : ['1d', '1mo', 'bogus']
    webserver.reset()
    webserver.set_args({'res': bad})
    webservice.energy_request()
    check(webserver.last_code() == 400, f"res={bad} must be refused with 400")
    check(webserver.body() == '{"error":"invalid res"}',
          f"res={bad} error body wrong: '{webserver.body()}'")
end

# the record shape carries no vZEV fields any more (the browser derives them)
webserver.reset()
webserver.set_args({'res': '15m', 'count': '4'})
webservice.energy_request()
recs = json.load(webserver.body())
check(size(recs) == 4, f"expected 4 records, got {size(recs)}")
check(!recs[0].contains('vzev_in_wh') && !recs[0].contains('vzev_out_wh'),
      "served record must not carry the vZEV fields")
check(recs[0].contains('ts') && recs[0].contains('imp_wh') &&
      recs[0].contains('exp_wh') && recs[0].contains('pv_wh'),
      "served record lost a raw field")
print("Test 4b passed: res=1d/1mo -> 400, records carry no vZEV fields")

# --- GET /api/power over several flush boundaries ---------------------------
# meter.ingest() appends one sample per call; enough of them force multiple
# flushes inside the '{"now":..,"samples":[..]}' envelope.
meter.reset()
i = 0
while i < 400
    meter.ingest(1700000000 + 10 * i, -500 + i, 1200 + i, 0, 700 + i)
    i += 1
end
var samples = meter.sample_count()
check(samples > 0, "meter stub must produce samples for the power stream")

webserver.reset()
webserver.set_args({})
webservice.power_request()
body = webserver.body()
check(size(body) > 2048, f"test needs a multi-batch power body, got {size(body)} bytes")
var doc = json.load(body)
check(doc != nil, "multi-batch power body must be valid JSON")
check(doc.contains('now') && doc.contains('samples'), "power envelope shape")
check(size(doc['samples']) == samples,
      f"power must return {samples} samples, got {size(doc['samples'])}")
print("Test 5 passed: /api/power streams the whole sample ring as valid JSON")

print(f"\n--- All webservice energy/power stream tests passed ({passed} checks) ---")
