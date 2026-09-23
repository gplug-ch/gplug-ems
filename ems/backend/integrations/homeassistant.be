var homeassistant = module()
import json
import logger
import nethost

def _get(url, token)
    # Skip hosts in cool-off: the ~9 s default webclient timeout (cannot be
    # lowered — set_timeouts() hard-faults this firmware) would block the
    # shared Berry thread and stall the webserver so the UI can't load.
    if nethost.skipping(url)
        return nil
    end
    var wc = nil
    try
        wc = webclient()
        wc.begin(url)
        if token != nil && token != ""
            wc.add_header("Authorization", "Bearer " + token)
        end
        var status = wc.GET()
        if status == 200
            var data = json.load(wc.get_string())
            wc.close()
            nethost.ok(url)
            return data
        else
            logger.logMsg(logger.lWarn, f"homeassistant: GET '{url}' returned HTTP {status}")
            nethost.fail(url)
        end
    except .. as e
        logger.logMsg(logger.lWarn, f"homeassistant: GET '{url}' failed: {e}")
        nethost.fail(url)
    end
    if wc != nil wc.close() end
    return nil
end

# Returns ONLY the fetched fields — see the contract note in gplug.be:
# site._refresh_item() merges them into the item map, which is the same map
# passed in as `cfg`, so copying cfg into the result was pure churn.
def fetch_item(url, token, cfg)
    var data = _get(url, token)
    if data == nil return nil end
    var result = {}
    # Map HA state string -> currentPower
    # HA states are strings; a non-numeric one ("unavailable", "unknown")
    # reports nothing — real() would turn it into a fake 0 W / 0 % SoC.
    # json.load parses a number and answers nil for anything else.
    var state = data.find("state", nil)
    if type(state) == 'string' state = json.load(state) end
    if type(state) == 'int' || type(state) == 'real'
        result["currentPower"] = real(state)
    end

    # Scale only when the HA response actually carried a state: the config
    # normally has no currentPower key, so an unguarded read raises key_error
    # here — uncaught up through site.poll_step() into ems.every_second().
    var pw_val = result.find("currentPower", nil)
    if pw_val != nil && cfg.find("dimension", nil) == "kW"
        result["currentPower"] = pw_val * 1000
    end
    # no result["url"] = url: `url` came from the item map we merge back into,
    # so echoing it is a write of a value onto itself
    return result
end

def set_state(url, token, state)
    logger.logMsg(logger.lWarn, "homeassistant: set_state not supported (read-only)")
    return false
end

homeassistant.fetch_item = fetch_item
homeassistant.set_state  = set_state

return homeassistant
