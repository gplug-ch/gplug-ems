# Tests for store.be — append-only 15-min bucket files (issue #4, spec 011
# step 3b: no roll-ups, no set_vzev, no file is ever rewritten).
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_store.be

import os
import store

var PREFIX = 'tst_st_'

def cleanup()
    for n : os.listdir('.')
        if size(n) > size(PREFIX) && n[0 .. size(PREFIX) - 1] == PREFIX
            try os.remove(n) except .. end
        end
    end
end

cleanup()
store.set_prefix(PREFIX)
store.reset()

# epoch anchors (UTC): 2026-01-01 and 2026-06-01, both on quarter-hour boundaries
var T2026     = 1767225600
var JUN1_2026 = T2026 + 151 * 86400

# ---------------------------------------------------------------------------
# Test 1: 15m bucket-file rotation — pushing across 31 UTC days keeps only the
# newest KEEP_DAYS=30 day buckets (capacity 30*96=2880, spec 011 FR-1120),
# oldest day dropped
# ---------------------------------------------------------------------------
store.reset()
var i = 0
while i < 31 * 96
    store.push_15m(JUN1_2026 + i * 900, 100, 0, 50)
    i += 1
end
var total1 = store.count('15m')
assert(total1 == 2880, f"expected 2880 kept 15m records (30 days), got {total1}")
var recs = store.read('15m', 9999)
assert(size(recs) == 2880, f"expected 2880 records from read(), got {size(recs)}")
assert(recs[0]['ts'] == JUN1_2026 + 96 * 900, "oldest day must have been dropped")
assert(recs[2879]['ts'] == JUN1_2026 + (31 * 96 - 1) * 900, "newest record wrong")
print("Test 1 passed: 15m bucket rotation keeps 30 newest days")

# ---------------------------------------------------------------------------
# Test 2: partial slots (nil fields) are preserved and flagged; a complete
# slot never carries the flag (the streaming cursor reuses ONE map)
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, nil, nil, 120)
store.push_15m(JUN1_2026 + 900, 10, 2, 5)
recs = store.read('15m', 2)
assert(recs[0]['imp_wh'] == nil && recs[0]['pv_wh'] == 120, "nil fields not preserved")
assert(recs[0].find('partial') == true, "partial flag missing")
assert(!recs[1].contains('partial'), "complete slot must not be partial")
print("Test 2 passed: partial (nil) slots preserved and flagged")

# ---------------------------------------------------------------------------
# Test 3: no record carries the vZEV fields any more — the browser archive
# derives them (spec 011 FR-1122); the served shape is ts/imp/exp/pv[+partial]
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, 100, 10, 50)
recs = store.read('15m', 1)
assert(!recs[0].contains('vzev_in_wh') && !recs[0].contains('vzev_out_wh'),
    "records must not carry vZEV fields")
assert(size(recs[0]) == 4, f"expected exactly 4 keys, got {size(recs[0])}")
print("Test 3 passed: records carry no vZEV fields")

# ---------------------------------------------------------------------------
# Test 4: six-field lines written before spec 011 step 3b still parse — their
# vZEV tail is ignored, so an upgraded device keeps serving its old buckets
# ---------------------------------------------------------------------------
store.reset()
var dayno4 = JUN1_2026 / 86400
var f4 = open(PREFIX + '.e15_' + str(dayno4), 'w')
f4.write("0,100,10,50,300,150\n")      # legacy 6-field line
f4.write("900,,20,60\n")               # new 4-field line, nil import
f4.close()
store.load()
assert(store.count('15m') == 2, f"legacy line must be counted, got {store.count('15m')}")
recs = store.read('15m', 9)
assert(recs[0]['imp_wh'] == 100 && recs[0]['exp_wh'] == 10 && recs[0]['pv_wh'] == 50,
    "legacy 6-field line lost its Wh values")
assert(!recs[0].contains('vzev_in_wh'), "legacy vZEV tail must not be served")
assert(recs[1]['imp_wh'] == nil && recs[1].find('partial') == true,
    "4-field line with an empty field must read back as nil/partial")
print("Test 4 passed: legacy 6-field lines parse, tail ignored")

# ---------------------------------------------------------------------------
# Test 5: load() removes the files this build no longer maintains — the
# day/month seal files, stray rewrite temporaries and the pre-bucket ring
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, 100, 10, 50)
open(PREFIX + 'e1d', 'w').close()
open(PREFIX + 'e1mo', 'w').close()
open(PREFIX + 'e1d.tmp', 'w').close()
open(PREFIX + '.e15_' + str(dayno4) + '.tmp', 'w').close()
store.load()
def exists(p)
    try
        var f = open(p, 'r')
        f.close()
        return true
    except ..
        return false
    end
end
assert(!exists(PREFIX + 'e1d'), "/e1d must be removed at load()")
assert(!exists(PREFIX + 'e1mo'), "/e1mo must be removed at load()")
assert(!exists(PREFIX + 'e1d.tmp'), "stray /e1d.tmp must be removed at load()")
assert(!exists(PREFIX + '.e15_' + str(dayno4) + '.tmp'), "stray bucket .tmp must be removed")
assert(store.count('15m') == 1, "the live bucket must survive the cleanup")
print("Test 5 passed: obsolete roll-up/temp files removed at load()")

# ---------------------------------------------------------------------------
# Test 6: only 15m exists — every other resolution is refused
# ---------------------------------------------------------------------------
assert(store.capacity('15m') == 2880, "capacity 15m wrong")
assert(store.capacity('1d') == 0, "capacity 1d must be 0")
assert(store.capacity('1mo') == 0, "capacity 1mo must be 0")
assert(store.count('1d') == -1, "count 1d must be -1")
assert(store.count('1mo') == -1, "count 1mo must be -1")
assert(store.count('bogus') == -1, "invalid res count must be -1")
assert(store.read('1d', 1) == nil, "read 1d must return nil")
assert(store.open_cursor('1d', 0) == nil, "open_cursor 1d must return nil")
assert(store.next_into(nil, {}) == false, "next_into on a nil cursor must be false")
print("Test 6 passed: 1d/1mo are gone, 15m is the only resolution")

# ---------------------------------------------------------------------------
# Test 7: load() round-trip — line counts and records survive a reload
# ---------------------------------------------------------------------------
store.reset()
i = 0
while i < 7
    store.push_15m(JUN1_2026 + i * 900, 100, 10, 50)
    i += 1
end
store.push_15m(JUN1_2026 + 86400, 20, 2, 10)     # a second day bucket
store.load()
assert(store.count('15m') == 8, f"round-trip: expected 8 records, got {store.count('15m')}")
recs = store.read('15m', 999)
assert(size(recs) == 8 && recs[0]['ts'] == JUN1_2026, "round-trip lost records")
assert(recs[7]['ts'] == JUN1_2026 + 86400, "second day bucket lost on reload")
print("Test 7 passed: load() round-trip across two buckets")

# ---------------------------------------------------------------------------
# Test 8: streaming cursor (open_cursor/next_into) matches read()
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, 100, 10, 50)
store.push_15m(JUN1_2026 + 900, 200, 20, 60)
assert(store.count('15m') == 2, f"count 15m: {store.count('15m')}")

var cur = store.open_cursor('15m', 0)
var r0 = {}
assert(store.next_into(cur, r0), "next_into(0) must succeed")
var r1 = {}
assert(store.next_into(cur, r1), "next_into(1) must succeed")
assert(r0['ts'] == JUN1_2026 && r0['imp_wh'] == 100, "next_into(0) wrong")
assert(r1['ts'] == JUN1_2026 + 900 && r1['imp_wh'] == 200, "next_into(1) wrong")
assert(store.next_into(cur, r1) == false, "cursor must be exhausted after 2 records")
store.close_cursor(cur)

# skip must land on the newest record
cur = store.open_cursor('15m', 1)
var r2 = {}
assert(store.next_into(cur, r2) && r2['ts'] == JUN1_2026 + 900, "skip=1 must yield the newest")
store.close_cursor(cur)
print("Test 8 passed: streaming cursor accessors")

# ---------------------------------------------------------------------------
# Test 9: torn trailing line (unterminated append, simulating a crash mid-
# write) is skipped — neither counted nor served
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, 100, 10, 50)
store.push_15m(JUN1_2026 + 900, 200, 20, 60)
var f9 = open(PREFIX + '.e15_' + str(dayno4), 'a')
f9.write('1800,300,30')   # no trailing newline -- a torn append
f9.close()
store.load()
assert(store.count('15m') == 2, f"torn trailing line must not be counted, got {store.count('15m')}")
recs = store.read('15m', 999)
assert(size(recs) == 2 && recs[1]['imp_wh'] == 200, "torn trailing line must not be served")
print("Test 9 passed: torn trailing line ignored on load()")

# ---------------------------------------------------------------------------
# Test 10: battery values (issue #20) — a battery slot writes the SEVEN-field
# line (reserved 7th field empty) and serves bat_chg_wh/bat_dis_wh; a slot
# without them keeps the
# four-field line, and the cursor's reused map drops the battery keys again
# ---------------------------------------------------------------------------
store.reset()
store.push_15m(JUN1_2026, 100, 10, 50, 250, 0)    # charging slot
store.push_15m(JUN1_2026 + 900, 200, 20, 60)      # no battery values
store.push_15m(JUN1_2026 + 1800, 0, 0, 0, nil, 300) # discharge only
var f10 = open(PREFIX + '.e15_' + str(dayno4), 'r')
var lines10 = f10.read()
f10.close()
assert(lines10 == "0,100,10,50,250,0,\n900,200,20,60\n1800,0,0,0,,300,\n",
    f"unexpected bucket content: {lines10}")
store.load()
assert(store.count('15m') == 3, f"7-field lines must be counted, got {store.count('15m')}")
var cur10 = store.open_cursor('15m', 0)
var m10 = {}
assert(store.next_into(cur10, m10), "first record missing")
assert(m10['bat_chg_wh'] == 250 && m10['bat_dis_wh'] == 0,
    f"battery values lost: {m10}")
assert(m10['pv_wh'] == 50 && !m10.contains('partial'), "battery slot must stay complete")
assert(store.next_into(cur10, m10), "second record missing")
assert(!m10.contains('bat_chg_wh') && !m10.contains('bat_dis_wh'),
    f"reused map carried battery keys into a plain record: {m10}")
assert(store.next_into(cur10, m10), "third record missing")
assert(m10['bat_dis_wh'] == 300 && !m10.contains('bat_chg_wh'),
    f"nil battery fields must be absent: {m10}")
store.close_cursor(cur10)
print("Test 10 passed: 7-field battery lines round-trip, 4-field lines unchanged")

cleanup()
print("")
print("--- All store tests passed ---")
