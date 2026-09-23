# Tests for the WiFi readiness gate (site.be _net_ready).
#
# Regression: the gate read `w.find("up", false) || w.contains("ip")`. Tasmota
# always puts an `ip` key in tasmota.wifi() — "0.0.0.0" while the station is
# down — so the second term was permanently true and the gate never gated.
# On the device that meant outbound webclient()/socket calls before
# association: Guru Meditation inside Tasmota's 7 s fast-reboot window, i.e. a
# boot loop reported as "FRC: Some settings have been reset".
#
# Run from the backend/ directory:
#   cd tests/netgate && berry -m ../.. test_net_gate.be
#
# Own directory because site.load_config() reads "site.json" from the CWD and
# this test needs pollable (integration-backed) items, which tests/site.json
# deliberately has none of.

import sys
sys.path().push('..')                  # tests/ — the tasmota stub
sys.path().push('../../integrations')

var _http = {'calls': 0}

class _WebclientStub
    def begin(url)
        _http['calls'] = _http['calls'] + 1
        return true
    end
    def add_header(k, v) end
    def GET() return 200 end
    def PUT(payload) return 200 end
    def POST(payload) return 200 end
    def get_string() return '{"currentPower":100}' end
    def close() end
end
webclient = _WebclientStub

import tasmota
# tests/site.be is a stub that shadows the real module on the CLI module path,
# so compile the real one by path (the file returns its module object).
var site = compile('../../site.be', 'file')()
import simulator
site.register_integration('simulator', simulator)

var passed = 0
def check(cond, msg)
    assert(cond, msg)
    passed += 1
end

site.load_config()

# --- station DOWN (but with the usual '0.0.0.0' ip key) --------------------
tasmota.set_wifi(false)
_http['calls'] = 0
var i = 0
while i < 20
    site.poll_step()
    i += 1
end
check(_http['calls'] == 0,
      f"no outbound HTTP may be attempted while WiFi is down, got {_http['calls']} calls")
print("Test 1 passed: down station with an ip key does not open the gate")

# --- station UP -------------------------------------------------------------
tasmota.set_wifi(true)
_http['calls'] = 0
i = 0
while i < 20
    site.poll_step()
    i += 1
end
check(_http['calls'] > 0, "the poll scheduler must fetch once the station is up")
print("Test 2 passed: gate opens on association")

# one op per tick is the whole point of the scheduler (ESP32-C3 heap)
tasmota.set_wifi(true)
_http['calls'] = 0
site.poll_step()
check(_http['calls'] <= 1, f"poll_step must fire at most one request, got {_http['calls']}")
print("Test 3 passed: still one outbound op per tick")

print(f"\n--- All net-gate tests passed ({passed} checks) ---")
