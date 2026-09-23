# Tests for meter.be — Wh integration, slot sealing, gaps, RAM ring.
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_meter.be
#
# meter._ingest is driven directly via meter.ingest(utc, grid, pv, bat, load),
# so no Tasmota clock is needed. site.json fixtures are irrelevant here —
# _read_grid()/_sum_* are bypassed by direct ingestion.

import os

# Stub for the Tasmota built-in webclient class (site.be integrations need it)
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

# Load the functional Tasmota stub (tests/tasmota.be) as a global so meter.be
# resolves the ambient `tasmota` built-in under 'import strict'.
import tasmota

# Import the shadow site (tests/site.be) BEFORE meter so Berry caches it under
# the name 'site'; meter.be's own `import site` then reuses the cached shadow
# instead of loading the real site.be (which pulls in the integrations).
import site

import store
import meter

var PREFIX = 'tst_meter_'

def cleanup()
    for n : os.listdir('.')
        if size(n) > size(PREFIX) && n[0 .. size(PREFIX) - 1] == PREFIX
            try os.remove(n) except .. end
        end
    end
end

cleanup()
store.set_prefix(PREFIX)

# 2026-06-01 00:00 UTC, a quarter-hour boundary
var T0 = 1767225600 + 151 * 86400

# feed one full slot [t0, t0+900) with constant values, then one tick into the
# next slot to trigger the close
def feed_slot(t0, grid_w, pv_w)
    var i = 0
    while i < 90
        meter.ingest(t0 + i * 10, grid_w, pv_w, nil, 0)
        i += 1
    end
end

# ---------------------------------------------------------------------------
# Test 1: constant 600 W import for 15 min -> 150 Wh import, 0 Wh export
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
feed_slot(T0, 600, nil)
meter.ingest(T0 + 900, 600, nil, nil, 0)
var recs = store.read('15m', 10)
assert(size(recs) == 1, f"expected 1 sealed slot, got {size(recs)}")
assert(recs[0]['ts'] == T0, "slot ts must be the quarter-hour start")
assert(recs[0]['imp_wh'] == 150, f"expected 150 Wh import, got {recs[0]['imp_wh']}")
assert(recs[0]['exp_wh'] == 0, "export must be 0")
assert(recs[0]['pv_wh'] == nil, "pv must be nil (no pv samples)")
assert(recs[0].find('partial') == true, "record with nil pv must be partial")
print("Test 1 passed: 600 W for 15 min integrates to 150 Wh")

# ---------------------------------------------------------------------------
# Test 2: negative grid power -> export accumulation; pv integration
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
feed_slot(T0, -1200, 2400)
meter.ingest(T0 + 900, -1200, 2400, nil, 0)
recs = store.read('15m', 10)
assert(recs[0]['imp_wh'] == 0 && recs[0]['exp_wh'] == 300,
    f"expected 0/300 Wh, got {recs[0]['imp_wh']}/{recs[0]['exp_wh']}")
assert(recs[0]['pv_wh'] == 600, f"expected 600 Wh pv, got {recs[0]['pv_wh']}")
assert(!recs[0].contains('partial'), "fully sampled slot must not be partial")
print("Test 2 passed: export and PV integration")

# ---------------------------------------------------------------------------
# Test 3: grid sensor dead all slot, pv alive -> imp/exp nil, partial
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
feed_slot(T0, nil, 1200)
meter.ingest(T0 + 900, nil, 1200, nil, 0)
recs = store.read('15m', 10)
assert(recs[0]['imp_wh'] == nil && recs[0]['exp_wh'] == nil, "grid fields must be nil")
assert(recs[0]['pv_wh'] == 300, f"expected 300 Wh pv, got {recs[0]['pv_wh']}")
assert(recs[0].find('partial') == true, "partial flag missing")
print("Test 3 passed: dead grid sensor yields nil fields, partial flag")

# ---------------------------------------------------------------------------
# Test 4: no samples at all in a slot -> no record (hole, FR-109)
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
feed_slot(T0, 600, nil)
# jump straight over slot T0+900 into slot T0+1800: the open slot is
# discarded by the gap rule, no record for the skipped slot
meter.ingest(T0 + 1800, 600, nil, nil, 0)
feed_slot(T0 + 1810, 600, nil)
recs = store.read('15m', 10)
var k = 0
while k < size(recs)
    assert(recs[k]['ts'] != T0 + 900, "skipped slot must not produce a record")
    k += 1
end
print("Test 4 passed: missing slots stay holes")

# ---------------------------------------------------------------------------
# Test 5: clock jump discards the open accumulator (never a wrong-ts slot)
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
# 30 s of data, then a 2000 s forward jump inside the ring
meter.ingest(T0, 600, nil, nil, 0)
meter.ingest(T0 + 10, 600, nil, nil, 0)
meter.ingest(T0 + 20, 600, nil, nil, 0)
meter.ingest(T0 + 2020, 600, nil, nil, 0)
# now fill the current slot to its end and close it
var t = T0 + 2030
while t < T0 + 2700
    meter.ingest(t, 600, nil, nil, 0)
    t += 10
end
meter.ingest(T0 + 2700, 600, nil, nil, 0)
recs = store.read('15m', 10)
assert(size(recs) == 1, f"expected only the post-jump slot, got {size(recs)}")
assert(recs[0]['ts'] == T0 + 1800, "post-jump slot ts wrong")
print("Test 5 passed: clock jump discards open accumulator")

# ---------------------------------------------------------------------------
# Test 6: RTC not synced (epoch < 1e9): samples recorded, no slot accounting
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
var j = 0
while j < 95
    meter.ingest(1000 + j * 10, 500, nil, nil, 0)
    j += 1
end
assert(size(store.read('15m', 10)) == 0, "unsynced clock must not seal slots")
assert(size(meter.get_samples()) == 90, "RAM ring must cap at 90 samples")
print("Test 6 passed: unsynced RTC defers slots; RAM ring capped at 90")

# ---------------------------------------------------------------------------
# Test 7: sample ring content shape [ts, grid, pv, bat, load]
# ---------------------------------------------------------------------------
meter.reset()
meter.ingest(T0, 250, 1000, -300, 750)
var s = meter.get_samples()
assert(size(s) == 1 && s[0][0] == T0 && s[0][1] == 250 && s[0][2] == 1000
    && s[0][3] == -300 && s[0][4] == 750, "sample tuple shape wrong")
print("Test 7 passed: sample tuple shape")

# ---------------------------------------------------------------------------
# Test 8: delayed samples integrate over MEASURED time, not a fixed 10 s.
# A blocked Berry thread (webclient) stretches the sample cadence; with a
# fixed dt the slot under-counted (here it would have sealed 75 Wh at 20 s
# cadence). First sample of the run has no predecessor -> falls back to 10 s.
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
var u = T0
while u < T0 + 900
    meter.ingest(u, 600, nil, nil, 0)   # 600 W, but only every 20 s
    u += 20
end
meter.ingest(T0 + 900, 600, nil, nil, 0)
recs = store.read('15m', 10)
assert(size(recs) == 1, f"expected 1 sealed slot, got {size(recs)}")
# 10 s (first sample, no predecessor) + 44 * 20 s = 890 s at 600 W -> 148 Wh
assert(recs[0]['imp_wh'] == 148,
    f"expected 148 Wh with measured dt, got {recs[0]['imp_wh']}")
print("Test 8 passed: delayed samples integrate by measured elapsed time")

# ---------------------------------------------------------------------------
# Issue #14: PV slot energy from the inverter's energy counter.
# pv1 reports 2000 W but its counter rises 5 Wh per 10 s (1800 W real); the
# counter wins wherever it is trustworthy, the integral everywhere else.
# ---------------------------------------------------------------------------
var E0 = 30492710.0

# one slot of 90 samples; ctr(i) -> counter reading (or nil) at sample i
def feed_ctr(t0, i0, pv_w, own_w, ctr, cap)
    var i = 0
    while i < 90
        meter.ingest(t0 + i * 10, 0, pv_w, nil, 0, [['pv1', own_w, ctr(i0 + i), cap]])
        i += 1
    end
end
def rising(i) return E0 + i * 5 end
def pv_of(recs, ts)
    for r : recs if r['ts'] == ts return r['pv_wh'] end end
    return nil
end

store.reset()
meter.reset()
feed_ctr(T0, 0, 2000, 2000, rising, nil)
feed_ctr(T0 + 900, 90, 2000, 2000, rising, nil)
meter.ingest(T0 + 1800, 0, 2000, nil, 0, [['pv1', 2000, rising(180), nil]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0) == 500, f"first slot (partial) must use the integral 500, got {pv_of(recs, T0)}")
assert(pv_of(recs, T0 + 900) == 450, f"chained slot must use the counter 450, got {pv_of(recs, T0 + 900)}")
print("Test 9 passed: counter difference replaces the integral after the first slot")

# a second PV production without a counter keeps its integral share
store.reset()
meter.reset()
feed_ctr(T0, 0, 3000, 2000, rising, nil)
feed_ctr(T0 + 900, 90, 3000, 2000, rising, nil)
meter.ingest(T0 + 1800, 0, 3000, nil, 0, [['pv1', 2000, rising(180), nil]])
recs = store.read('15m', 10)
# 750 Wh integral - 500 Wh pv1 share + 450 Wh pv1 counter
assert(pv_of(recs, T0 + 900) == 700, f"mixed slot expected 700, got {pv_of(recs, T0 + 900)}")
print("Test 10 passed: counter and integral productions mix")

# counter reset (goes back) -> integral for that slot; chain resumes after
def reset_mid(i) return i < 135 ? E0 + i * 5 : (i - 135) * 5.0 end
store.reset()
meter.reset()
feed_ctr(T0, 0, 2000, 2000, reset_mid, nil)
feed_ctr(T0 + 900, 90, 2000, 2000, reset_mid, nil)
feed_ctr(T0 + 1800, 180, 2000, 2000, reset_mid, nil)
meter.ingest(T0 + 2700, 0, 2000, nil, 0, [['pv1', 2000, reset_mid(270), nil]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0 + 900) == 500, f"reset slot must fall back to 500, got {pv_of(recs, T0 + 900)}")
assert(pv_of(recs, T0 + 1800) == 450, f"slot after reset must use the counter again, got {pv_of(recs, T0 + 1800)}")
print("Test 11 passed: counter reset falls back to the integral")

# jump beyond max_power over the slot -> integral; within it -> counter
def jump(i) return i < 120 ? E0 + i * 5 : E0 + 1000000 + i * 5 end
store.reset()
meter.reset()
feed_ctr(T0, 0, 2000, 2000, jump, 20000)
feed_ctr(T0 + 900, 90, 2000, 2000, jump, 20000)
feed_ctr(T0 + 1800, 180, 2000, 2000, jump, 20000)
meter.ingest(T0 + 2700, 0, 2000, nil, 0, [['pv1', 2000, jump(270), 20000]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0 + 900) == 500, f"implausible jump must fall back to 500, got {pv_of(recs, T0 + 900)}")
assert(pv_of(recs, T0 + 1800) == 450, f"slot after jump must use the counter, got {pv_of(recs, T0 + 1800)}")
print("Test 12 passed: implausible counter jump falls back to the integral")

# no counter reading in a slot (nil) -> integral; stale-frozen counter -> 0
def none(i) return i >= 90 && i < 180 ? nil : E0 + i * 5 end
store.reset()
meter.reset()
feed_ctr(T0, 0, 2000, 2000, none, nil)
feed_ctr(T0 + 900, 90, 2000, 2000, none, nil)
feed_ctr(T0 + 1800, 180, 2000, 2000, none, nil)
feed_ctr(T0 + 2700, 270, 2000, 2000, none, nil)
meter.ingest(T0 + 3600, 0, 2000, nil, 0, [['pv1', 2000, none(360), nil]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0 + 900) == 500, f"counterless slot must use the integral, got {pv_of(recs, T0 + 900)}")
# the gap breaks the chain: no differencing across it (its energy is already
# in the integral) — the next slot restarts partial, then the counter resumes
assert(pv_of(recs, T0 + 1800) == 500, f"slot after gap must not difference across it, got {pv_of(recs, T0 + 1800)}")
assert(pv_of(recs, T0 + 2700) == 450, f"chain must resume after the gap, got {pv_of(recs, T0 + 2700)}")
def frozen(i) return E0 end
store.reset()
meter.reset()
feed_ctr(T0, 0, 0, 0, frozen, nil)
feed_ctr(T0 + 900, 90, 0, 0, frozen, nil)
meter.ingest(T0 + 1800, 0, 0, nil, 0, [['pv1', 0, E0, nil]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0 + 900) == 0, "frozen counter at night must seal 0 Wh")
print("Test 13 passed: missing / frozen counter readings")

# clock jump -> the slot after it is partial (integral), then counter again
store.reset()
meter.reset()
feed_ctr(T0, 0, 2000, 2000, rising, nil)
feed_ctr(T0 + 900, 90, 2000, 2000, rising, nil)
# 5 min outage: > MAX_GAP_S, the open accumulator of slot T0+1800 is discarded
var j = 0
while j < 60
    meter.ingest(T0 + 2100 + j * 10, 0, 2000, nil, 0, [['pv1', 2000, rising(210 + j), nil]])
    j += 1
end
feed_ctr(T0 + 2700, 270, 2000, 2000, rising, nil)
meter.ingest(T0 + 3600, 0, 2000, nil, 0, [['pv1', 2000, rising(360), nil]])
recs = store.read('15m', 10)
assert(pv_of(recs, T0 + 1800) == 333, f"slot after clock jump must use its integral, got {pv_of(recs, T0 + 1800)}")
assert(pv_of(recs, T0 + 2700) == 450, f"following slot must use the counter, got {pv_of(recs, T0 + 2700)}")
print("Test 14 passed: clock jump makes the slot partial")

# ---------------------------------------------------------------------------
# Test 15: battery (issue #20) — bat_w integrates split by sign into charge /
# discharge Wh; imp/exp/pv are untouched (the battery stays behind the meter)
# and a slot without battery samples carries no battery values.
#   first half:  -2000 W (charging)    -> 250 Wh charge
#   second half: +1200 W (discharging) -> 150 Wh discharge
# ---------------------------------------------------------------------------
store.reset()
meter.reset()
var k15 = 0
while k15 < 90
    meter.ingest(T0 + k15 * 10, 400, 1000, k15 < 45 ? -2000 : 1200, 0)
    k15 += 1
end
meter.ingest(T0 + 900, 0, 0, nil, 0)
recs = store.read('15m', 10)
assert(size(recs) == 1, f"expected 1 sealed slot, got {size(recs)}")
assert(recs[0]['bat_chg_wh'] == 250, f"expected 250 Wh charge, got {recs[0].find('bat_chg_wh')}")
assert(recs[0]['bat_dis_wh'] == 150, f"expected 150 Wh discharge, got {recs[0].find('bat_dis_wh')}")
assert(recs[0]['imp_wh'] == 100 && recs[0]['pv_wh'] == 250, "grid/PV must be unaffected by the battery")
assert(!recs[0].contains('soc'), "the SoC is live only, never recorded")

k15 = 1
while k15 < 90
    meter.ingest(T0 + 900 + k15 * 10, 0, 0, nil, 0)
    k15 += 1
end
meter.ingest(T0 + 1800, 0, 0, 0, 0)
recs = store.read('15m', 10)
assert(size(recs) == 2 && !recs[1].contains('bat_chg_wh') && !recs[1].contains('bat_dis_wh'),
    f"a slot without battery samples must carry no battery values: {recs[1]}")
print("Test 15 passed: battery charge/discharge Wh sealed with the slot")

cleanup()
print("")
print("--- All meter tests passed ---")
