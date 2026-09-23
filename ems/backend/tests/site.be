# Minimal site stub for Berry CLI testing.
# Shadows the real site.be (which imports integrations requiring the Tasmota
# built-in 'tasmota' global that is unavailable in the Berry CLI).
# Provides only the interface that ems.be needs for allocation testing.

var site = module()
import strict
import json
import logger

class SiteStub
    static STATE_INACTIVE = 'inactive'
    static STATE_WAITING  = 'waiting'
    static STATE_ACTIVE   = 'active'

    # mirror the real site.be tariff defaults (spec 001 FR-107) so the cost
    # test can exercise get_tariffs() without pulling in the integrations
    static TARIFF_DEFAULTS = {
        'grid_import_chf_kwh': 0.26,
        'grid_feedin_chf_kwh': 0.18,
        'base_fee_chf_month': 12.5,
        'vzev_export_chf_kwh': 0.22,
        'vzev_import_chf_kwh': 0.22
    }

    var loads
    var productions
    var _tariffs

    def init()
        self.loads = []
        self.productions = []
        self._tariffs = {}
    end

    def load_config()
        try
            var f = open("site.json", "r")
            var config = json.load(f.read())
            f.close()
            self.loads = config.find("loads", [])
            self.productions = config.find("productions", [])
            self._tariffs = config.find("tariffs", {})
        except .. as e
            logger.logMsg(logger.lWarn, f"SiteStub: cannot read site.json: {e}")
        end
    end

    # configured tariffs merged over defaults (matches site.be get_tariffs)
    def get_tariffs()
        var t = {}
        for k: SiteStub.TARIFF_DEFAULTS.keys()
            t[k] = SiteStub.TARIFF_DEFAULTS[k]
        end
        if self._tariffs != nil
            for k: self._tariffs.keys()
                t[k] = self._tariffs[k]
            end
        end
        return t
    end

    def get_loads()
        return self.loads
    end

    def get_load_by_id(id)
        for load: self.loads
            if load["id"] == id
                return load
            end
        end
        return nil
    end

    def set_load_state(id, state)
        var load = self.get_load_by_id(id)
        if load == nil
            return nil
        end
        load["state"] = state
        return load
    end

    def get_productions()
        return self.productions
    end

    # cached getters mirror the real site.be: allocation reads these so the
    # per-second path never triggers integration fetches
    def get_loads_cached()
        return self.loads
    end

    def get_productions_cached()
        return self.productions
    end

    def get_grid_cached()
        return []
    end

end

var _instance = SiteStub()

site.STATE_INACTIVE = SiteStub.STATE_INACTIVE
site.STATE_WAITING  = SiteStub.STATE_WAITING
site.STATE_ACTIVE   = SiteStub.STATE_ACTIVE

site.load_config     = def() _instance.load_config() end
site.get_tariffs     = def() return _instance.get_tariffs() end
site.get_loads       = def() return _instance.get_loads() end
site.get_load_by_id  = def(id) return _instance.get_load_by_id(id) end
site.set_load_state  = def(id, state) return _instance.set_load_state(id, state) end
site.get_productions        = def() return _instance.get_productions() end
site.get_loads_cached       = def() return _instance.get_loads_cached() end
site.get_productions_cached = def() return _instance.get_productions_cached() end
site.get_grid_cached        = def() return _instance.get_grid_cached() end
# serving guard / meter cache: no-ops here, but every webservice handler calls
# them, so the stub must answer or the handler tests throw
site.note_serving           = def() end
site.serving_recent         = def() return false end
site.get_meter_cached       = def() return nil end

return site
