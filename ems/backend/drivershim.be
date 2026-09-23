# drivershim.be — bridge between the functional modules and Tasmota's driver
# registry. tasmota.add_driver() REQUIRES a class instance ('value_error -
# instance required' on-device), so a module cannot register itself. The shim
# is a minimal instance whose members hold the module's hook FUNCTIONS in
# instance variables: tasmota.event() looks hooks up via introspect.get(d,
# event_type) — which returns instance-var values just like methods — and
# calls f(d, cmd, idx, payload, raw); Berry drops the excess arguments on the
# modules' zero-arg hook functions. Class methods cannot capture the enclosing
# scope in Berry, so storing the functions in vars is what lets ONE generic
# shim delegate to any module.

var drivershim = module()

import strict

# hook names tasmota.event() dispatches on this project's drivers; absent
# hooks stay nil and are skipped by the dispatcher's type(f)=='function' check
class Shim
    var every_second
    var every_250ms
    var web_add_handler
    var save_before_restart

    def init(hooks)
        self.every_second        = hooks.find('every_second')
        self.every_250ms         = hooks.find('every_250ms')
        self.web_add_handler     = hooks.find('web_add_handler')
        self.save_before_restart = hooks.find('save_before_restart')
    end
end

drivershim.make = def(hooks) return Shim(hooks) end

return drivershim
