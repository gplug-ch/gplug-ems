# Tests for configservice.be (spec 006 FR-601 / NFR-601).
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_configservice.be
#
# Covers what the device still decides after spec 011 step 2 (FR-1127):
# unparseable JSON -> 400, a config site.load_config() cannot load -> 500 with
# the previous file restored, atomic write via temp-file-then-rename, and a
# round-trip of examples/site-1.json with no key loss. The field-rule matrix
# moved to the browser — see ems/frontend/tests/test_einstellungen_validate.mjs.
# A controllable in-test `site` stub is injected so reload success/failure can
# be simulated without the real integrations.

import os
import json
import string

# Stub for the Tasmota built-in webclient class (site.be integrations need it,
# even though we inject our own site module below).
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

# Stub the Tasmota built-in `tasmota` global so configservice.be compiles under
# `import strict` in the Berry CLI (start()/driver hooks reference it). The
# tests never call start(); this just satisfies the compiler's global check.
tasmota = _WebclientStub

import configservice

# ---------------------------------------------------------------------------
# Controllable site stub — records reload calls and reports validity based on
# the file the config service just wrote.
# ---------------------------------------------------------------------------
var site_stub = {
    'file': nil,
    'reloads': 0,
    'valid': true
}

def make_site_stub()
    var m = module()
    m.load_config = def()
        site_stub['reloads'] += 1
        # Emulate the real load: parse the live file; if it parses to a map
        # with an id, site is valid, otherwise get_site() returns nil.
        site_stub['valid'] = false
        try
            var f = open(site_stub['file'], 'r')
            var raw = f.read()
            f.close()
            var cfg = json.load(raw)
            if isinstance(cfg, map) && type(cfg.find('id', nil)) == 'string'
                site_stub['valid'] = true
            end
        except ..
        end
    end
    m.get_site = def()
        if site_stub['valid']
            return {'id': 'ok'}
        end
        return nil
    end
    return m
end

configservice.set_site(make_site_stub())

# ---------------------------------------------------------------------------
# Test scaffolding: each test uses a temp file it owns.
# ---------------------------------------------------------------------------
var TEST_FILE = 'test_site_config.json'
var TEST_NEW  = TEST_FILE + '.new'

def cleanup()
    for p: [TEST_FILE, TEST_NEW]
        try os.remove(p) except .. end
    end
end

def read_file(p)
    var f = open(p, 'r')
    var raw = f.read()
    f.close()
    return raw
end

def write_file(p, content)
    var f = open(p, 'w')
    f.write(content)
    f.close()
end

def file_exists(p)
    try
        var f = open(p, 'r')
        f.close()
        return true
    except ..
        return false
    end
end

cleanup()
site_stub['file'] = TEST_FILE
configservice.set_file(TEST_FILE)

var VALID = '{"id":"site-1","loads":[{"id":"a","currentPower":500,"priority":1}],"productions":[],"grid":[]}'

# ---------------------------------------------------------------------------
# Test 1: a body that is not parseable JSON -> 400, file untouched.
# Since spec 011 step 2 this and the reload check are the ONLY rejections the
# device makes; every field rule moved to the browser (FR-1127), so the field
# matrix that used to live here is now tests/test_einstellungen_validate.mjs
# in the frontend.
# ---------------------------------------------------------------------------
write_file(TEST_FILE, VALID)
var before = read_file(TEST_FILE)
var res = configservice.save('{"id":"x",')
assert(res[0] == 400, f"malformed json should be 400, got {res[0]}")
assert(res[1] == '{"error":"invalid json"}', f"unexpected body: {res[1]}")
assert(read_file(TEST_FILE) == before, "file must be untouched on a malformed body")
assert(!file_exists(TEST_NEW), "temp file must not linger after rejected save")
# a JSON scalar is not a config object either
res = configservice.save('"nope"')
assert(res[0] == 400, f"non-object json should be 400, got {res[0]}")
assert(read_file(TEST_FILE) == before, "file must be untouched")
print("Test 1 passed: unparseable body -> 400, file untouched")

# ---------------------------------------------------------------------------
# Test 2: what the device no longer rejects (spec 011 FR-1127 / UC-1105).
# A document the old validator refused — no id, an ftp:// url, priority 0, a
# non-numeric currentPower — is now stored verbatim as long as it is JSON the
# site stub can load. The bad url fails later at poll time, like an
# unreachable host.
# ---------------------------------------------------------------------------
write_file(TEST_FILE, VALID)
var moved = '{"id":"x","loads":[{"id":"a","currentPower":"lots","priority":0,"url":"ftp://nope"}],"productions":[],"grid":[]}'
res = configservice.save(moved)
assert(res[0] == 200, f"validation moved to the browser, expected 200, got {res[0]} / {res[1]}")
assert(read_file(TEST_FILE) == moved, "the document must be stored verbatim")
assert(!file_exists(TEST_NEW), "temp file must be renamed away")
print("Test 2 passed: field rules moved to the browser -> 200")

# ---------------------------------------------------------------------------
# Test 3: atomic write — successful save replaces the live file, no temp left,
# and the reload path was invoked.
# ---------------------------------------------------------------------------
write_file(TEST_FILE, '{"id":"old","loads":[],"productions":[],"grid":[]}')
var reloads_before = site_stub['reloads']
res = configservice.save(VALID)
assert(res[0] == 200, f"valid save should be 200, got {res[0]} / {res[1]}")
assert(res[1] == '{"saved":true}', f"unexpected body: {res[1]}")
assert(read_file(TEST_FILE) == VALID, "live file must contain the new config verbatim")
assert(!file_exists(TEST_NEW), "temp file must be renamed away, not left behind")
assert(site_stub['reloads'] > reloads_before, "save must call site.load_config()")
print("Test 3 passed: atomic write via temp file + rename, reload invoked")

# ---------------------------------------------------------------------------
# Test 4: reload rejects the new config -> old file restored, HTTP 500
# The stub deems a config invalid when it has no string id. To exercise the
# restore path we temporarily force the stub to report invalid regardless of
# content.
# ---------------------------------------------------------------------------
write_file(TEST_FILE, '{"id":"good-old","loads":[],"productions":[],"grid":[]}')
var good_old = read_file(TEST_FILE)
# swap in a site module that always reports failure after reload
var failing = module()
failing.load_config = def() end
failing.get_site    = def() return nil end
configservice.set_site(failing)
res = configservice.save(VALID)
assert(res[0] == 500, f"rejected reload should be 500, got {res[0]}")
assert(string.find(res[1], 'config rejected') != -1, f"expected 'config rejected': {res[1]}")
assert(read_file(TEST_FILE) == good_old, "old file must be restored after rejected reload")
assert(!file_exists(TEST_NEW), "temp file must not linger after rejected reload")
# restore the good stub for any later tests
configservice.set_site(make_site_stub())
print("Test 4 passed: rejected reload restores old file + HTTP 500")

# ---------------------------------------------------------------------------
# Test 4b: first-ever save (no pre-existing file) whose reload fails must NOT
# leave a corrupt file behind (NFR-601 edge case).
# ---------------------------------------------------------------------------
try os.remove(TEST_FILE) except .. end   # ensure no live file exists
assert(!file_exists(TEST_FILE), "precondition: no live config file")
var failing2 = module()
failing2.load_config = def() end
failing2.get_site    = def() return nil end
configservice.set_site(failing2)
res = configservice.save(VALID)
assert(res[0] == 500, f"first-save reject should be 500, got {res[0]}")
assert(!file_exists(TEST_FILE), "invalid first-ever config must not persist")
assert(!file_exists(TEST_NEW), "temp file must not linger")
configservice.set_site(make_site_stub())
print("Test 4b passed: failed first-ever save leaves no corrupt file")

# ---------------------------------------------------------------------------
# Test 5: round-trip of examples/site-1.json — saves with no key loss.
# ---------------------------------------------------------------------------
var example = read_file('../examples/site-1.json')
var example_cfg = json.load(example)

# point the service at the example round-trip file
var RT_FILE = 'test_roundtrip.json'
try os.remove(RT_FILE) except .. end
try os.remove(RT_FILE + '.new') except .. end
site_stub['file'] = RT_FILE
configservice.set_file(RT_FILE)
write_file(RT_FILE, '{"id":"seed","loads":[],"productions":[],"grid":[]}')

res = configservice.save(example)
assert(res[0] == 200, f"example save should be 200, got {res[0]} / {res[1]}")

# reload the written file and confirm every top-level key + every load key survives
var written = json.load(read_file(RT_FILE))
for k: example_cfg.keys()
    assert(written.contains(k), f"top-level key lost: {k}")
end
# deep check: shelly load 'url' object with on/off/status must survive intact
var boiler = nil
for l: written['loads']
    if l['id'] == 'boiler-1' boiler = l end
end
assert(boiler != nil, "boiler-1 load lost in round-trip")
assert(isinstance(boiler['url'], map), "shelly url object must survive as a map")
assert(boiler['url']['on'] == 'http://192.168.0.148/relay/0?turn=on', "shelly on-url lost")
assert(boiler['url'].contains('status'), "shelly status-url lost")

try os.remove(RT_FILE) except .. end
try os.remove(RT_FILE + '.new') except .. end
print("Test 5 passed: examples/site-1.json round-trip, no key loss")

cleanup()
print("")
print("--- All configservice tests passed ---")
