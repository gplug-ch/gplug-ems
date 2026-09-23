var tasmota = module()

# controllable sensor JSON for tests: tasmota.set_sensors(<string>) before code
# under test calls tasmota.read_sensors() (used by gplug.read_z / GET /api/meter)
var _sensors = nil
tasmota.set_sensors = def(s)
    _sensors = s
end
tasmota.read_sensors = def()
    return _sensors
end

tasmota.add_cron = def()
end

tasmota.remove_cron = def()
end

tasmota.add_driver = def(d)
end

tasmota.remove_driver = def(d)
end

tasmota.set_timer = def(ms, f)
end

# no-op: modbustcp's bounded read-wait loop calls this between poll attempts;
# tests need it to return instantly, not actually sleep
tasmota.delay = def(ms)
end

# Mirrors the device: the map ALWAYS carries an `ip` key — "0.0.0.0" while the
# station is down. Code that gates on w.contains("ip") therefore sees "ready"
# on a down station, which is the boot-time hard fault _net_ready() guards
# against. Mutated in place (never reassigned) — see the Berry import upvalue
# caveat in integrations/nethost.be.
var _wifi = {'up': false, 'ip': '0.0.0.0'}
tasmota.wifi = def()
    return _wifi
end
# tests: tasmota.set_wifi(true) / set_wifi(false) / set_wifi(true, '10.0.0.9')
tasmota.set_wifi = def(up, ip)
    _wifi['up'] = up
    _wifi['ip'] = up ? (ip != nil ? ip : '192.168.1.50') : '0.0.0.0'
end

# controllable clock for tests: tasmota.set_utc(<epoch>) before code under
# test calls tasmota.rtc()
var _utc = 0
tasmota.set_utc = def(utc)
    _utc = utc
end
tasmota.rtc = def()
    return {'utc': _utc, 'local': _utc}
end

tasmota.wd = ''

return tasmota
