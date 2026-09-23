var shelly = module()
import json
import string
import logger
import simulator
import nethost

def _get(url)
    # Skip unreachable hosts inside their cool-off window: the ~9 s default
    # webclient timeout (cannot be lowered — set_timeouts() hard-faults this
    # firmware) would otherwise block the shared Berry thread and stall the
    # webserver so the UI can't load. Shared backoff (nethost) with the other
    # integrations that target the same host.
    if nethost.skipping(url)
        return nil
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
            logger.logMsg(logger.lWarn, f"shelly: GET '{url}' returned HTTP {status}")
            nethost.fail(url)
        end
    except .. as e
        logger.logMsg(logger.lWarn, f"shelly: GET '{url}' failed: {e}")
        nethost.fail(url)
    end
    if wc != nil wc.close() end
    return nil
end

def _post(url, payload)
    if nethost.skipping(url)
        return false
    end
    var wc = nil
    try
        wc = webclient()
        wc.begin(url)
        wc.add_header("Content-Type", "application/json")
        var status = wc.POST(payload)
        wc.close()
        if status == 200
            nethost.ok(url)
            return true
        end
        nethost.fail(url)
        return false
    except .. as e
        logger.logMsg(logger.lWarn, f"shelly: POST '{url}' failed: {e}")
        nethost.fail(url)
    end
    if wc != nil wc.close() end
    return false
end

# Returns ONLY the fetched fields — see the contract note in gplug.be.
def fetch_item(url, token, cfg)
    # Gen1: derive base URL from the "on" URL, then GET /status
    var url_status = url.find("status", nil)
    if url_status == nil return nil end

    var data = _get(url_status)
    if data == nil return nil end

    var result = {}

    var ison = data.find("ison", nil)
    if ison != nil
        result["state"] = ison ? "ACTIVE" : "INACTIVE"
    else
        # Support for simulator integration
        var state = data.find("state", nil)
        if state != nil
            result["state"] = state
        end
    end
    return result
end

def set_state(url, token, state)
    # Gen1: GET the on/off URL directly
    var target = (state == "ACTIVE") ? url.find("on", nil) : url.find("off", nil)
    if target == nil return false end
    # Support for simulator integration
    var url_status = url.find("status", nil)
    if string.find(url_status, "simulator") != nil
        simulator.set_state(url_status, token, state)
    end
    return _get(target) != nil
end

shelly.fetch_item = fetch_item
shelly.set_state  = set_state

return shelly
