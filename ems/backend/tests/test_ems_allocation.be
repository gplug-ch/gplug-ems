# Tests for EMS._update_load_allocation
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_ems_allocation.be
#
# The test uses tests/site.json which defines three loads:
#   load-a  boiler     3000 W  priority 1
#   load-b  heatpump   2000 W  priority 2
#   load-c  dishwasher 2500 W  priority 3
# All loads have empty url_on/url_off, so no HTTP calls are made.

# Stub for the Tasmota built-in webclient class (not available in Berry CLI).
# Must be assigned at script top level WITHOUT 'var' so it becomes a true
# global visible to ems.be when Berry compiles it with 'import strict'.
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

# Load the functional Tasmota stub (tests/tasmota.be) as a global so ems.be
# resolves the ambient `tasmota` built-in under 'import strict'.
import tasmota

import site
import ems

site.load_config()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def assert_state(id, expected)
    var load = site.get_load_by_id(id)
    assert(load != nil, f"load '{id}' not found")
    var actual = load.find("state", site.STATE_INACTIVE)
    assert(actual == expected,
        f"[FAIL] '{id}': expected '{expected}', got '{actual}'")
end

def reset_all_inactive()
    site.set_load_state('load-a', site.STATE_INACTIVE)
    site.set_load_state('load-b', site.STATE_INACTIVE)
    site.set_load_state('load-c', site.STATE_INACTIVE)
end

# production power is a fetched twin field: mutate the cached map directly
# (the device-side set-power endpoint went with spec 011 step 1)
def set_power(power)
    for p: site.get_productions_cached()
        if p["id"] == 'pv-1'
            p["currentPower"] = power
        end
    end
    ems.update_load_allocation()
end

# ---------------------------------------------------------------------------
# Test 1: inactive loads are never touched by allocation
# ---------------------------------------------------------------------------
set_power(10000)
assert_state('load-a', site.STATE_INACTIVE)
assert_state('load-b', site.STATE_INACTIVE)
assert_state('load-c', site.STATE_INACTIVE)
print("Test 1 passed: inactive loads unaffected by production change")

# ---------------------------------------------------------------------------
# Test 2: ample power — all waiting loads become active
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-a', site.STATE_WAITING)
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(10000)  # 10 kW > 3 + 2 + 2.5 kW total
assert_state('load-a', site.STATE_ACTIVE)
assert_state('load-b', site.STATE_ACTIVE)
assert_state('load-c', site.STATE_ACTIVE)
print("Test 2 passed: all loads active when power is ample")

# ---------------------------------------------------------------------------
# Test 3: power covers only the highest-priority load exactly
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-a', site.STATE_WAITING)
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(3000)   # exactly covers load-a (3000 W), nothing left
assert_state('load-a', site.STATE_ACTIVE)
assert_state('load-b', site.STATE_WAITING)
assert_state('load-c', site.STATE_WAITING)
print("Test 3 passed: only highest-priority load active at exact rated power")

# ---------------------------------------------------------------------------
# Test 4: power covers the two highest-priority loads exactly
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-a', site.STATE_WAITING)
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(5000)   # covers load-a (3000) + load-b (2000), 0 left
assert_state('load-a', site.STATE_ACTIVE)
assert_state('load-b', site.STATE_ACTIVE)
assert_state('load-c', site.STATE_WAITING)
print("Test 4 passed: two loads active at 5 kW, lowest-priority load waiting")

# ---------------------------------------------------------------------------
# Test 5: zero power — all candidates stay waiting
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-a', site.STATE_WAITING)
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(0)
assert_state('load-a', site.STATE_WAITING)
assert_state('load-b', site.STATE_WAITING)
assert_state('load-c', site.STATE_WAITING)
print("Test 5 passed: all loads remain waiting when power is zero")

# ---------------------------------------------------------------------------
# Test 6: priority order respected with a partial candidate set
#   only load-b and load-c are candidates; load-b (p2) is served first
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(2000)   # covers load-b (2000) but not load-c (2500)
assert_state('load-a', site.STATE_INACTIVE)
assert_state('load-b', site.STATE_ACTIVE)
assert_state('load-c', site.STATE_WAITING)
print("Test 6 passed: priority order respected with partial candidate set")

# ---------------------------------------------------------------------------
# Test 7: power between two loads — lower-priority load skipped even if it
#   would fit before a higher-priority one that doesn't
#   load-a (3000 W, p1) does NOT fit; load-b (2000 W, p2) fits but is
#   skipped because greedy allocation stops after the first miss
#   (load-a consumes the remaining slot, leaving 0 for load-b and load-c)
#
#   available = 2500 W
#     load-a: 2500 < 3000 → waiting
#     load-b: 2500 >= 2000 → active, remaining = 500
#     load-c: 500 < 2500 → waiting
# ---------------------------------------------------------------------------
reset_all_inactive()
site.set_load_state('load-a', site.STATE_WAITING)
site.set_load_state('load-b', site.STATE_WAITING)
site.set_load_state('load-c', site.STATE_WAITING)
set_power(2500)
assert_state('load-a', site.STATE_WAITING)   # 2500 < 3000: skipped
assert_state('load-b', site.STATE_ACTIVE)    # 2500 >= 2000: active, 500 left
assert_state('load-c', site.STATE_WAITING)   # 500 < 2500: skipped
print("Test 7 passed: greedy allocation skips load that does not fit, continues to next")

# ---------------------------------------------------------------------------
# Test 8: a battery is only observed (issue #20, «loads before battery»)
#   Discharge never activates a load, and charging does not take surplus
#   away from the loads: available power counts PHOTOVOLTAIC items only.
# ---------------------------------------------------------------------------
var bat = {"id": "bat-1", "productionType": "BATTERY", "currentPower": 5000}
site.get_productions_cached().push(bat)

reset_all_inactive()
site.set_load_state('load-b', site.STATE_WAITING)
set_power(0)                  # PV 0 W, battery discharging 5000 W
assert_state('load-b', site.STATE_WAITING)
print("Test 8a passed: a discharging battery activates no load")

bat["currentPower"] = -3000   # battery charging from the PV surplus
set_power(2000)
assert_state('load-b', site.STATE_ACTIVE)
print("Test 8b passed: battery charging power does not reduce available")

site.get_productions_cached().pop()

print("")
print("--- All EMS allocation tests passed ---")
