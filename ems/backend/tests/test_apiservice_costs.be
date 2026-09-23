# Tests for site.get_tariffs (spec 001 FR-107 defaults/merge).
#
# Energy-COST derivation (FR-108) moved to the browser (frontend
# lib/aggregate.js:deriveCosts) — the device streams raw Wh records only and no
# longer computes CHF, so there is nothing to test here for costs. The tariff
# defaults/merge still live on the device (served via /api/meta) and are the
# input the browser derives from, so they stay covered here.
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_apiservice_costs.be

# Stub for the Tasmota built-in webclient class (site.be integrations need it)
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

# Load the functional Tasmota stub (tests/tasmota.be) as a global so
# site.be resolves the ambient `tasmota` built-in under 'import strict'.
import tasmota

import site

def approx(a, b)
    if a == nil || b == nil
        return a == b
    end
    return a - b < 0.0001 && b - a < 0.0001
end

# ---------------------------------------------------------------------------
# Test 1: tariff defaults (tests/site.json has no "tariffs" key -> defaults)
# ---------------------------------------------------------------------------
site.load_config()
var t = site.get_tariffs()
assert(approx(t['grid_import_chf_kwh'], 0.26), "default import tariff wrong")
assert(approx(t['grid_feedin_chf_kwh'], 0.18), "default feed-in tariff wrong")
assert(approx(t['base_fee_chf_month'], 12.5), "default base fee wrong")
assert(approx(t['vzev_export_chf_kwh'], 0.22), "default vzev export tariff wrong")
assert(approx(t['vzev_import_chf_kwh'], 0.22), "default vzev import tariff wrong")
print("Test 1 passed: tariff defaults for config without tariffs key")

print("")
print("--- All tariff tests passed ---")
