var gplug = module()
import logger
import json
import string
import math

# Default top-level object of tasmota.read_sensors(): the smart-meter
# descriptor. Items may name another one via "sensor" (issue #10), e.g. the
# "SMA" object an attached inverter's Modbus script publishes next to "z".
var DEFAULT_SENSOR = "z"

# SunSpec scale factors are signed int16 exponents, specified -10..10;
# anything outside is a bogus register, not a factor (issue #12).
var SF_MAX = 10

# sf_warned: "<sensor>.<scale_field>" keys already warned about a
# missing/invalid scale factor — log once per item, not once per poll tick.
# over_max: "<sensor>.<field>" keys currently above max_power — warn once
# when an item enters that state, again only after a plausible read.
# fresh: item key -> {p, e, t} — last power, last energy counter and utc of
# the last FRESH observation, for stale detection (issue #15).
var _s = {'sf_warned': {}, 'over_max': {}, 'fresh': {}}

# epoch below which tasmota.rtc() has no valid wall clock yet (pre-NTP);
# no staleness is judged until the clock is set (same guard as ems.be)
var MIN_EPOCH = 1000000000

# Read + parse the local Tasmota sensor JSON and return the top-level object
# under key `name` (or nil when unavailable). This is the ONE guarded
# read-and-parse path shared by fetch_item (item field reads) and
# webservice's GET /api/meter passthrough (spec 007 FR-701) — no webclient,
# no flash: read_sensors() is local (FR-702).
def read_sensor(name)
    var data = tasmota.read_sensors()
    if data == nil || type(data) != 'string' || size(data) == 0
        logger.logMsg(logger.lWarn, "gplug: no sensor data")
        return nil
    end
    var parsed
    try
        parsed = json.load(data)
    except .. as e
        logger.logMsg(logger.lWarn, f"gplug: cannot parse sensor data: {e}")
        return nil
    end
    # json.load returns nil on malformed input; guard before indexing so we
    # never call a method on nil (which hard-faults the Berry VM on boot)
    if parsed == nil
        logger.logMsg(logger.lWarn, "gplug: sensor data is not valid JSON")
        return nil
    end
    var obj = parsed.find(name, nil)
    # a scalar top-level entry ("TempUnit":"C") is not an object to index
    if obj != nil && !isinstance(obj, map) return nil end
    return obj
end

def _is_num(v) return type(v) == 'int' || type(v) == 'real' end

# SunSpec dynamic scale factor (issue #12): an item may name the register
# holding the exponent (sf_field, e.g. "Psf") and the exponent its value is
# already scaled for (base, default 0 = the value field is the raw
# register). Returns value * 10^(sf - base). Opt-in only: a Tasmota script
# usually bakes a fixed scaling in (Hermann's P_AC is already kW at Psf 1),
# so applying 10^Psf implicitly would be off by 10. A missing / null /
# non-numeric / out-of-range sf leaves the value as is (sf == base).
def _apply_sf(v, data, sensor, sf_field, base)
    if sf_field == nil || sf_field == "" return v end
    if !_is_num(base) base = 0 end
    var sf = data.find(sf_field, nil)
    if _is_num(sf) && math.abs(sf) <= SF_MAX
        return sf != base ? v * math.pow(10, sf - base) : v
    end
    var key = f"{sensor}.{sf_field}"
    if !_s['sf_warned'].contains(key)
        _s['sf_warned'][key] = true
        logger.logMsg(logger.lWarn, f"gplug: no valid scale factor '{key}', value left unscaled")
    end
    return v
end

def _now_utc()
    var r = tasmota.rtc()
    if r == nil return 0 end
    return r.find('utc', 0)
end

# Stale detection (issue #15). A Tasmota Modbus script keeps publishing the
# inverter's LAST value after sunset (the SMA stops answering), and the JSON
# carries no timestamp — so freshness is inferred from change:
#   * "energy_field" set (e.g. "E_AC"): fresh when the energy counter moved.
#     While real power flows the counter must rise; a frozen counter under a
#     non-zero power is a frozen script, however steady the power looks.
#   * otherwise: fresh when the power value itself changed.
# A power of 0 always counts as fresh (a frozen 0 is harmless), and so does
# the first observation. A read without a value (missing field, null,
# rejected by max_power) is never fresh. After `limit` s without a fresh
# observation the item reports currentPower 0 and stale true; lastUpdate is
# the utc of the last fresh observation either way.
def _track_freshness(key, cfg, data, result, limit)
    var now = _now_utc()
    if now < MIN_EPOCH return result end
    var st = _s['fresh'].find(key, nil)
    var p = result != nil ? result.find("currentPower", nil) : nil
    var efield = cfg.find("energy_field", nil)
    var e = nil
    if data != nil && efield != nil && efield != ""
        e = data.find(efield, nil)
        if !_is_num(e) e = nil end
    end
    var fresh = false
    if p != nil
        if st == nil || p == 0
            fresh = true
        elif e != nil && st.find('e', nil) != nil
            fresh = e != st['e']
        else
            fresh = p != st.find('p', nil)
        end
    end
    if st == nil
        if !fresh return result end
        st = {}
        _s['fresh'][key] = st
    end
    if p != nil st['p'] = p end
    if e != nil st['e'] = e end
    if fresh st['t'] = now end
    var out = result != nil ? result : {}
    if now - st['t'] > limit
        if !st.find('stale', false)
            st['stale'] = true
            logger.logMsg(logger.lWarn, f"gplug: '{key}' stale, no fresh value for {now - st['t']} s")
        end
        out = {"currentPower": 0, "stale": true, "lastUpdate": st['t']}
    else
        st['stale'] = false
        out["stale"] = false
        out["lastUpdate"] = st['t']
    end
    return out
end

# The smart-meter descriptor — GET /api/meter serves exactly this.
def read_z()
    return read_sensor(DEFAULT_SENSOR)
end

# Integration contract: return ONLY the fields this fetch produced (or nil
# when the read failed). site._refresh_item() merges them into the item map
# — and that item map IS the `cfg` passed in here, so copying cfg into the
# result only wrote every key back onto itself: two whole-map copies per
# poll tick on a ~30 KB Berry heap. Keys this fetch does not produce keep
# their configured values automatically, because nothing overwrites them.
#
# "sensor" picks the top-level object to read from (default "z"). A JSON
# null value ("Pr_AC":null) parses to nil and so, like a missing field,
# produces no currentPower — the item keeps its last value.
def fetch_item(url, token, cfg)
    var sensor = cfg.find("sensor", nil)
    if sensor == nil || sensor == "" sensor = DEFAULT_SENSOR end
    var data = read_sensor(sensor)
    var field = cfg.find("field", nil)
    # stale detection is opt-in per item: "stale_after" in s (issue #15)
    var limit = cfg.find("stale_after", nil)
    if !_is_num(limit) || limit <= 0 limit = nil end
    var fkey = cfg.find("id", nil)
    if fkey == nil fkey = sensor + "." + (field != nil ? field : "Power") end
    if data == nil
        logger.logMsg(logger.lWarn, f"gplug: no sensor object '{sensor}'")
        # a vanished sensor object must age the item out too
        return limit != nil ? _track_freshness(fkey, cfg, nil, nil, limit) : nil
    end
    var result = {}

    if field != nil
        var val = data.find(field, nil)
        if val != nil result["currentPower"] = real(val) end
    else
        var pw = data.find("Power", data.find("power", nil))
        if pw != nil result["currentPower"] = real(pw) end
    end

    var raw = result.find("currentPower", nil)
    if raw != nil
        result["currentPower"] = _apply_sf(raw, data, sensor,
            cfg.find("scale_field", nil), cfg.find("scale_base", 0))
    end

    # Scale only when this fetch actually produced a value: the sensor field
    # may be missing and the config normally carries no currentPower key, so
    # an unguarded read raises key_error here — uncaught all the way up
    # through site.poll_step() into ems.every_second().
    var pw_val = result.find("currentPower", nil)
    if pw_val != nil && cfg.find("dimension", nil) == "kW"
        result["currentPower"] = pw_val * 1000
    end

    # Energy counter (issue #14): with "energy_field" set, report the
    # counter in Wh as "energyCounter" so meter.be can take a slot's energy
    # from the counter difference instead of the power integral. Its unit
    # is "energy_dimension" ("Wh"/"kWh"), defaulting to the power's
    # ("kW" -> "kWh"); its own SunSpec scale factor via
    # "energy_scale_field"/"energy_scale_base" (e.g. "Esf"). An unreadable
    # counter is reported as nil — explicitly, so the merge clears the
    # previous reading and the meter falls back to the integral instead of
    # differencing a stale value.
    var efield = cfg.find("energy_field", nil)
    if efield != nil && efield != ""
        var ev = data.find(efield, nil)
        if _is_num(ev)
            ev = _apply_sf(real(ev), data, sensor,
                cfg.find("energy_scale_field", nil), cfg.find("energy_scale_base", 0))
            var edim = cfg.find("energy_dimension", nil)
            if edim == nil edim = cfg.find("dimension", nil) == "kW" ? "kWh" : "Wh" end
            if edim == "kWh" ev = ev * 1000 end
            result["energyCounter"] = ev
        else
            result["energyCounter"] = nil
        end
    end

    # Battery state of charge (issue #20): "soc_field" names the SoC (%) in
    # the same sensor object, optionally with its own SunSpec scale factor
    # "soc_scale_field"/"soc_scale_base" (model 124 ChaState/ChaState_SF).
    # Reported as "soc"; an unreadable value is dropped, not zeroed — the
    # item keeps its last SoC rather than showing an empty battery.
    var sfield = cfg.find("soc_field", nil)
    if sfield != nil && sfield != ""
        var sv = data.find(sfield, nil)
        if _is_num(sv)
            sv = _apply_sf(real(sv), data, sensor,
                cfg.find("soc_scale_field", nil), cfg.find("soc_scale_base", 0))
            if sv >= 0 && sv <= 100 result["soc"] = sv end
        end
    end

    # Plausibility cap (issue #13): "max_power" in W, compared after all
    # scaling. At night an SMA reports the SunSpec N/A sentinel 0x8000,
    # which a script's fixed /100 turns into 327.68 kW — far above any
    # plausible rating. A value beyond the cap counts as a missing field: no
    # currentPower, the item keeps its last value. The raw sentinel itself
    # is not visible here (the script pre-scales), hence a cap, not a match.
    var cap = cfg.find("max_power", nil)
    var p = result.find("currentPower", nil)
    if p != nil && _is_num(cap) && cap > 0
        var key = sensor + "." + (field != nil ? field : "Power")
        if math.abs(p) > cap
            result.remove("currentPower")
            if !_s['over_max'].contains(key)
                _s['over_max'][key] = true
                logger.logMsg(logger.lWarn, f"gplug: '{key}' = {p} W exceeds max_power {cap} W, ignored")
            end
        elif _s['over_max'].contains(key)
            _s['over_max'].remove(key)
        end
    end

    if limit != nil result = _track_freshness(fkey, cfg, data, result, limit) end
    return result
end

def set_state(url, token, state)
    logger.logMsg(logger.lWarn, "gplug: set_state not implemented")
    return false
end

gplug.read_sensor = read_sensor
gplug.read_z     = read_z
gplug.fetch_item = fetch_item
gplug.set_state  = set_state

return gplug
