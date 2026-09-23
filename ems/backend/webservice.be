var webservice = module()

import strict
import webserver
import string
import logger
import json
import site
import ems
import store
import meter
import gplug
import drivershim

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

var mime =
{'css':'text/css','csv':'text/csv', 'html':'text/html','htm':'text/html', 'json':'application/json', 'js':'application/javascript',
'pdf':'application/pdf','txt':'text/plain', 'xml':'application/xml','ico':'image/x-icon',
'tapp':'application/zip', 'gif':'image/gif','jpg':'image/jpeg','png':'.png','svg':'image/svg+xml'}

var defaultMime = 'text/html'
var defaultExtension = 'txt'

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    'wd': ''             # captured .tapp working dir (set below) for opening bundled files
}

# Capture the .tapp working dir at module load (during boot, while
# tasmota.wd is still valid). Prefer the global stashed by autoexec;
# fall back to a live read. Reading tasmota.wd at REQUEST time returns ''
# (only valid during boot), which broke serving index.html/lang.json.
try
    import global
    var w = global._tapp_wd
    if w != nil && size(w) > 0 _s['wd'] = w end
except ..
end
if size(_s['wd']) == 0
    try
        var w = tasmota.wd
        if w != nil && size(w) > 0 _s['wd'] = w end
    except ..
    end
end

def getExtension(filename)
    var result = nil
    var parts = string.split(filename, ".")
    var psize = size(parts)
    if psize > 1
        result = parts[psize - 1]
    else
        result = defaultExtension
    end
    return result
end

def getMime(extension)
    if mime.contains(extension)
        return mime[extension]
    end
    return defaultMime
end

# NOTE: energy-cost derivation (FR-108) is done in the BROWSER
# (frontend lib/aggregate.js:deriveCosts) from the raw Wh fields + the
# tariffs served by /api/meta. The device streams raw records only — it
# never computes CHF — so the tiny Berry heap does no per-record cost math.

def _send(code, payload)
    webserver.content_open(code, 'application/json')
    webserver.content_send(payload)
    webserver.content_close()
end

# --- streaming JSON buffer -------------------------------------------------
# Berry strings are IMMUTABLE, so the former `buf += piece` batching loop
# reallocated the whole buffer on every item: the bytes allocated to serve one
# response grew with the square of the batch size. Measured on the CLI:
# GET /loads (4 loads) allocated 4.8 KB, GET /api/energy?count=96 ~71 KB,
# GET /api/power (200 samples) ~133 KB — all of it garbage, churning the tiny
# C3 heap once per poll PER connected browser.
#
# `bytes` appends IN PLACE (`b .. s` mutates b), so the only strings built are
# one json.dump per item plus one asstring() per flushed chunk — linear, not
# quadratic. The buffer is preallocated to BATCH + a margin so ordinary
# appends never hit a realloc, then cleared (clear() drops the length, keeps
# the allocation); an item larger than the margin costs one grow, no more.
# Chunking stays at ~1 KB: one chunk per record would stall the
# single-threaded VM and risk a client-side timeout (see powerrequest).
var BATCH = 1024
# /fs file-serving chunk (see _serve_file for why reads are exact-sized)
var CHUNK = 2048

def _new_buf()
    var b = bytes()
    b.resize(BATCH + 256)
    b.clear()
    return b
end

def _flush(b)
    if size(b) > 0
        webserver.content_send(b.asstring())
        b.clear()
    end
end

# append and flush once the batch is full. Single-byte separators are appended
# straight to the buffer (the margin covers them) and only checked here.
def _put(b, s)
    b .. s
    if size(b) >= BATCH
        _flush(b)
    end
end

# responses are streamed in ~1 KB batches — a single json.dump of all
# records would not fit the device's free Berry heap, but one chunk per
# record (90+ TCP chunks) stalls the single-threaded VM and risks a
# client-side timeout. content_close() lives after the try so the chunked
# stream is always terminated; skipping it on a mid-stream throw is what
# produced ERR_INCOMPLETE_CHUNKED_ENCODING on the client.
def powerrequest()
    site.note_serving()
    var utc = tasmota.rtc()['utc']
    webserver.content_open(200, 'application/json')
    var b = _new_buf()
    try
        b .. '{"now":' .. str(utc) .. ',"samples":['
        var n = meter.sample_count()
        var i = 0
        while i < n
            if i > 0
                b .. ','
            end
            _put(b, json.dump(meter.sample_at(i)))
            i += 1
        end
        b .. ']}'
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: power stream failed: {e} {m}")
    end
    _flush(b)
    webserver.content_close()
end

def energyrequest()
    site.note_serving()
    var res = webserver.has_arg('res') ? webserver.arg('res') : '15m'
    # spec 011 FR-1122: 15m is the only resolution the device serves — the
    # day/month roll-ups live in the browser archive (lib/aggregate.js).
    if res != '15m'
        _send(400, '{"error":"invalid res"}')
        return
    end
    var cap = store.capacity(res)
    var count = webserver.has_arg('count') ? int(webserver.arg('count')) : 96
    if count < 1
        count = 1
    end
    if count > cap
        count = cap
    end
    var from_ts = webserver.has_arg('from') ? int(webserver.arg('from')) : nil
    var to_ts   = webserver.has_arg('to')   ? int(webserver.arg('to'))   : nil

    var total = store.count(res)
    var skip = total - count
    if skip < 0
        skip = 0
    end
    # spec 011 FR-1103: with `from` the response pages FORWARD from the oldest
    # matching slot instead of returning the newest `count` records — the
    # browser archive syncs incrementally and must be able to walk the whole
    # retained buffer in <= 384-slot pages. Without `from` nothing changes.
    if from_ts != nil
        skip = 0
    end
    # streamed in ~1 KB batches with a guaranteed content_close() — see
    # powerrequest() for the rationale (heap bound + chunked termination)
    webserver.content_open(200, 'application/json')
    var b = _new_buf()
    var cur = store.open_cursor(res, skip)
    try
        b .. '['
        var first = true
        # ONE record map, refilled per record: the default 96-record response
        # otherwise allocated 96 short-lived 6-7 key maps. Never retained past
        # the json.dump below (see store.next_into).
        var rec = {}
        var sent = 0
        while store.next_into(cur, rec)
            if from_ts != nil && rec['ts'] < from_ts
                continue
            end
            if to_ts != nil && rec['ts'] > to_ts
                continue
            end
            # raw record only — the browser derives CHF (see note above)
            if !first
                b .. ','
            end
            _put(b, json.dump(rec))
            first = false
            sent += 1
            if sent >= count
                break
            end
        end
        b .. ']'
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: energy stream failed: {e} {m}")
    end
    # Berry has no `finally` — close the cursor after the try/except so a
    # mid-stream throw still releases its open file handle.
    store.close_cursor(cur)
    _flush(b)
    webserver.content_close()
end

# Stream a list of item maps as a JSON array in ~1 KB batches — the same
# pattern as energyrequest/powerrequest. json.dump of a whole list builds ONE
# transient string sized by the site config (loads + productions), and the UI
# polls both lists every 2 s per connected browser; batching bounds that
# transient at ~1 KB regardless of how many items a site grows to.
def _stream_items(items)
    webserver.content_open(200, 'application/json')
    var b = _new_buf()
    try
        b .. '['
        var i = 0
        var n = size(items)
        while i < n
            if i > 0
                b .. ','
            end
            _put(b, json.dump(items[i]))
            i += 1
        end
        b .. ']'
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: item stream failed: {e} {m}")
    end
    _flush(b)
    webserver.content_close()
end

# GET /api/meter (spec 007 FR-701) — raw Smart-Meter-Interface passthrough.
# {"now":<utc>,"values":<z-object|null>}. The browser (pages/zaehler.js +
# lib/metercat.js) does ALL interpretation (labels, units, per-phase table,
# derived Schieflast/cosφ) — the device serves the descriptor VERBATIM,
# re-serialized once (NFR-701). No webclient, no flash access (FR-702):
# gplug.read_z() is a local read_sensors(); the optional simulated meter is
# already cached by the poll scheduler (site.get_meter_cached()).
# pure payload builder (unit-tested): serialize the descriptor exactly once.
def meter_payload(utc, z)
    if z == nil
        return '{"now":' + str(utc) + ',"values":null}'
    end
    return '{"now":' + str(utc) + ',"values":' + json.dump(z) + '}'
end

def meterrequest()
    # arm the serving guard like every other handler: read_z() below is the
    # biggest transient of any request path (multi-KB sensor string + parsed
    # map), so the scheduler must not fire its own webclient in the same
    # window and stack the two peaks.
    site.note_serving()
    var utc = tasmota.rtc()['utc']
    var z = gplug.read_z()
    if z == nil
        z = site.get_meter_cached()
    end
    webserver.content_open(200, 'application/json')
    webserver.content_send(meter_payload(utc, z))
    webserver.content_close()
end

def metarequest()
    # Build the payload BEFORE opening the response so a throw here can't
    # leave the client with a half-open connection and no body
    # (ERR_EMPTY_RESPONSE). On any failure, still send valid JSON.
    try
        var utc = tasmota.rtc()['utc']
        var payload = {
            'time': utc,
            'tariffs': site.get_tariffs()
        }
        _send(200, json.dump(payload))
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: metarequest failed: {e} {m}")
        _send(200, '{"time":0}')
    end
end

# open a bundled file by trying the filesystem root first, then inside the
# .tapp via tasmota.wd (captured at boot; a REQUEST-time read returns '').
# It does NOT depend on sys.path() state: the old code opened
# `sys.path().pop() + name`, which broke the moment the working dir was not
# on the path (index.html/lang.json then 404'd and the UI never loaded).
def _open_bundled(filename)
    if size(filename) == 0
        return nil
    end
    # filesystem root first, then inside the .tapp (wd captured at boot)
    for p : [filename, _s['wd'] + filename]
        try
            return open(p, 'r')
        except ..
        end
    end
    return nil
end

def _serve_file()
    # the important arg is 'name', that holds the filename to be served
    var filename = ""
    if webserver.has_arg("name")
        filename = webserver.arg("name")
    end

    # get the appropriate mime-type (no debug log here: the eagerly-built
    # f-string allocated on every /fs request even when filtered)
    var mime_type = getMime(getExtension(filename))

    if size(filename) == 0
        webserver.content_open(404, mime_type)
        webserver.content_send("use as an example: http://[Device.IP]/fs?name=test.html")
        webserver.content_close()
        return
    end

    var fh = _open_bundled(filename)
    if fh == nil
        # Warn (not Debug) with the tapp wd so a persistent 404 reveals
        # whether wd was captured and what path was actually tried.
        logger.logMsg(logger.lWarn, f"WebService: file not found '{filename}' (tried root + '{_s['wd']}{filename}')")
        webserver.content_open(404, mime_type)
        webserver.content_send("file not found: '" + filename + "'")
        webserver.content_close()
        return
    end

    # stream the file in small chunks — the Berry heap on the device is
    # far too small to hold whole UI assets (app.js ~45 KB) as one string.
    #
    # NEVER over-read: Berry core's file.read(n) (be_filelib.c i_read) mallocs
    # n bytes but frees with the byte count actually READ. Every short read
    # inflates gc.usage by (n - read) for good, and the final empty read at EOF
    # is never freed at all (Tasmota's be_realloc returns early on
    # old_size == new_size == 0). The old `read(2048) until empty` loop leaked
    # ~2 KB of real heap plus ~3.5 KB of reported Berry heap PER PAGE LOAD of
    # index.html — the week-long heap decay on the gPlug. So read exactly the
    # bytes left (size()/tell()) and stop before an EOF read ever happens.
    webserver.content_open(200, mime_type)
    try
        var remaining = fh.size() - fh.tell()
        while remaining > 0
            var n = remaining < CHUNK ? remaining : CHUNK
            var chunk = fh.read(n)
            if chunk == nil || size(chunk) == 0
                break
            end
            webserver.content_send(chunk)
            remaining -= size(chunk)
        end
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: stream failed: {e} {m}")
    end
    fh.close()
    webserver.content_close()
end

def webrequest()
    try
        _serve_file()
    except .. as e, m
        logger.logMsg(logger.lWarn, f"WebService: serve failed: {e} {m}")
    end
end

def loadsrequest()
    site.note_serving()
    if webserver.arg_size() == 0
        # GET /loads — return full load list.
        # Serve the cached twin state (refreshed by the EMS poll driver):
        # the frontend polls this every 2 s, and a live per-request
        # integration fetch would block the single-threaded VM and churn
        # the small Berry heap on every poll / per connected browser.
        # streamed per item in ~1 KB batches (see _stream_items)
        _stream_items(site.get_loads_cached())
        return
    end

    # GET /loads?id=<id>&action=transition&to=<state> — the ONLY parameterised
    # form. The bare `?id=` read and `action=state` were dropped with spec 011
    # step 1 (no caller: the UI reads the list and switches via transition).
    if !webserver.has_arg("action") || webserver.arg("action") != 'transition' || !webserver.has_arg("to")
        _send(400, '{"error":"invalid request"}')
        return
    end
    var id = webserver.arg("id")
    if site.get_load_by_id(id) == nil
        _send(404, '{"error":"load not found"}')
        return
    end
    var new_state = webserver.arg("to")
    if new_state != site.STATE_INACTIVE && new_state != site.STATE_WAITING && new_state != site.STATE_ACTIVE
        _send(400, '{"error":"invalid state"}')
        return
    end
    var updated = site.set_load_state(id, new_state)
    ems.update_load_allocation()
    _send(200, json.dump(updated))
end

def siterequest()
    var s = site.get_site()
    if s == nil
        webserver.content_open(404, 'application/json')
        webserver.content_send('{"error":"site not found"}')
        webserver.content_close()
        return
    end
    webserver.content_open(200, 'application/json')
    webserver.content_send(json.dump(s))
    webserver.content_close()
end

def productionsrequest()
    site.note_serving()
    # GET /productions — the cached twin state, streamed per item (see
    # loadsrequest). The `?id=` read and `action=set-power` were dropped with
    # spec 011 step 1: nothing ever called them.
    _stream_items(site.get_productions_cached())
end

def modbusrequest()
    site.note_serving()
    # GET /api/modbus — standalone Modbus registers (site.json
    # "modbusRegisters"): config fields (id/friendlyName/register/...) plus
    # whatever the poll scheduler last merged in ("currentPower"), streamed
    # per item like /loads /productions. Not a passthrough of a foreign
    # descriptor (unlike /api/meter) — these are OUR OWN named registers, so
    # the device already knows their labels and just serves them verbatim.
    _stream_items(site.get_modbus_cached())
end

# this is only called when network goes online
def apprequest()
    webserver.redirect("/fs?name=index.html")
end

def web_add_handler()
    webserver.on("/fs", /-> webrequest(), webserver.HTTP_GET)
    webserver.on("/app", /-> apprequest(), webserver.HTTP_GET)
    webserver.on("/loads", /-> loadsrequest(), webserver.HTTP_GET)
    webserver.on("/productions", /-> productionsrequest(), webserver.HTTP_GET)
    webserver.on('/api/modbus', /-> modbusrequest(), webserver.HTTP_GET)
    webserver.on("/site", /-> siterequest(), webserver.HTTP_GET)
    webserver.on('/api/power',  /-> powerrequest(),  webserver.HTTP_GET)
    webserver.on('/api/energy', /-> energyrequest(), webserver.HTTP_GET)
    webserver.on('/api/meta',   /-> metarequest(),   webserver.HTTP_GET)
    webserver.on('/api/meter',  /-> meterrequest(),  webserver.HTTP_GET)
end

def start()
    # if wifi is already up, do this
    if tasmota.wifi()["up"] web_add_handler() end
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, "WebService started on port 80")
end

def stop()
    tasmota.remove_driver(_driver)
    logger.logMsg(logger.lInfo, "WebService stopped")
end

def save_before_restart()
    stop()
end

_driver = drivershim.make({
    'web_add_handler': web_add_handler,
    'save_before_restart': save_before_restart
})

webservice.start = start
webservice.stop  = stop
# test hook: pure /api/meter payload builder (spec 007)
webservice.meter_payload = meter_payload
# exported for tests/test_webservice_stream.be: the batching must produce a
# JSON array byte-identical to json.dump(list), whatever the batch boundaries
webservice.stream_items = _stream_items
# same test hook for the two record streams — they share _new_buf/_put/_flush
# and must stay valid JSON across every flush boundary
webservice.energy_request = energyrequest
webservice.power_request  = powerrequest
# test hook for tests/test_webservice_fs.be: /fs streaming must be
# byte-exact AND leak-free (exact-sized reads, never an EOF read)
webservice.serve_file     = _serve_file

return webservice
