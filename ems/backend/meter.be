# meter.be — 10-second power sampling and 15-min energy accumulation (spec 001).
#
# Every 10 s (Tasmota every_second driver hook, modulo-10 tick):
#   grid_w  signed W: import positive, export negative (grid items "from"/"to")
#   pv_w    W: sum of PHOTOVOLTAIC productions
#   bat_w   signed W: sum of BATTERY productions (positive = discharging)
#   load_w  W: sum of ACTIVE loads' rated power
# Samples go to a RAM ring of 90 entries (15 min) served via /api/power.
#
# Each sample is integrated into Wh accumulators; at every wall-clock
# quarter-hour boundary the slot is sealed into store.push_15m().
#
# Data-fetch note (NFR-101): the meter never fetches. loads, productions AND
# grid are all refreshed one item per tick by site's poll scheduler, so the
# meter reads them via the cached site getters only. No webclient runs on the
# metering path.
#
# Counter-based PV energy (issue #14): a PV production whose integration
# reports "energyCounter" (Wh, e.g. gplug with "energy_field":"E_AC") gets
# its slot energy from counter(end) - counter(start) instead of the power
# integral — the inverter's own meter, immune to missed or garbage samples.
# Per such production the meter keeps its own share of the integral next
# to the counter readings; on sealing a slot it swaps that share for the
# counter difference ONLY if the difference is trustworthy:
#   * at least one counter reading in the slot, and the slot not partial
#     (first slot after boot / a new production / a clock jump),
#   * difference >= 0 (a reset or wrap falls back to the integral, logged),
#   * with "max_power" set: difference <= max_power over the slot + 10 %.
# Slots chain: a slot's start reading is the previous slot's last one, so
# no energy is lost or counted twice across a boundary; a slot without any
# reading breaks the chain (see _reset_acc). Still append-only:
# the swap happens before store.push_15m(), nothing is rewritten.
#
# Battery (issue #20): bat_w is integrated split by sign into charge and
# discharge Wh, sealed with the slot (the SoC is live only — /productions —
# not recorded, see STORAGE.md §4). The battery stays behind the meter: imp/exp/pv are unchanged and vZEV only ever sees
# the grid values. A site without a battery seals no battery values, so its
# records keep their four-field shape.

var meter = module()

import strict
import logger
import site
import store
import drivershim

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

var SAMPLE_S  = 10
var SLOT_S    = 900
var RING_CAP  = 90
# flat sample ring: SAMPLE_LEN values per sample [ts, grid, pv, bat, load]
# in ONE list — hundreds of tiny per-sample lists would fragment the small
# Berry heap on the device
var SAMPLE_LEN = 5
var MIN_EPOCH = 1000000000
# a gap between samples larger than this discards the open accumulator
# (clock jump after NTP sync / suspended runtime — edge case in spec 001)
var MAX_GAP_S = 60

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    'tick': 0,
    'samples': [],
    'slot_ts': nil,
    'last_utc': nil,
    'acc_imp': 0.0,
    'acc_exp': 0.0,
    'acc_pv': 0.0,
    'acc_chg': 0.0,
    'acc_dis': 0.0,
    'n_grid': 0,
    'n_pv': 0,
    'n_bat': 0,
    'acc_secs': 0,
    # production id -> {e0, e1, wh, n, partial, cap}: counter reading at slot
    # start / latest, this production's integral share (Wh), counter
    # readings this slot, partial-slot flag, max_power (issue #14)
    'ctr': {}
}

def _reset_acc(slot_ts)
    _s['slot_ts'] = slot_ts
    _s['acc_imp'] = 0.0
    _s['acc_exp'] = 0.0
    _s['acc_pv']  = 0.0
    _s['acc_chg'] = 0.0
    _s['acc_dis'] = 0.0
    _s['n_grid']  = 0
    _s['n_pv']    = 0
    _s['n_bat']   = 0
    _s['acc_secs'] = 0
    # chain the counters into the next slot: its start is this slot's end.
    # A slot without a single reading breaks the chain — its energy went
    # into the integral, so differencing across it would count it twice;
    # the next reading then starts a new (partial) chain.
    for st : _s['ctr']
        if st['n'] == 0 st['e1'] = nil end
        st['e0'] = st['e1']
        st['wh'] = 0.0
        st['n'] = 0
        st['partial'] = false
    end
end

# test hook: back to pristine state
def reset()
    _s['tick'] = 0
    _s['samples'] = []
    _s['last_utc'] = nil
    _s['ctr'] = {}
    _reset_acc(nil)
end

# --- reading current values from site state ---

# signed grid power; nil if no grid item delivered a value.
# Reads the CACHED grid (kept fresh by site's poll scheduler): the 10 s
# sample tick must not itself fire a webclient — that was one of the
# bursts overlapping inbound requests and exhausting the heap.
def _read_grid()
    var g = site.get_grid_cached()
    if g == nil || size(g) == 0
        return nil
    end
    var imp = nil
    var exp = nil
    for item : g
        var p = item.find('currentPower', nil)
        if p == nil
            continue
        end
        var id = item.find('id', '')
        if id == 'from'
            imp = (imp == nil ? 0 : imp) + p
        elif id == 'to'
            exp = (exp == nil ? 0 : exp) + p
        end
    end
    if imp == nil && exp == nil
        return nil
    end
    return (imp == nil ? 0 : imp) - (exp == nil ? 0 : exp)
end

def _sum_productions(ptype)
    var total = nil
    for p : site.get_productions_cached()
        if p.find('productionType', '') == ptype
            var v = p.find('currentPower', nil)
            if v != nil
                total = (total == nil ? 0 : total) + v
            end
        end
    end
    return total
end

# PV productions reporting an energy counter: [[id, power, counter, cap]]
def _pv_counters()
    var out = []
    for p : site.get_productions_cached()
        if p.find('productionType', '') == 'PHOTOVOLTAIC' && p.contains('energyCounter')
            out.push([p.find('id', ''), p.find('currentPower', nil),
                      p['energyCounter'], p.find('max_power', nil)])
        end
    end
    return out
end

def _sum_active_loads()
    var total = 0
    for l : site.get_loads_cached()
        if l.find('state', '') == site.STATE_ACTIVE
            total += l.find('currentPower', 0)
        end
    end
    return total
end

# --- accumulation ---

# PV slot energy: the integral, with every trustworthy counter difference
# swapped in for that production's share of it (issue #14)
def _pv_energy()
    var pv = _s['acc_pv']
    for id : _s['ctr'].keys()
        var st = _s['ctr'][id]
        if st['n'] == 0 || st['partial'] || st['e0'] == nil || st['e1'] == nil
            continue
        end
        var d = st['e1'] - st['e0']
        var cap = st['cap']
        if d < 0
            logger.logMsg(logger.lWarn, f"meter: '{id}' energy counter went back ({d} Wh), slot uses power integral")
            continue
        end
        if (type(cap) == 'int' || type(cap) == 'real') && cap > 0 &&
           d > cap * _s['acc_secs'] / 3600.0 * 1.1
            logger.logMsg(logger.lWarn, f"meter: '{id}' energy counter jumped {d} Wh, slot uses power integral")
            continue
        end
        pv = pv - st['wh'] + d
    end
    return pv < 0 ? 0.0 : pv
end

# per-sample counter bookkeeping for the open slot (dt as for the integral)
def _ingest_counters(ctrs, dt)
    if ctrs == nil return end
    for c : ctrs
        var id = c[0]
        var st = _s['ctr'].find(id, nil)
        if st == nil
            # first sight mid-slot: no start reading -> integral this slot
            st = {'e0': nil, 'e1': nil, 'wh': 0.0, 'n': 0, 'partial': true, 'cap': nil}
            _s['ctr'][id] = st
        end
        if c[1] != nil st['wh'] += c[1] * dt / 3600.0 end
        var e = c[2]
        if e != nil
            if st['e0'] == nil
                st['e0'] = e
                st['partial'] = true
            end
            st['e1'] = e
            st['n'] += 1
        end
        st['cap'] = c[3]
    end
end

def _close_slot()
    # zero samples -> no record (missing data stays a hole, FR-109);
    # over-long accumulation (clock anomaly) -> discard, never write a
    # slot whose energy does not belong to its ts. With measured-dt
    # integration the first sample of a slot may legitimately carry up to
    # MAX_GAP_S from before the boundary, hence the bound.
    if _s['acc_secs'] > 0 && _s['acc_secs'] <= SLOT_S + MAX_GAP_S
        var imp = _s['n_grid'] > 0 ? int(_s['acc_imp'] + 0.5) : nil
        var exp = _s['n_grid'] > 0 ? int(_s['acc_exp'] + 0.5) : nil
        var pv  = _s['n_pv']  > 0 ? int(_pv_energy() + 0.5) : nil
        var chg = _s['n_bat'] > 0 ? int(_s['acc_chg'] + 0.5) : nil
        var dis = _s['n_bat'] > 0 ? int(_s['acc_dis'] + 0.5) : nil
        if imp != nil || pv != nil
            store.push_15m(_s['slot_ts'], imp, exp, pv, chg, dis)
            # Hand the sealed slot to the vZEV backend (spec 005 FR-503) so it
            # multicasts it and runs allocation. Optional dependency: guarded so
            # the meter keeps working when vzev.be is absent (e.g. CLI tests).
            # Gated on main.be's `_vzev_loaded` boot flag — a bare `import vzev`
            # here would compile the whole ~21 KB module on the first slot close
            # even on sites that don't participate in a community, defeating the
            # lazy vzev loading (startup-heap issue #2).
            try
                import global
                if global.contains('_vzev_loaded') && global._vzev_loaded
                    import vzev
                    vzev.announce_slot(_s['slot_ts'], imp != nil ? imp : 0, exp != nil ? exp : 0)
                end
            except ..
            end
        end
    end
end

# ingest one sample; utc passed explicitly so tests can drive time
def _ingest(utc, grid_w, pv_w, bat_w, load_w, ctrs)
    var samples = _s['samples']
    samples.push(utc)
    samples.push(grid_w)
    samples.push(pv_w)
    samples.push(bat_w)
    samples.push(load_w)
    if size(samples) > RING_CAP * SAMPLE_LEN
        var k = 0
        while k < SAMPLE_LEN
            samples.remove(0)
            k += 1
        end
    end

    # defer slot accounting until the RTC delivers a plausible epoch
    if utc < MIN_EPOCH
        return
    end

    var slot = utc - utc % SLOT_S
    var prev_utc = _s['last_utc']

    # clock jump (forward gap or backwards): discard the open accumulator
    if _s['last_utc'] != nil && (utc < _s['last_utc'] || utc - _s['last_utc'] > MAX_GAP_S)
        _reset_acc(slot)
        prev_utc = nil
        # the counters' start reading no longer matches this slot's integral
        for st : _s['ctr'] st['partial'] = true end
    end
    _s['last_utc'] = utc

    if _s['slot_ts'] == nil
        _reset_acc(slot)
    elif slot != _s['slot_ts']
        _close_slot()
        _reset_acc(slot)
    end

    # integrate over the MEASURED interval since the previous sample, not a
    # fixed 10 s: the every_second hook counts invocations, and any outbound
    # webclient() blocks the single Berry thread (up to ~9 s), so real
    # sample gaps routinely exceed SAMPLE_S. A fixed dt under-counts energy
    # against the meter's true registers. Bounded by MAX_GAP_S (larger gaps
    # were discarded above).
    var dt = SAMPLE_S
    if prev_utc != nil
        var measured = utc - prev_utc
        if measured > 0 && measured <= MAX_GAP_S
            dt = measured
        end
    end
    if grid_w != nil
        if grid_w > 0
            _s['acc_imp'] += grid_w * dt / 3600.0
        else
            _s['acc_exp'] += (-grid_w) * dt / 3600.0
        end
        _s['n_grid'] += 1
    end
    if pv_w != nil
        _s['acc_pv'] += pv_w * dt / 3600.0
        _s['n_pv'] += 1
    end
    if bat_w != nil
        if bat_w > 0
            _s['acc_dis'] += bat_w * dt / 3600.0
        else
            _s['acc_chg'] += (-bat_w) * dt / 3600.0
        end
        _s['n_bat'] += 1
    end
    _ingest_counters(ctrs, dt)
    _s['acc_secs'] += dt
end

def _sample()
    var utc = tasmota.rtc()['utc']
    _ingest(utc, _read_grid(), _sum_productions('PHOTOVOLTAIC'),
            _sum_productions('BATTERY'), _sum_active_loads(), _pv_counters())
end

# --- reads ---

def sample_count()
    return size(_s['samples']) / SAMPLE_LEN
end

# one sample as [ts, grid_w, pv_w, bat_w, load_w] — consumers stream one
# at a time to keep peak allocations small
def sample_at(i)
    if i < 0 || i >= sample_count()
        return nil
    end
    var samples = _s['samples']
    var b = i * SAMPLE_LEN
    return [samples[b], samples[b + 1], samples[b + 2],
            samples[b + 3], samples[b + 4]]
end

# bulk convenience (tests); on-device consumers use sample_count/sample_at
def get_samples()
    var out = []
    var i = 0
    var n = sample_count()
    while i < n
        out.push(sample_at(i))
        i += 1
    end
    return out
end

# --- driver lifecycle ---

def every_second()
    _s['tick'] += 1
    if _s['tick'] % SAMPLE_S != 0
        return
    end
    _sample()
end

def start()
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, "Meter driver started (10 s sampling)")
end

def stop()
    tasmota.remove_driver(_driver)
    logger.logMsg(logger.lInfo, "Meter driver stopped")
end

def save_before_restart()
    stop()
end

_driver = drivershim.make({
    'every_second': every_second,
    'save_before_restart': save_before_restart
})

meter.start        = start
meter.stop         = stop
meter.reset        = reset
meter.get_samples  = get_samples
meter.sample_count = sample_count
meter.sample_at    = sample_at
# test / simulator injection hook
meter.ingest       = _ingest

return meter
