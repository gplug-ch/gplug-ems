import sys
import global

# The working directory (the .tapp mount, e.g. "/ems-vX.tapp#") is only valid
# during boot — tasmota.wd is empty later. Capture it now and stash it in a
# global so request handlers (webservice file serving, version/lang readers)
# can open bundled files as `wd + name` at any time. Reading tasmota.wd live at
# request time is what made GET /fs?name=index.html 404 ("file not found").
var wd = tasmota.wd
global._tapp_wd = wd

# Also add it to sys.path so the module graph imported by main.be resolves the
# bundled Berry files — at boot AND later: the deferred load below imports the
# whole graph long after tasmota.wd has been cleared, and it resolves fine as
# long as this push happened (verified on-device 2026-09-07). Tasmota's load()
# pops one copy of the prefix after autoexec and another after main.be, so
# _b['load'] re-pushes it once main.be has returned (issue #11).
if size(wd) sys.path().push(wd) end

# Boot the application by load()'ing ONLY main.be. main.be then `import`s the
# whole module graph (webservice, site -> integrations, ems, store, meter,
# configservice, ...), so every module
# is built exactly ONCE via the import cache.
#
# The previous version load()'d every module explicitly AND main.be import'd
# them again — but Tasmota's load() does not populate the import cache, so each
# module was COMPILED AND EXECUTED TWICE at boot. On the ESP32-C3 that doubled
# the transient boot heap and fragmented it right when the WiFi stack needs a
# contiguous block to associate, which showed up as the device never connecting
# to WiFi (and a reset loop) once this .tapp was deployed.
#
# main.be is load()'d (not import'd) on purpose: load() runs it in the
# non-strict top-level scope it needs for its bare `start_services`/timer
# globals. The imported modules opt into strict themselves and are unaffected.
#
# --- WiFi gate (boot-heap race, 2026-09-07) --------------------------------
# Even a SINGLE compile of the graph (~68 KB of heap, plus parser transients)
# at the first tick overlaps WiFi association, DHCP, MQTT and NTP on the
# ESP32-C3. When the margin is gone a failed allocation in that window ends in
# a hard fault ("Exception 5 Load access fault") ~1.5 s after power-up, three
# boots in a row, and Tasmota's boot-loop protection then disables Berry and
# the meter script ("FRC: Some settings have been reset (4)"). The same .tapp
# loaded 20 s later boots and runs. So: do not compile until the station is
# up, then give the network stack a few seconds to finish its own allocations.
# Bounded so an offline device still boots its local services (main.be has its
# own net gate for the socket-owning stages).
#
# State lives in one in-place-mutated map; the tick closure re-arms itself via
# the map entry (see CLAUDE.md "Module pattern" for the upvalue caveat).
var BOOT_MAX_WAIT_S = 30      # give up waiting for WiFi after ~30 s
var BOOT_SETTLE_MS  = 5000    # DHCP/MQTT/NTP allocations right after association

var _b = {'tries': 0, 'wd': wd}

_b['wifi_up'] = def ()
    var w = tasmota.wifi()
    return w != nil && w.find('up', false) == true
end

_b['load'] = def ()
    var m = tasmota.memory()
    print(f"boot: loading main.be (heap {m.find('heap_free', '?')} KB)")
    if !load(_b['wd'] + "main.be")
        print("ERROR: Failed to load main.be")
    end
    # Tasmota's load() push_path()es the archive prefix (a no-op, it is
    # already there) and pop_path()s it by VALUE when main.be returns — which
    # removes our own entry, since this autoexec's load() already popped the
    # other one. From then on every request-time import (the lazy
    # `import configservice` on the first POST /api/config) failed with "module 'configservice' not found" and the handler
    # died without a response (issue #11). Put the prefix back for good.
    import sys
    var wd = _b['wd']
    if size(wd) && sys.path().find(wd) == nil
        sys.path().push(wd)
    end
end

_b['tick'] = def ()
    _b['tries'] += 1
    if _b['wifi_up']()
        tasmota.set_timer(BOOT_SETTLE_MS, _b['load'])
    elif _b['tries'] >= BOOT_MAX_WAIT_S
        print(f"boot: WiFi not up after {_b['tries']} s, loading main.be anyway")
        _b['load']()
    else
        tasmota.set_timer(1000, _b['tick'])
    end
end

tasmota.set_timer(1000, _b['tick'])
