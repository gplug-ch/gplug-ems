# nethost.be — per-host outbound-HTTP backoff shared by all integrations.
#
# The webclient() default connect timeout (~9 s) CANNOT be lowered on this
# ESP32 firmware build — wc.set_timeouts() hard-faults (Guru Meditation / Load
# access fault). So every GET/PUT to an UNREACHABLE host blocks the single
# Berry thread for the full timeout. Because the poll scheduler and the relay
# writes share that one thread with the webserver, a dead integration host
# stalls the HTTP server for ~9 s at a time — long enough that the browser
# cannot fetch index.html and the UI never loads.
#
# Fix: after a request to a host FAILS, skip that host entirely (no webclient
# is even created) for a cool-off window. At most one blocking probe per host
# per window; between probes the webserver stays responsive. The state is
# shared across integrations on purpose — loads (shelly), productions and grid
# (simulator) frequently target the SAME simulator host, so one failure should
# suppress the redundant probes from the others too.
#
# The window GROWS with each consecutive failure (BACKOFF_S, then doubling up to
# BACKOFF_MAX_S) and resets on the first success. A host that is briefly down
# recovers within ~BACKOFF_S; a host that is gone for good ends up probed only
# once every BACKOFF_MAX_S, so the unavoidable ~9 s connect-timeout stall (the
# firmware won't let us shorten it) happens rarely instead of every 30 s.

var nethost = module()
import string

var BACKOFF_S = 30            # cool-off after the FIRST failure
var BACKOFF_MAX_S = 600       # cap for a persistently-dead host (10 min)
var MIN_EPOCH = 1000000000    # RTC considered synced above this

# Module-private state: ONE map, mutated in place only. Never reassign a
# top-level var from inside a function — under Berry 1.1.0 `import` each
# closure gets its OWN upvalue box, so such writes are invisible to the other
# functions (verified in the CLI; `compile()()` shares, `import` does not).
var _s = {
    'backoff': {},            # host -> earliest-retry epoch
    'fails': {}               # host -> consecutive-failure count
}

# "host:port" from "http://host:port/path"; falls back to the whole url
def _host(url)
    if url == nil return "" end
    var parts = string.split(url, "/")
    if size(parts) >= 3 return parts[2] end
    return url
end

def _now()
    var r = tasmota.rtc()
    if r == nil return 0 end
    return r.find('utc', 0)
end

# true while the url's host is inside its cool-off window. Without a synced
# clock we never skip (can't measure the window) — correctness over latency.
def skipping(url)
    var now = _now()
    if now < MIN_EPOCH return false end
    return now < _s['backoff'].find(_host(url), 0)
end

def fail(url)
    var now = _now()
    if now < MIN_EPOCH
        return
    end
    var h = _host(url)
    var f = _s['fails'].find(h, 0) + 1
    _s['fails'][h] = f
    # exponential growth capped at BACKOFF_MAX_S: 30, 60, 120, 240, 480, 600…
    var win = BACKOFF_S
    var k = 1
    while k < f && win < BACKOFF_MAX_S
        win = win * 2
        k += 1
    end
    if win > BACKOFF_MAX_S
        win = BACKOFF_MAX_S
    end
    _s['backoff'][h] = now + win
end

def ok(url)
    var h = _host(url)
    if _s['backoff'].contains(h)
        _s['backoff'].remove(h)
    end
    if _s['fails'].contains(h)
        _s['fails'].remove(h)
    end
end

nethost.skipping = skipping
nethost.fail     = fail
nethost.ok       = ok

return nethost
