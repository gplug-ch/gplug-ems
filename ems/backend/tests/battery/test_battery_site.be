# Tests for the battery handling in the real site.be poll scheduler (issue #20):
#   * "soc_url" adds a sentinel pollable whose fetched value lands in the
#     item as "soc" — its own round-robin slot, one webclient per tick
#   * "invert" flips the fetched power sign for any integration
#   * a non-numeric Home Assistant state ("unavailable") reports nothing
#
# Run from the backend/ directory:
#   cd tests/battery && berry -m ../.. test_battery_site.be
#
# Own directory because site.load_config() reads "site.json" from the CWD.

import sys
sys.path().push('..')                  # tests/ — the tasmota stub
sys.path().push('../../integrations')

# canned Home Assistant states by entity url
var _http = {'calls': 0, 'url': nil, 'states': {
    'http://ha/api/states/sensor.speicher_leistung': '0.512',
    'http://ha/api/states/sensor.speicher_ladestand': '73.0',
    'http://ha/api/states/sensor.bat2_power': '1500'
}}

class _WebclientStub
    def begin(url)
        _http['calls'] = _http['calls'] + 1
        _http['url'] = url
        return true
    end
    def add_header(k, v) end
    def GET() return 200 end
    def get_string() return '{"state":"' + _http['states'][_http['url']] + '"}' end
    def close() end
end
webclient = _WebclientStub

import tasmota
# tests/site.be is a stub that shadows the real module on the CLI module path,
# so compile the real one by path (the file returns its module object).
var site = compile('../../site.be', 'file')()
import homeassistant
site.register_integration('homeassistant', homeassistant)

var passed = 0
def check(cond, msg)
    assert(cond, msg)
    passed += 1
end

def by_id(id)
    for p : site.get_productions_cached()
        if p['id'] == id return p end
    end
    return nil
end

def poll_round()
    var i = 0
    while i < 3                       # bat-1, its SoC sentinel, bat-2
        _http['calls'] = 0
        site.poll_step()
        check(_http['calls'] <= 1, "poll_step must fire at most one request")
        i += 1
    end
end

tasmota.set_wifi(true)
site.load_config()
poll_round()

var b1 = by_id('bat-1')
var b2 = by_id('bat-2')
check(b1['currentPower'] == 512, f"bat-1 power: expected 512 W, got {b1.find('currentPower')}")
check(b1['soc'] == 73, f"bat-1 soc: expected 73, got {b1.find('soc')}")
check(size(site.get_productions_cached()) == 2, "the SoC sentinel must not show up as a production")
print("Test 1 passed: soc_url sentinel fills soc, one request per tick")

check(b2['currentPower'] == -1500, f"bat-2 invert: expected -1500 W, got {b2.find('currentPower')}")
check(!b2.contains('soc'), "bat-2 has no SoC source")
print("Test 2 passed: invert flips the fetched power sign")

# HA entity goes unavailable: the last values stay, no fake zero
_http['states']['http://ha/api/states/sensor.speicher_leistung'] = 'unavailable'
_http['states']['http://ha/api/states/sensor.speicher_ladestand'] = 'unknown'
poll_round()
check(b1['currentPower'] == 512 && b1['soc'] == 73,
      f"unavailable HA states must not overwrite with 0, got {b1.find('currentPower')} / {b1.find('soc')}")
print("Test 3 passed: non-numeric HA states report nothing")

# an implausible SoC (> 100 %) is dropped
_http['states']['http://ha/api/states/sensor.speicher_ladestand'] = '250'
poll_round()
check(b1['soc'] == 73, f"SoC 250 must be ignored, got {b1.find('soc')}")
print("Test 4 passed: out-of-range SoC ignored")

print(f"\n--- All battery site tests passed ({passed} checks) ---")
