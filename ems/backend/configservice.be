# configservice.be — read/write of the own site config (spec 006 FR-601):
#   GET  /api/config   returns the full site.json (incl. tariffs) for editing
#   POST /api/config   writes site.json, then reloads
#
# Spec 011 step 2 (FR-1127) deleted the device-side validator: the browser
# owns every field rule (einstellungen.js validateDocument/validate*), so the
# only checks left here are the two the device alone can make — the body must
# be parseable JSON (400) and site.load_config() must accept the result (500 +
# rollback). A document with, say, an ftp:// url is now stored and fails at
# poll time like an unreachable host (spec 011 UC-1105).
#
# The full document is round-tripped verbatim so the frontend never loses keys
# (FR-603 forward compatibility). The body is written to site.json.new first
# and then copied over site.json (see _rename — not power-loss-atomic, see
# its comment for why). Tasmota's embedded Berry has no `os` module (only the
# Berry CLI does, and it lacks Tasmota's `path` module), so _has_path() /
# _remove_file() pick whichever is actually available at runtime. If the
# reloaded config fails to load, the previous file is restored and HTTP 500
# is returned.
#
# `webserver` is imported lazily inside the handler functions so this module
# stays loadable in the Berry CLI for tests.

var configservice = module()

import strict
import string
import json
import logger
import drivershim
# `site` is imported lazily (see _get_site) so this module loads in the Berry
# CLI without pulling in the integration modules the real site.be requires.

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
# INVARIANT: 'file' must match the path site.be:load_config() reads
# ('site.json'), otherwise save() would write one file and reload
# another. set_file() is only for tests pointing at a temp file.
var _s = {
    'file': 'site.json',            # live config path (injectable for tests)
    'file_new': 'site.json.new',    # temp path used for the atomic write
    'site': nil                     # site module (injectable for tests)
}

# lazily resolve the real site module unless a test injected one
def _get_site()
    if _s['site'] == nil
        import site
        _s['site'] = site
    end
    return _s['site']
end

# path injection so tests can point at a temp file
def set_file(p)
    _s['file'] = p
    _s['file_new'] = p + '.new'
end

def get_file()
    return _s['file']
end

# site module injection so tests can supply a controllable reload target
def set_site(mod)
    _s['site'] = mod
end

# ---------------------------------------------------------------------

def _read_file(path)
    var f = open(path, 'r')
    var raw = f.read()
    f.close()
    return raw
end

def _write_file(path, content)
    var f = open(path, 'w')
    f.write(content)
    f.close()
end

# Tasmota's embedded Berry has no `os` module (`import os` always raises
# import_error — confirmed on-device: this is why the config save
# silently never overwrote site.json). The Berry CLI (used by `make
# test`), conversely, does not have Tasmota's `path` module. Detect once
# at runtime and use whichever is actually available.
def _has_path()
    try
        import path
        return true
    except ..
        return false
    end
end

def _remove_file(f)
    if _has_path()
        import path
        try path.remove(f) except .. end
    else
        import os
        try os.remove(f) except .. end
    end
end

def _rename(from, to)
    # `path.rename()` was tried on-device and reliably returns false (the
    # config save then errored out with `to` left deleted and `from`
    # untouched) — its exact failure mode on this LittleFS build is
    # unclear, so it is not used. Copy-then-remove instead, built only
    # from primitives confirmed working on-device: path.remove() (used
    # to delete the old site.json successfully) and open(path, 'w') on a
    # not-yet-existing path (used to create site.json.new successfully).
    # Not power-loss-atomic, but reliable.
    var raw = _read_file(from)
    _remove_file(to)
    _write_file(to, raw)
    _remove_file(from)
end

def _cleanup_new()
    _remove_file(_s['file_new'])
end

# Core POST logic split from the web layer so tests exercise it directly.
# Returns [http_code, json_body_string].
def save(body)
    var cfg = nil
    try
        cfg = json.load(body)
    except .. as e, m
        return [400, '{"error":"invalid json"}']
    end
    # a body that is not a JSON object is not a config (spec 011 FR-1127) —
    # the only shape check the device still makes
    if !isinstance(cfg, map)
        return [400, '{"error":"invalid json"}']
    end

    # snapshot the current file so we can roll back on a failed reload
    var backup = nil
    try
        backup = _read_file(_s['file'])
    except ..
        backup = nil
    end

    # atomic write: write temp file, then rename over the live file
    try
        _write_file(_s['file_new'], body)
        _rename(_s['file_new'], _s['file'])
    except .. as e, m
        logger.logMsg(logger.lWarn, f"ConfigService: write failed: {e} {m}")
        _cleanup_new()
        return [500, '{"error":"write failed"}']
    end

    # reload; if the new config does not load, restore the previous file
    var s = _get_site()
    s.load_config()
    if s.get_site() == nil
        logger.logMsg(logger.lWarn, "ConfigService: reloaded config invalid, restoring")
        if backup != nil
            # restore the previous good file
            try
                _write_file(_s['file'], backup)
                s.load_config()
            except ..
            end
        else
            # no previous file (first-ever save): remove the just-written
            # invalid config so a corrupt file never persists (NFR-601)
            _remove_file(_s['file'])
        end
        return [500, '{"error":"config rejected"}']
    end

    return [200, '{"saved":true}']
end

def getrequest()
    import webserver
    var raw = nil
    try
        raw = _read_file(_s['file'])
    except .. as e, m
        logger.logMsg(logger.lWarn, f"ConfigService: cannot read '{_s['file']}': {e} {m}")
        webserver.content_open(404, 'application/json')
        webserver.content_send('{"error":"config not found"}')
        webserver.content_close()
        return
    end
    # stream the raw file verbatim — no re-serialize, so unknown keys and
    # ordering survive the round-trip (FR-603)
    webserver.content_open(200, 'application/json')
    webserver.content_send(raw)
    webserver.content_close()
end

def postrequest()
    import webserver
    # Tasmota's ESP webserver exposes a raw (non-form) request body under
    # the special arg name "plain"; accept "data" too for robustness
    # across builds/proxies.
    var body = ''
    if webserver.has_arg('plain')
        body = webserver.arg('plain')
    elif webserver.has_arg('data')
        body = webserver.arg('data')
    end
    var res = save(body)
    webserver.content_open(res[0], 'application/json')
    webserver.content_send(res[1])
    webserver.content_close()
end

def web_add_handler()
    import webserver
    webserver.on('/api/config', /-> getrequest(),  webserver.HTTP_GET)
    webserver.on('/api/config', /-> postrequest(), webserver.HTTP_POST)
end

def start()
    if tasmota.wifi()['up']
        web_add_handler()
    end
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, "ConfigService started (/api/config)")
end

def stop()
    tasmota.remove_driver(_driver)
    logger.logMsg(logger.lInfo, "ConfigService stopped")
end

def save_before_restart()
    stop()
end

_driver = drivershim.make({
    'web_add_handler': web_add_handler,
    'save_before_restart': save_before_restart
})

configservice.start    = start
configservice.stop     = stop
# request handlers exported so main.be's lazy /api/config stub can delegate
# to them once the module is loaded on demand (startup-heap issue #2)
configservice.getrequest  = getrequest
configservice.postrequest = postrequest
configservice.save     = save
configservice.set_file = set_file
configservice.get_file = get_file
configservice.set_site = set_site

return configservice
