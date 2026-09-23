var simulator = module()
import json
import string
import logger
import nethost

# Per-host cool-off after a failed request lives in the shared `nethost`
# module (see nethost.be): the default HTTP timeout cannot be lowered
# (wc.set_timeouts() hard-faults on this firmware), so a single unreachable
# simulator would otherwise block the single-threaded VM on every read/write
# and stall the webserver. The backoff is shared across integrations because
# loads (shelly) and productions/grid (simulator) hit the SAME host.

def _get(url)
    if nethost.skipping(url)
        return nil          # host in cool-off — skip the blocking webclient
    end
    var wc = nil
    try
        wc = webclient()
        wc.begin(url)
        var status = wc.GET()
        if status == 200
            var data = json.load(wc.get_string())
            wc.close()
            nethost.ok(url)
            return data
        else
            logger.logMsg(logger.lWarn, f"simulator: GET '{url}' returned HTTP {status}")
            nethost.fail(url)
        end
    except .. as e
        logger.logMsg(logger.lWarn, f"simulator: GET '{url}' failed: {e}")
        nethost.fail(url)
    end
    if wc != nil wc.close() end
    return nil
end

def _put(url, payload)
    if nethost.skipping(url)
        return false        # host in cool-off — skip the blocking webclient
    end
    var wc = nil
    try
        wc = webclient()
        wc.begin(url)
        wc.add_header("Content-Type", "application/json")
        var status = wc.PUT(payload)
        wc.close()
        if status == 200
            nethost.ok(url)
            return true
        end
        logger.logMsg(logger.lWarn, f"simulator: PUT '{url}' returned HTTP {status}")
        nethost.fail(url)
        return false
    except .. as e
        logger.logMsg(logger.lWarn, f"simulator: PUT '{url}' failed: {e}")
        nethost.fail(url)
    end
    if wc != nil wc.close() end
    return false
end

# Returns ONLY the fetched fields — see the contract note in gplug.be. The
# response already carries id, name, state, currentPower; the two fields the
# config owns are dropped here (a merge-side skip) instead of being copied in
# and then overwritten again.
def fetch_item(url, token, cfg)
    var data = _get(url)
    if data == nil return nil end
    var result = {}
    for k: data.keys()
        # The config id is authoritative: grid endpoints return their own id
        # ("in"/"out") which would otherwise shadow the config ids
        # ("from"/"to") that meter/site rely on to identify items.
        # The config productionType is authoritative too: it is the site
        # owner's semantic classification (PHOTOVOLTAIC/BATTERY) that
        # meter._sum_productions matches on. An integration must not shadow it
        # with its own vocabulary (the simulator historically reported "PV"),
        # or the PV sum — and thus the /api/power pv_w series and the live flow
        # diagram — would silently drop it.
        # Both skips are conditional on the config actually carrying the key,
        # so the meter sentinel pollable (no id, no productionType) still gets
        # the descriptor's own fields verbatim.
        if (k == "id" || k == "productionType") && cfg.find(k, nil) != nil
            continue
        end
        result[k] = data[k]
    end
    # NOTE: unlike gplug/homeassistant, no dimension:"kW" scaling here — the
    # simulator API always serves watts, so a config "dimension" tag on a
    # simulator item is documentation only and deliberately ignored (some
    # legacy configs carry a stray "kW" tag that must not scale anything).
    # No result["url"] = url either: `url` came from the item map we merge
    # back into.
    return result
end

def set_state(url, token, state)
    return _put(url + "/state", json.dump({"state": string.toupper(state)}))
end

simulator.fetch_item = fetch_item
simulator.set_state  = set_state

return simulator
