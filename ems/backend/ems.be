var ems = module()
import strict
import logger
import site
import drivershim

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

# Digital-twin refresh (loads/productions/grid) and relay writes are driven
# entirely by site's outbound-HTTP scheduler: every_second() advances it by
# exactly one op (site.scheduler_step()). Polling is deliberately kept OFF
# the allocation math and OUT of the request handlers — a slow integration
# must never block the 2 s UI poll or allocation, and capping outbound HTTP
# to one op per tick is what stopped the small Berry heap being exhausted.

# Deactivation hysteresis (spec 001 FR — "lower threshold, e.g. 200 W"):
# a running load is only shed once surplus drops LOWER_THRESHOLD_W below its
# draw, while it needs the full rated power to switch on. The resulting
# deadband stops loads flapping on/off every second when surplus hovers near
# a load's rating — which was firing an integration PUT per second and
# crashing the VM in native webclient code.
var LOWER_THRESHOLD_W = 200
# epoch below which tasmota.rtc() has no valid wall clock yet (pre-NTP)
var MIN_EPOCH = 1000000000

# Module-private state: ONE map, mutated in place only. Never reassign a
# top-level var from inside a function — under Berry 1.1.0 `import` each
# closure gets its OWN upvalue box, so such writes are invisible to the
# other functions (see nethost.be for the full note).
var _s = {
    'tick': 0,
    # id -> utc when this EMS switched the load ACTIVE; drives min-runtime holds
    'active_since': {}
}

def _now_utc()
    var r = tasmota.rtc()
    if r == nil return 0 end
    return r.find('utc', 0)
end

# spec 001: a running load may only be shed after its minimum runtime.
# Loads we did not start (no _active_since entry) or that have no minimum
# are free to shed; without a valid clock we never hold (fail-safe).
def _min_runtime_reached(load, now)
    var min_rt = load.find('minimalDuration', 0)
    if min_rt == nil || min_rt <= 0 return true end
    if now < MIN_EPOCH return true end
    var since = _s['active_since'].find(load['id'], nil)
    if since == nil return true end
    return (now - since) >= min_rt
end

# Recalculate which waiting/active loads can run given current production.
# Loads in state inactive are never touched.
# Loads in state waiting or active are sorted by priority (ascending) and
# activated greedily with hysteresis: a waiting load switches on only when
# remaining power covers its full rated power; a running load stays on until
# surplus drops LOWER_THRESHOLD_W below its draw AND its minimum runtime has
# elapsed. State transitions are applied via site.set_load_state().
def _update_load_allocation()
    # Sum current power across the generating sources.
    # Use the cached getter: this runs every second and must not trigger
    # per-second integration HTTP fetches, which exhaust the Berry heap.
    # Batteries are left out (issue #20, «loads before battery»): the EMS
    # only observes them, so a discharging battery must not switch on a
    # deferrable load, and power a battery charges with counts as surplus a
    # load may take (a self-consumption inverter charges from surplus only).
    var productions = site.get_productions_cached()
    var available = 0
    for p: productions
        if p.find("productionType", "") != "BATTERY"
            available += p.find("currentPower", 0)
        end
    end

    # Collect user-requested loads (waiting or active).
    # Cached getter for the same reason as productions above.
    var loads = site.get_loads_cached()

    var candidates = []
    for load: loads
        var s = load.find("state", site.STATE_INACTIVE)
        if s == site.STATE_WAITING || s == site.STATE_ACTIVE
            candidates.push(load)
        end
    end
    # nothing requested (the common idle case): skip the sort + allocation
    # loop entirely — this runs every second on the device
    if size(candidates) == 0
        return
    end

    # Insertion sort by priority ascending (lower number = higher priority).
    # while-loop, not `for i: 1..n-1` — a range allocates an object per call
    # and this is the per-second hot path.
    var n = size(candidates)
    var i = 1
    while i < n
        var key = candidates[i]
        var j = i - 1
        while j >= 0 && candidates[j]["priority"] > key["priority"]
            candidates[j + 1] = candidates[j]
            j -= 1
        end
        candidates[j + 1] = key
        i += 1
    end

    # Greedy allocation with hysteresis + minimum runtime; state transitions
    # applied via site.set_load_state(). A running load holds its power slot
    # (remaining may go negative — i.e. drawn from grid) while protected by
    # the deadband or its minimum runtime, which correctly starves lower
    # priority loads instead of flapping the marginal one.
    var now = _now_utc()
    var remaining = available
    for load: candidates
        var p   = load.find("currentPower", 0)
        # each load's state is only mutated at its own decision point below,
        # so reading it here IS the pre-allocation state — no snapshot map
        # needed (the old per-second `old_states` map was pure heap churn)
        var cur = load.find("state", site.STATE_INACTIVE)
        var new_state
        if cur == site.STATE_ACTIVE
            if remaining >= p - LOWER_THRESHOLD_W
                new_state = site.STATE_ACTIVE       # enough surplus to stay on
                remaining -= p
            elif !_min_runtime_reached(load, now)
                new_state = site.STATE_ACTIVE       # held until minimum runtime
                remaining -= p
            else
                new_state = site.STATE_WAITING      # shed: surplus gone, min runtime met
            end
        else
            if remaining >= p
                new_state = site.STATE_ACTIVE
                remaining -= p
            else
                new_state = site.STATE_WAITING
            end
        end

        if cur != new_state
            # pure: updates RAM state and QUEUES the relay write; the actual
            # webclient is sent later by site.scheduler_step(), never here
            site.set_load_state(load["id"], new_state)
        end

        # maintain min-runtime bookkeeping across transitions
        if new_state == site.STATE_ACTIVE && cur != site.STATE_ACTIVE
            _s['active_since'][load["id"]] = now
        elif new_state != site.STATE_ACTIVE && _s['active_since'].contains(load["id"])
            _s['active_since'].remove(load["id"])
        end
    end
    # NOTE: no per-second logging here — an f-string would allocate on the
    # hot path every second regardless of log level (Berry evaluates the
    # argument eagerly), needless churn on the tiny heap.
end

def every_second()
    _s['tick'] += 1
    # One outbound HTTP op per tick (a single integration read OR one queued
    # relay write), deferred while a response is streaming. This replaces the
    # old every-5s burst that fetched every load+production at once — that
    # burst of webclient() allocations is what tipped the ESP32-C3 heap into
    # "MEMORY ALLOCATION FAILED" when an inbound request overlapped it.
    site.scheduler_step()
    # Allocation itself is pure and cheap: it only reads cached twin state
    # and queues any transitions, so it is safe to run every second.
    _update_load_allocation()
end

def start()
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, "EMS driver started")
end

def stop()
    tasmota.remove_driver(_driver)
    logger.logMsg(logger.lInfo, "EMS driver stopped")
end

_driver = drivershim.make({'every_second': every_second})

ems.update_load_allocation = _update_load_allocation
ems.start                  = start
ems.stop                   = stop

return ems
