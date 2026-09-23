# main.be — boot orchestration. load()'d (not import'd) by autoexec.be so the
# bare globals below live in the shared top-level scope (see autoexec.be).

import logger
import webservice
import udpdriver
import site
import ems
import store
import meter
import drivershim

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
        for key : ['loads', 'productions', 'grid']
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
# NOTE: no top-level `import vzev` (single biggest module, ~21 KB minified,
# only loaded when the site participates in a community — _vzev_wanted below)
# and no `import configservice` (~9 KB resident, only loaded on the first
# POST /api/config — the GET is served as a plain file stream by the stub).

# --- lazy vZEV loading (startup-heap issue #2) ------------------------------
# true once `import vzev` + vzev.start() have run; read by meter.be's
# slot-close hook (via the global module) to skip the announce hand-off on
# sites where vzev was never loaded.
_vzev_loaded = false
_vzev_stub_driver = nil

# Decide from /vzev.json alone (same path as vzev.be's VZEV_FILE) whether the
# vZEV backend should boot, WITHOUT importing the module. Mirrors
# vzev.get_info()'s 'enabled' semantics: an explicit info.enabled wins;
# otherwise a configured member list implies participation (pre-spec-009
# files). No/invalid file -> brand-new site -> off.
_vzev_wanted = def ()
    import json
    try
        var f = open('/vzev.json', 'r')
        var raw = f.read()
        f.close()
        var d = json.load(raw)
        if d == nil return false end
        var info = d.find('info', nil)
        if isinstance(info, map) && info.contains('enabled')
            var en = info['enabled']
            return en == true || en == 'true' || en == '1' || en == 1
        end
        return size(d.find('members', [])) > 0
    except ..
        return false
    end
end

# Import + start the real vZEV backend (one-time compile spike, then it owns
# its /api/vzev/* routes). The stub driver is removed so a webserver restart
# no longer re-registers the stub route; the already-registered stub handler
# stays harmless because it delegates once _vzev_loaded is set.
_start_vzev = def ()
    import vzev
    vzev.start()
    _vzev_loaded = true
    if _vzev_stub_driver != nil
        tasmota.remove_driver(_vzev_stub_driver)
        _vzev_stub_driver = nil
    end
end

# Stub /api/vzev/info handler, registered only when vzev is NOT loaded. Keeps
# the Einstellungen enable-toggle alive (frontend enables vZEV via
# GET /api/vzev/info?action=set&enabled=true — served by vzev itself, so a
# plain skip would make vZEV impossible to ever turn on). Any action=set
# loads the real module on the spot and lets it handle the request
# (validation + persistence); a plain GET answers from /vzev.json without
# touching the module. The other /api/vzev/* routes stay 404 while disabled —
# the frontend .catch()es them and hides the vZEV pages anyway.
_vzev_stub_info = def ()
    import webserver
    if !_vzev_loaded && webserver.has_arg('action') && webserver.arg('action') == 'set'
        _start_vzev()
    end
    if _vzev_loaded
        import vzev
        vzev.info_request()
        return
    end
    import json
    var info = {}
    try
        var f = open('/vzev.json', 'r')
        var raw = f.read()
        f.close()
        var d = json.load(raw)
        if d != nil
            var inf = d.find('info', nil)
            if isinstance(inf, map) info = inf end
        end
    except ..
    end
    var out = {
        'representative_name':    info.find('representative_name', ''),
        'representative_contact': info.find('representative_contact', ''),
        'connection_point_id':    info.find('connection_point_id', ''),
        'enabled': false
    }
    webserver.content_open(200, 'application/json')
    webserver.content_send(json.dump(out))
    webserver.content_close()
end

_vzev_stub_web = def ()
    try
        import webserver
        webserver.on('/api/vzev/info', /-> _vzev_stub_info(), webserver.HTTP_GET)
    except ..
    end
end

# --- lazy configservice (startup-heap issue #2) -----------------------------
# configservice costs ~9 KB resident but is only exercised from the settings
# page. GET /api/config streams site.json verbatim (FR-603) — the stub does
# that with a plain file read, no module needed. The module (validation +
# atomic write + rollback) is imported on the FIRST POST and owns the routes
# from then on; the stub keeps delegating for its already-registered handlers.
_config_loaded = false
_config_stub_driver = nil

_config_start = def ()
    import configservice
    configservice.start()
    _config_loaded = true
    if _config_stub_driver != nil
        tasmota.remove_driver(_config_stub_driver)
        _config_stub_driver = nil
    end
end

_config_stub_get = def ()
    if _config_loaded
        import configservice
        configservice.getrequest()
        return
    end
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

_config_stub_post = def ()
    # an uncaught exception here drops the socket with no response at all
    # (browser: ERR_EMPTY_RESPONSE / "Failed to fetch", issue #11) — answer
    # 500 with the error so the next failure names itself in the UI
    try
        if !_config_loaded
            _config_start()
        end
        import configservice
        configservice.postrequest()
    except .. as e, m
        logger.logMsg(logger.lWarn, f"ConfigService: POST failed: {e} {m}")
        import webserver
        import json
        webserver.content_open(500, 'application/json')
        webserver.content_send(json.dump({'error': f"{e} {m}"}))
        webserver.content_close()
    end
end

_config_stub_web = def ()
    try
        import webserver
        webserver.on('/api/config', /-> _config_stub_get(),  webserver.HTTP_GET)
        webserver.on('/api/config', /-> _config_stub_post(), webserver.HTTP_POST)
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
    # "always true": start_services() ran on the very first 5 s tick and
    # udpdriver.start() opened its multicast socket before association — the
    # hard fault documented at the boot gate below, inside Tasmota's 10 s
    # fast-reboot window.
    # Keep the ip check, but as a VALUE test, not a key test.
    if w.find("up", false) != true
        return false
    end
    var ip = w.find("ip", "")
    return type(ip) == "string" && size(ip) > 0 && ip != "0.0.0.0"
end

# Run one boot stage, logging (never propagating) a failure. A stage that
# raises used to abort the whole of start_services() with nothing but
# Tasmota's generic backtrace, so the later stages (store, vzev, meter) went
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

# Services that need an associated station (they open sockets). Split out of
# start_services() so an offline boot can bring up the local HTTP/EMS/metering
# stack and attach these later, instead of faulting the VM on a socket call.
_net_started = false
_start_net_services = nil
_start_net_services = def()
    if _net_started
        return
    end
    _net_started = true

    # UDP transport (joins the multicast group using the messaging config)
    _stage("udpdriver", /-> udpdriver.start())

    # vZEV community backend (spec 005): member registry, deterministic
    # allocation, 15-min slot exchange over the existing UDP multicast. Started
    # after udpdriver (it chains the receive callback, FR-508) and before the
    # meter, whose slot-close hook calls vzev.announce_slot().
    # LAZY (startup-heap issue #2): only imported when the site participates;
    # otherwise the tiny info stub is registered so vZEV can still be enabled.
    if _vzev_wanted()
        _stage("vzev", def()
            import vzev
            vzev.start()
            _vzev_loaded = true
        end)
    else
        _vzev_stub_driver = drivershim.make({'web_add_handler': _vzev_stub_web})
        tasmota.add_driver(_vzev_stub_driver)
        _vzev_stub_web()
        logger.logMsg(logger.lInfo, "vzev disabled: module not loaded (stub on /api/vzev/info)")
    end

    # Advertise this device's webservice URL over multicast — only when the
    # transport actually joined (no messaging.udp block -> UDP stays off, and
    # a send would just log "not started, cannot send")
    if !udpdriver.started()
        return
    end
    var w = tasmota.wifi()
    var ip = w != nil ? w.find("ip", "") : ""
    if type(ip) == "string" && size(ip) > 0 && ip != "0.0.0.0"
        udpdriver.send("http://" + ip + "/")
        logger.logMsg(logger.lInfo, "Advertised: http://" + ip + "/")
    end
end

# Poll for a late association on a device that booted offline, and attach the
# socket-owning services then. Costs one map lookup per 10 s until WiFi is up.
_net_watch = nil
_net_watch = def()
    if _net_started
        return
    end
    if _net_ready()
        _start_net_services()
    else
        tasmota.set_timer(10000, /-> _net_watch())
    end
end

# `net_up` is false only on the bounded-wait fallback below (no association
# after ~30 s). The socket-owning services are then deferred to _net_watch()
# instead of being started against a down station.
#
# Every stage runs under _stage(): one failing service must not take the rest
# of the boot with it, and the log has to name the stage that died.
start_services = def(net_up)
    # Start file service
    _stage("webservice", /-> webservice.start())

    # Config service (GET/POST /api/config, spec 006) — LAZY (issue #2):
    # the stub streams site.json on GET and imports the real module on the
    # first POST; no configservice bytecode in RAM until someone saves.
    _stage("configservice stub", def()
        _config_stub_driver = drivershim.make({'web_add_handler': _config_stub_web})
        tasmota.add_driver(_config_stub_driver)
        _config_stub_web()
        logger.logMsg(logger.lInfo, "ConfigService stub on /api/config (module loads on first POST)")
    end)

    # Load site configuration FIRST (builds loads/productions/grid item maps
    # from site.json; live values are filled lazily by the poll scheduler, no
    # boot fetch burst). Must precede udpdriver.start(), which reads the
    # messaging.udp config from the loaded site — otherwise the UDP multicast
    # transport never starts ("no messaging.udp config, not starting").
    _stage("site config", /-> site.load_config())

    # Start EMS driver: runs allocation every second AND advances the outbound
    # HTTP scheduler by one op per tick (integration reads + relay writes)
    _stage("ems", /-> ems.start())

    # Load persisted energy rings and start 10s metering
    _stage("store", /-> store.load())

    if net_up
        _start_net_services()
    else
        logger.logMsg(logger.lWarn,
            "boot: no WiFi association, UDP/vZEV deferred until the station comes up")
        _net_watch()
    end

    _stage("meter", /-> meter.start())

end

stop_services = def()
    # Stop file service
    webservice.stop()

    # Stop config service — only if the lazy stub ever loaded it
    if _config_loaded
        import configservice
        configservice.stop()
    end
    if _config_stub_driver != nil
        tasmota.remove_driver(_config_stub_driver)
        _config_stub_driver = nil
    end

    # Stop UDP transport — only if it was ever started.
    # _net_started stays true so a still-pending _net_watch() timer cannot
    # bring the sockets back up behind a shutdown.
    if _net_started
        udpdriver.stop()
    end

    # Stop EMS driver
    ems.stop()

    # Stop metering
    meter.stop()

    # Stop vZEV backend (persists peer data if dirty) — only if it was loaded
    if _vzev_loaded
        import vzev
        vzev.stop()
    end
    if _vzev_stub_driver != nil
        tasmota.remove_driver(_vzev_stub_driver)
        _vzev_stub_driver = nil
    end
end

# Boot gate: WiFi must be ASSOCIATED before the network services start.
#
# start_services() opens a UDP multicast socket (udpdriver.start ->
# udp.begin_multicast) and kicks off the vZEV announce loop + integration
# polling. Creating a socket before WiFi is associated hard-faults the Berry VM
# at boot (Guru Meditation / Load access fault — same failure site.be _net_ready
# guards the integration fetches against). On the ESP32-C3 that fault is a reset
# loop, which presents as "the device never connects to WiFi" whenever this
# .tapp is deployed.
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
        start_services(false)              # locals only; sockets follow later
    else
        tasmota.set_timer(1000, /-> _try_start())
    end
end

# First check after 5s (to ensure the tasmota module is loaded), then poll.
tasmota.set_timer(5000, /-> _try_start())
