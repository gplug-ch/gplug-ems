var site = module()
import strict
import json
import logger
# The integration modules (homeassistant/simulator/gplug/shelly/modbustcp) are imported
# LAZILY in _get_integration — only the types actually configured in site.json
# are ever compiled (startup-heap issue #2). A typical site uses one of four.

var STATE_INACTIVE = 'INACTIVE'
var STATE_WAITING  = 'WAITING'
var STATE_ACTIVE   = 'ACTIVE'

# tariff defaults (spec 001 FR-107); site.json key "tariffs" overrides
var TARIFF_DEFAULTS = {
    'grid_import_chf_kwh': 0.26,
    'grid_feedin_chf_kwh': 0.18,
    'base_fee_chf_month': 12.5
}

# name -> module registry. Filled at BOOT by main.be's _load_integrations()
# with only the types site.json configures (startup-heap issue #2): on-device
# `import` only resolves .tapp modules while the working dir is valid, so a
# first-use import from the poll tick fails with "module not found".
# _get_integration keeps an import fallback for the Berry CLI tests, where
# sys.path stays valid. In-place mutation of a top-level map is safe — see
# the Berry `import` upvalue caveat below.
var _integrations = {}

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    'loads': [],
    'productions': [],
    'site': nil,
    'grid': [],
    'grid_config': [],
    'tariffs': {},
    # --- outbound-HTTP scheduler (NFR: single Berry heap on ESP32-C3) --------
    # Every outbound webclient() call (integration read AND relay write) is the
    # heaviest heap allocation on the device. Firing several per driver tick, in
    # a burst, is what tipped the tiny heap over into "MEMORY ALLOCATION FAILED"
    # when an inbound response was also holding buffers. So NO outbound HTTP is
    # done inline any more: reads go through a round-robin poll (one item/tick)
    # and writes through an actuation queue (one job/tick), both driven by ems'
    # every_second and both deferred while a response is streaming.
    'pollables': [],     # flat list of item maps (loads+productions+grid) with an integration
    'poll_cursor': -1,   # round-robin index into pollables
    'actuation': [],     # queue of {kind,id,arg} relay writes, newest state wins per (kind,id)
    'serving_ms': nil,   # tasmota.millis() of the last inbound response start (serving guard)
    # Optional smart-meter source (spec 007). On a real gPlug the meter is a
    # LOCAL sensor read by webservice via gplug.read_z() — no config needed. For
    # development without a physical meter, site.json may carry a "meter" block
    # {integration,url} (e.g. the Kotlin simulator's /meter endpoint); it is then
    # polled through the SAME one-op-per-tick scheduler as grid items and cached
    # here, so GET /api/meter still fires no webclient (FR-702).
    'meter_cfg': nil,
    'meter_cache': nil,
    # Standalone Modbus register monitoring (site.json top-level
    # "modbusRegisters"): named registers that don't fit loads (controllable)
    # / productions (PV/battery) / grid (import/export) — e.g. a heat or
    # water submeter behind a Modbus TCP gateway. Each entry is a plain
    # pollable item (like a grid item): config copied in at load_config(),
    # the poll scheduler merges "currentPower" into it in place. Served
    # verbatim by GET /api/modbus for the browser's raw-register view
    # (mirrors GET /api/meter's device-serves-raw / browser-labels split).
    'modbus_config': [],
    'modbus': []
}

# True once the network stack is ready for outbound HTTP. Creating a
# webclient() before WiFi is associated hard-faults the Berry VM (Guru
# Meditation / Load access fault) at boot — the 2 s start timer can fire
# before the association completes, which is why the crash is intermittent.
def _net_ready()
    var w = tasmota.wifi()
    if w == nil
        return false
    end
    # `up` is the only authoritative flag. The old test also accepted
    # w.contains("ip"), but Tasmota puts an `ip` key in the map even while the
    # station is DOWN (it reads "0.0.0.0"), so the whole gate degraded to
    # "always true" and the caller ran before association — exactly the
    # hard-fault this guard exists to prevent. Keep the ip check, but as a
    # VALUE test, not a key test.
    if w.find("up", false) != true
        return false
    end
    var ip = w.find("ip", "")
    return type(ip) == "string" && size(ip) > 0 && ip != "0.0.0.0"
end

def _get_integration(name)
    if name == nil
        logger.logMsg(logger.lWarn, "Site: item has no 'integration' field")
        return nil
    end
    var intg = _integrations.find(name, nil)
    if intg != nil
        return intg
    end
    # Not registered at boot. On-device this means site.json gained an
    # integration type after the boot scan (e.g. via POST /api/config) —
    # importing a .tapp module now no longer resolves, so ask for a restart.
    # In the Berry CLI (tests) the import below does work.
    try
        if name == 'homeassistant'
            import homeassistant
            intg = homeassistant
        elif name == 'simulator'
            import simulator
            intg = simulator
        elif name == 'gplug'
            import gplug
            intg = gplug
        elif name == 'shelly'
            import shelly
            intg = shelly
        elif name == 'modbustcp'
            import modbustcp
            intg = modbustcp
        else
            logger.logMsg(logger.lWarn, f"Site: unknown integration '{name}'")
            return nil
        end
    except .. as e
        logger.logMsg(logger.lWarn,
            f"Site: integration '{name}' not loaded ({e}) — restart to apply")
        return nil
    end
    _integrations[name] = intg
    return intg
end

# boot-time registration (main.be scans site.json and imports only the types
# it finds, while .tapp modules are still importable)
def register_integration(name, mod)
    if name != nil && mod != nil
        _integrations[name] = mod
    end
end

# --- config ---

def _fetch_items(items, label)
    # No inline fetching: live values are filled lazily by the poll
    # scheduler (poll_step), one item per tick. Config is returned verbatim
    # so loads/productions appear immediately with their power/priority and
    # allocation runs before the first poll completes. This is what removed
    # the boot/reload burst of webclient() allocations from the hot path.
    return items == nil ? [] : items
end

# --- outbound-HTTP scheduler ---------------------------------------------

# (re)build the round-robin poll set: every load/production/grid item that
# has an integration. Maps are held by reference and refreshed in place.
def _build_pollables()
    var pollables = []
    for l: _s['loads']
        if l.find("integration", nil) != nil pollables.push(l) end
    end
    for p: _s['productions']
        if p.find("integration", nil) != nil
            pollables.push(p)
            # battery SoC from a second entity (issue #20, e.g. HA
            # sensor.speicher_ladestand): its own round-robin slot, so a
            # fetch stays ONE webclient per tick. The sentinel's fetched
            # "currentPower" is the SoC; it lands in the item as "soc".
            var soc_url = p.find("soc_url", nil)
            if soc_url != nil && soc_url != ""
                pollables.push({
                    "_soc_of": p,
                    "integration": p["integration"],
                    "url": soc_url,
                    "token": p.find("token", nil)
                })
            end
        end
    end
    for g: _s['grid']
        if g.find("integration", nil) != nil pollables.push(g) end
    end
    for m: _s['modbus']
        if m.find("integration", nil) != nil pollables.push(m) end
    end
    # optional dev smart-meter source: a sentinel pollable that caches the
    # whole fetched sensor object instead of merging it into an item map
    if _s['meter_cfg'] != nil && _s['meter_cfg'].find("integration", nil) != nil
        pollables.push({
            "_meter": true,
            "integration": _s['meter_cfg']["integration"],
            "url": _s['meter_cfg'].find("url", ""),
            "token": _s['meter_cfg'].find("token", nil)
        })
    end
    _s['pollables'] = pollables
    _s['poll_cursor'] = -1
end

# fetch one item's live values and merge them into the item map in place.
# net-guarded and no-op for config-only items; at most ONE webclient.
# Integration contract: fetch_item returns nil (read failed) or a SMALL map
# holding only the fields that fetch produced — never a copy of the item it
# was handed. Anything the integration does not report keeps its configured
# value here simply because nothing overwrites it.
def _refresh_item(item)
    var intg_name = item.find("integration", nil)
    if intg_name == nil || !_net_ready()
        return
    end
    var intg = _get_integration(intg_name)
    if intg == nil
        return
    end
    var data = intg.fetch_item(item.find("url", ""), item.find("token", nil), item)
    if data == nil
        return
    end
    var owner = item.find("_soc_of", nil)
    if owner != nil
        var soc = data.find("currentPower", nil)
        if soc != nil && soc >= 0 && soc <= 100 owner["soc"] = soc end
        return
    end
    # "invert" (issue #20): the device's sign is the opposite of ours (+ =
    # charging for a battery), flipped here for every integration alike
    if item.find("invert", false) == true && data.find("currentPower", nil) != nil
        data["currentPower"] = -data["currentPower"]
    end
    if item.find("_meter", false)
        # cache the raw sensor object as-is: under the fetched-fields-only
        # contract the integration no longer echoes back the sentinel's
        # scheduler keys (_meter/integration/url/token), so the descriptor
        # needs no filtering — and /api/meter costs one map fewer per poll.
        _s['meter_cache'] = data
        return
    end
    for k: data.keys() item[k] = data[k] end
end

# last-fetched simulated meter descriptor (nil on a real gPlug, where the
# meter is a local sensor served straight from gplug.read_z()). No fetch.
def get_meter_cached()
    return _s['meter_cache']
end

# refresh exactly one integration-backed item (round-robin). Returns true
# when it owns this tick's single outbound HTTP slot.
def poll_step()
    var n = size(_s['pollables'])
    if n == 0
        return false
    end
    _s['poll_cursor'] = (_s['poll_cursor'] + 1) % n
    _refresh_item(_s['pollables'][_s['poll_cursor']])
    return true
end

# queue a relay write, collapsing any pending job for the same id so only the
# newest desired state is ever sent (no backlog of stale writes). Loads are the
# only actuated kind — production set-power went with spec 011 step 1.
def _enqueue(id, arg)
    var actuation = _s['actuation']
    var i = 0
    while i < size(actuation)
        if actuation[i]["id"] == id
            actuation.remove(i)
        else
            i += 1
        end
    end
    actuation.push({"id": id, "arg": arg})
end

# --- item getters ---

def get_load_by_id(id)
    for load: _s['loads']
        if load["id"] == id
            return load
        end
    end
    return nil
end

# --- actuation ---

def _actuate_load(id, state)
    var load = get_load_by_id(id)
    if load == nil return end
    var url = load.find("url", nil)
    if url == nil || url == "" return end
    var intg = _get_integration(load.find("integration", nil))
    if intg != nil
        # the load map as 4th argument: modbustcp needs its "write" register,
        # unit and dtype (issue #20); shelly/simulator ignore it (Berry drops
        # excess arguments)
        intg.set_state(url, load.find("token", nil), state, load)
    end
end

# perform one queued relay write (one webclient). Returns true if it did.
def actuate_step()
    if size(_s['actuation']) == 0 || !_net_ready()
        return false
    end
    var job = _s['actuation'][0]
    _s['actuation'].remove(0)
    _actuate_load(job["id"], job["arg"])
    return true
end

# serving guard: the webservice stamps this at each inbound response start
# so the scheduler defers its own outbound webclient while the device is
# still streaming/draining a response (keeps peak heap to one HTTP op).
def note_serving()
    try _s['serving_ms'] = tasmota.millis() except .. end
end

def serving_recent()
    if _s['serving_ms'] == nil
        return false
    end
    try
        return tasmota.millis() - _s['serving_ms'] < 250
    except ..
        return false
    end
end

# drive one scheduler step: at most one outbound webclient, deferred while
# serving, actuation prioritised over polling. Called from ems.every_second.
def scheduler_step()
    if serving_recent()
        return
    end
    if !actuate_step()
        poll_step()
    end
end

def load_config()
    _s['loads'] = []
    _s['productions'] = []
    try
        var f = open("site.json", "r")
        var config = json.load(f.read())
        f.close()
        # json.load returns nil on malformed/empty input; guard before
        # indexing so we never call a method on nil, which hard-faults the
        # Berry VM on boot (uncatchable by this try/except)
        if config == nil
            logger.logMsg(logger.lWarn, "Site: 'site.json' is not valid JSON")
            return
        end
        _s['site'] = {
            "id": config.find("id", nil),
            "name": config.find("name", nil),
            "location": config.find("location", nil),
            "description": config.find("description", nil)
        }
        _s['loads'] = _fetch_items(config.find("loads", []), "Load")
        _s['productions'] = _fetch_items(config.find("productions", []), "Production")
        _s['grid_config'] = config.find("grid", [])
        _s['tariffs'] = config.find("tariffs", {})
        # optional dev meter source (see 'meter_cfg' declaration); reset the
        # cache so a reload cannot serve a stale descriptor
        _s['meter_cfg'] = config.find("meter", nil)
        _s['meter_cache'] = nil
        # persistent grid item maps (copies of config, no fetch); the poll
        # scheduler fills their live values in place a tick at a time
        var grid = []
        for cfg: _s['grid_config']
            var item = {}
            for k: cfg.keys() item[k] = cfg[k] end
            grid.push(item)
        end
        _s['grid'] = grid
        # same copy-then-poll-fills-in-place pattern for standalone Modbus
        # registers (see 'modbus_config'/'modbus' declaration above)
        _s['modbus_config'] = config.find("modbusRegisters", [])
        var modbus = []
        for cfg: _s['modbus_config']
            var item = {}
            for k: cfg.keys() item[k] = cfg[k] end
            modbus.push(item)
        end
        _s['modbus'] = modbus
        _build_pollables()
    except .. as e
        logger.logMsg(logger.lWarn, f"Site: cannot read 'site.json': {e}")
    end
end

def get_site()
    return _s['site']
end

# configured tariffs merged over defaults (spec 001 FR-107)
def get_tariffs()
    var t = {}
    for k: TARIFF_DEFAULTS.keys()
        t[k] = TARIFF_DEFAULTS[k]
    end
    if _s['tariffs'] != nil
        for k: _s['tariffs'].keys()
            t[k] = _s['tariffs'][k]
        end
    end
    return t
end

# last-fetched grid without triggering an integration fetch (the poll
# scheduler keeps it fresh; meter.be reads it on every 10 s sample)
def get_grid_cached()
    return _s['grid']
end

# last-fetched standalone Modbus registers, verbatim (config fields +
# whatever the poll scheduler merged in) — GET /api/modbus serves this list
# as-is, no fetch triggered here.
def get_modbus_cached()
    return _s['modbus']
end

# --- loads ---

def get_loads()
    _s['loads'] = _fetch_items(_s['loads'], "Load")
    return _s['loads']
end

# last-fetched loads without triggering integration fetches (meter.be
# samples every 10 s while ems.be already refreshes every second)
def get_loads_cached()
    return _s['loads']
end

# Update the load's state in RAM immediately (so allocation and the UI see
# it at once) and QUEUE the physical relay write for the scheduler to send
# one-at-a-time — never a webclient inline, whether this is called from the
# per-second allocation or from a /loads request handler.
def set_load_state(id, state)
    var load = get_load_by_id(id)
    if load == nil
        return nil
    end
    if load.find("state", nil) != state
        var url = load.find("url", nil)
        if url != nil && url != ""
            _enqueue(id, state)
        end
    end
    load["state"] = state
    return load
end

# --- productions ---

def get_productions()
    _s['productions'] = _fetch_items(_s['productions'], "Production")
    return _s['productions']
end

# last-fetched productions without triggering integration fetches
def get_productions_cached()
    return _s['productions']
end

site.STATE_INACTIVE = STATE_INACTIVE
site.STATE_WAITING  = STATE_WAITING
site.STATE_ACTIVE   = STATE_ACTIVE

site.load_config           = load_config
site.register_integration  = register_integration
site.get_tariffs           = get_tariffs
site.get_loads             = get_loads
site.get_loads_cached      = get_loads_cached
site.get_productions_cached = get_productions_cached
site.get_load_by_id        = get_load_by_id
site.set_load_state        = set_load_state
site.get_productions       = get_productions
site.get_site              = get_site
site.get_grid_cached       = get_grid_cached
site.get_meter_cached      = get_meter_cached
site.get_modbus_cached     = get_modbus_cached
# outbound-HTTP scheduler (driven by ems.every_second) + serving guard
site.scheduler_step        = scheduler_step
site.poll_step             = poll_step
site.actuate_step          = actuate_step
site.note_serving          = note_serving
site.serving_recent        = serving_recent

return site
