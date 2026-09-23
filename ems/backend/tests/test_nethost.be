# Tests for integrations/nethost.be — the per-host outbound-HTTP cool-off that
# keeps one unreachable integration host from stalling the single Berry thread
# on every poll. Run from the backend/ directory:
#   cd tests && berry -m .. test_nethost.be
#
# Focus: the cool-off window GROWS with consecutive failures (30 → 60 → … →
# capped at BACKOFF_MAX_S) and RESETS on the first success, so a permanently
# dead host is probed rarely instead of every 30 s.

# --- Tasmota stub: only rtc() is used (a controllable clock) -----------------
var _utc = 2000000000            # RTC-synced (> MIN_EPOCH)
class _TasmotaStub
    def rtc() return {'utc': _utc} end
end
tasmota = _TasmotaStub()

# nethost lives in backend/integrations/; add it to the module search path
# (the runner adds only backend/ via `-m ..`).
import sys
sys.path().push('../integrations')
import nethost

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

var U = 'http://10.0.0.1:9090/a'

# first failure -> 30 s window
nethost.ok(U)                    # clean slate
_utc = 2000000000
nethost.fail(U)
_utc = 2000000000 + 29
check(nethost.skipping(U), "within first 30 s window")
_utc = 2000000000 + 31
check(!nethost.skipping(U), "past first 30 s window")

# a second consecutive failure doubles the window to 60 s
_utc = 2000000000
nethost.fail(U)
_utc = 2000000000 + 59
check(nethost.skipping(U), "within 60 s window after 2nd fail")
_utc = 2000000000 + 61
check(!nethost.skipping(U), "past 60 s window")

# keep failing -> window caps at BACKOFF_MAX_S (600 s), never grows unbounded
_utc = 2000000000
nethost.fail(U)                  # 3 -> 120
nethost.fail(U)                  # 4 -> 240
nethost.fail(U)                  # 5 -> 480
nethost.fail(U)                  # 6 -> min(960, 600) = 600
_utc = 2000000000 + 599
check(nethost.skipping(U), "within capped 600 s window")
_utc = 2000000000 + 601
check(!nethost.skipping(U), "past capped 600 s window")

# a success resets the streak: the next failure starts back at 30 s, not 600
nethost.ok(U)
_utc = 2000000000
check(!nethost.skipping(U), "ok clears the cool-off")
nethost.fail(U)
_utc = 2000000000 + 29
check(nethost.skipping(U), "window is 30 s again after recovery")
_utc = 2000000000 + 31
check(!nethost.skipping(U), "not 600 s — the streak was reset by ok")

# cool-off is keyed by host: shared across paths, isolated across hosts
nethost.ok(U)
_utc = 2000000000
nethost.fail('http://10.0.0.1:9090/a')
check(nethost.skipping('http://10.0.0.1:9090/b'), "same host, other path shares cool-off")
check(!nethost.skipping('http://10.0.0.2:9090/a'), "different host is unaffected")

# an unsynced clock never skips and never records (correctness over latency)
nethost.ok('http://10.0.0.1:9090/a')
nethost.ok('http://10.0.0.2:9090/a')
_utc = 500000000                 # below MIN_EPOCH
nethost.fail(U)
check(!nethost.skipping(U), "no cool-off recorded while clock is unsynced")

print("")
print(f"--- All nethost tests passed ({passed} checks) ---")
