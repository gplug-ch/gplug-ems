# main.be — boot orchestration. load()'d (not import'd) by autoexec.be so the
# bare globals below live in the shared top-level scope (see autoexec.be).

import logger
import webservice
import site
import ems
import store
import meter
import drivershim
import fsx

# --- integration modules: configured types only (startup-heap issue #2) -----
# site.be no longer imports all four statically. The imports MUST happen HERE,
# at autoexec time: a .tapp module only resolves while the working directory
# is valid (same constraint webservice.be's _tapp_wd works around), so an
# import from the first poll tick fails with "module 'homeassistant' not
# found". Scan site.json for the types in use and register those with site.be.
_load_integrations = def ()
    import json
    var names = {}
    try
        var f = open('site.json', 'r')
        var cfg = json.load(f.read())
        f.close()
        if cfg == nil return end
        for key : ['loads', 'productions', 'grid', 'modbusRegisters']
            var arr = cfg.find(key, nil)
            if isinstance(arr, list)
                for item : arr
                    if isinstance(item, map)
                        var n = item.find('integration', nil)
                        if type(n) == 'string' names[n] = true end
                    end
                end
            end
        end
        # optional dev smart-meter source (spec 007)
        var m = cfg.find('meter', nil)
        if isinstance(m, map)
            var n = m.find('integration', nil)
            if type(n) == 'string' names[n] = true end
        end
    except .. as e
        logger.logMsg(logger.lWarn, f"boot: cannot scan site.json for integrations: {e}")
        return
    end
    for n : names.keys()
        try
            if n == 'homeassistant'
                import homeassistant
                site.register_integration(n, homeassistant)
            elif n == 'simulator'
                import simulator
                site.register_integration(n, simulator)
            elif n == 'gplug'
                import gplug
                site.register_integration(n, gplug)
            elif n == 'shelly'
                import shelly
                site.register_integration(n, shelly)
            elif n == 'modbustcp'
                import modbustcp
                site.register_integration(n, modbustcp)
            else
                # site.be already warns per use for an unknown type
                logger.logMsg(logger.lDebug, f"boot: unknown integration '{n}' in site.json")
            end
        except .. as e
            logger.logMsg(logger.lWarn, f"boot: integration '{n}' failed to load: {e}")
        end
    end
end
_load_integrations()
# NOTE: no top-level `import configservice` / `import modbusservice`: both
# are compiled per request and dropped (see _transient_call below).

# --- transient request services (issue #27, startup-heap issue #2) ----------
# configservice (~9 KB) and modbusservice (+ modbustcp when no item uses it)
# only serve the Einstellungen page. They used to be `import`ed lazily on the
# first request — but Berry never evicts a module from its import cache, so
# that only DEFERRED the cost: after one save or one manual Modbus read the
# bytecode stayed resident until the next restart. Now each request compiles
# the module afresh (fsx.load_transient), calls one handler and drops it; a
# gc() afterwards returns the heap to where it was. The compile is the same
# transient peak the first import used to pay, once per user click.
#
# An uncaught exception in a handler drops the socket with no response at all
# (browser: ERR_EMPTY_RESPONSE / "Failed to fetch", issue #11) — answer 500
# with the error so the failure names itself in the UI.
_transient_call = def (name, handler)
    var before = tasmota.gc()
    try
        import introspect
        var mod = fsx.load_transient(name)
        introspect.get(mod, handler)()
        mod = nil
    except .. as e, msg
        logger.logMsg(logger.lWarn, f"{name}: {handler} failed: {e} {msg}")
        import webserver
        import json
        webserver.content_open(500, 'application/json')
        webserver.content_send(json.dump({'error': f"{e} {msg}"}))
        webserver.content_close()
    end
    var after = tasmota.gc()
    logger.logMsg(logger.lDebug, f"{name}: {handler} heap {before} -> {after}")
end

# GET /api/config streams site.json verbatim (FR-603) with a plain file read,
# no module needed; only POST (validation + write + rollback) compiles
# configservice.
_config_stub_driver = nil

_config_stub_get = def ()
    import webserver
    try
        # same path configservice._s['file'] uses (see its INVARIANT comment)
        var f = open('site.json', 'r')
        var raw = f.read()
        f.close()
        webserver.content_open(200, 'application/json')
        webserver.content_send(raw)
        webserver.content_close()
    except ..
        webserver.content_open(404, 'application/json')
        webserver.content_send('{"error":"config not found"}')
        webserver.content_close()
    end
end

_config_stub_web = def ()
    try
        import webserver
        webserver.on('/api/config', /-> _config_stub_get(), webserver.HTTP_GET)
        webserver.on('/api/config', /-> _transient_call('configservice', 'postrequest'),
                     webserver.HTTP_POST)
    except ..
    end
end

# Manual Modbus register read/write for the Einstellungen test panel (issue
# #20). The driver re-registers the routes on a web restart.
_modbus_stub_driver = nil

_modbus_stub_web = def ()
    try
        import webserver
        webserver.on('/api/modbus/read', /-> _transient_call('modbusservice', 'readrequest'),
                     webserver.HTTP_GET)
        webserver.on('/api/modbus/write', /-> _transient_call('modbusservice', 'writerequest'),
                     webserver.HTTP_POST)
    except ..
    end
end

_net_ready = def()
    var w = tasmota.wifi()
    if w == nil
        return false
    end
    # `up` is the only authoritative flag. The old test also accepted
    # w.contains("ip"), but Tasmota puts an `ip` key in the map even while the
    # station is DOWN (it reads "0.0.0.0"), so the whole gate degraded to
    # "always true": start_services() ran on the very first 5 s tick, before
    # association — the hard fault documented at the boot gate below, inside
    # Tasmota's 10 s fast-reboot window.
    # Keep the ip check, but as a VALUE test, not a key test.
    if w.find("up", false) != true
        return false
    end
    var ip = w.find("ip", "")
    return type(ip) == "string" && size(ip) > 0 && ip != "0.0.0.0"
end

# Run one boot stage, logging (never propagating) a failure. A stage that
# raises used to abort the whole of start_services() with nothing but
# Tasmota's generic backtrace, so the later stages (store, meter) went
# missing with no hint of which one died.
_stage = def(name, fn)
    try
        fn()
        return true
    except .. as e, m
        logger.logMsg(logger.lWarn, f"boot: stage '{name}' failed: {e} {m}")
        return false
    end
end

# `net_up` is false only on the bounded-wait fallback below (no association
# after ~30 s). Nothing here opens a socket itself — the integration polls are
# guarded by site.be's own _net_ready — so the local stack starts either way.
#
# Every stage runs under _stage(): one failing service must not take the rest
# of the boot with it, and the log has to name the stage that died.
start_services = def(net_up)
    # Start file service
    _stage("webservice", /-> webservice.start())

    # Config service (GET/POST /api/config, spec 006) — TRANSIENT (issue
    # #27): the stub streams site.json on GET and compiles configservice for
    # each POST only; its bytecode is never resident.
    _stage("configservice stub", def()
        _config_stub_driver = drivershim.make({'web_add_handler': _config_stub_web})
        tasmota.add_driver(_config_stub_driver)
        _config_stub_web()
        logger.logMsg(logger.lInfo, "ConfigService stub on /api/config (module compiled per POST)")
    end)

    # Manual Modbus read/write (issue #20) — TRANSIENT like configservice
    _stage("modbusservice stub", def()
        _modbus_stub_driver = drivershim.make({'web_add_handler': _modbus_stub_web})
        tasmota.add_driver(_modbus_stub_driver)
        _modbus_stub_web()
    end)

    # Load site configuration FIRST (builds loads/productions/grid item maps
    # from site.json; live values are filled lazily by the poll scheduler, no
    # boot fetch burst).
    _stage("site config", /-> site.load_config())

    # Start EMS driver: runs allocation every second AND advances the outbound
    # HTTP scheduler by one op per tick (integration reads + relay writes)
    _stage("ems", /-> ems.start())

    # Load persisted energy rings and start 10s metering
    _stage("store", /-> store.load())

    if !net_up
        logger.logMsg(logger.lWarn,
            "boot: no WiFi association, integration polls wait for the station")
    end

    _stage("meter", /-> meter.start())

end

stop_services = def()
    # Stop file service
    webservice.stop()

    if _config_stub_driver != nil
        tasmota.remove_driver(_config_stub_driver)
        _config_stub_driver = nil
    end

    if _modbus_stub_driver != nil
        tasmota.remove_driver(_modbus_stub_driver)
        _modbus_stub_driver = nil
    end

    # Stop EMS driver
    ems.stop()

    # Stop metering
    meter.stop()
end

# Boot gate: wait for WiFi to be ASSOCIATED before the services start.
#
# start_services() kicks off integration polling. Opening a socket before WiFi
# is associated hard-faults the Berry VM at boot (Guru Meditation / Load access
# fault — the failure site.be _net_ready guards the integration fetches
# against). On the ESP32-C3 that fault is a reset loop, which presents as "the
# device never connects to WiFi" whenever this .tapp is deployed.
#
# A blind fixed delay is unsafe: the more Berry the boot compiles, the later
# association completes, so the timer began firing before WiFi was up reliably.
# Instead poll for readiness and only then start. Fall back after a bounded wait
# so a device with no network still boots its local (net-guarded) services.
_boot_tries = 0
# forward-declare so the recursive `/-> _try_start()` reschedule below resolves
# to the global (Berry registers the name at this assignment, before the def
# body that references it is compiled)
_try_start = nil
_try_start = def()
    _boot_tries += 1
    if _net_ready()
        start_services(true)
    elif _boot_tries >= 30                 # give up waiting after ~30 s
        start_services(false)              # boot anyway; polls wait for WiFi
    else
        tasmota.set_timer(1000, /-> _try_start())
    end
end

# First check after 5s (to ensure the tasmota module is loaded), then poll.
tasmota.set_timer(5000, /-> _try_start())
