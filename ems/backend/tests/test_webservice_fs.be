# Tests for GET /fs?name=<file> streaming (webservice._serve_file).
# Run from the backend/ directory:
#   cd tests && berry -m .. test_webservice_fs.be
#
# Two properties:
#   1. the body is byte-identical to the file, whatever the chunk boundaries
#      (sizes 0, < chunk, == chunk, chunk + 1, several chunks + tail)
#   2. serving does not leak Berry heap. Berry core's file.read(n) frees its
#      buffer with the byte count actually read, not n, so any over-read
#      inflates gc.usage permanently and an EOF read is never freed at all.
#      The old `read(2048) until empty` loop cost ~3.5 KB per index.html
#      request; the fix reads exactly the bytes left and never hits EOF.

import json
import sys
import gc
import os
sys.path().push('../integrations')

# Stub the Tasmota built-in webclient (site/integrations import it at scope).
class _WebclientStub
    def begin(url) end
    def GET() return 200 end
    def close() end
end
webclient = _WebclientStub

import tasmota
import webserver
import webservice

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

var TMP = 'tst_fs_'
var made = []

def make_file(n)
    var p = TMP + str(n) + '.txt'
    var f = open(p, 'w')
    # deterministic content so a shifted/dropped chunk is detectable
    var i = 0
    while i < n
        f.write(str(i % 10))
        i += 1
    end
    f.close()
    made.push(p)
    return p
end

def cleanup()
    for p : made
        try os.remove(p) except .. end
    end
end

def serve(p)
    webserver.reset()
    webserver.set_args({'name': p})
    webservice.serve_file()
    webserver.set_args({})
    return webserver.body()
end

def expected(n)
    var s = ''
    var i = 0
    while i < n
        s += str(i % 10)
        i += 1
    end
    return s
end

# --- byte-exact across every chunk boundary --------------------------------
for n : [0, 180, 2047, 2048, 2049, 4096, 5000]
    var p = make_file(n)
    var body = serve(p)
    check(webserver.last_code() == 200, f"size {n}: HTTP 200")
    check(size(body) == n, f"size {n}: body length {size(body)}")
    check(body == expected(n), f"size {n}: body content")
end

# --- missing file -> 404, no throw ------------------------------------------
serve('tst_fs_does_not_exist.txt')
check(webserver.last_code() == 404, "missing file -> 404")

# --- leak-free: post-GC heap flat across many serves ------------------------
# 5000 B = two full chunks + a 904 B tail; 180 B = one short read. With the
# old EOF-read loop this cost >3 KB per call; the bound below allows only
# jitter (interned strings, arg maps).
for n : [180, 5000]
    var p = make_file(n)
    serve(p)                     # warm up (interned strings etc.)
    gc.collect()
    var a0 = gc.allocated()
    var i = 0
    while i < 50
        serve(p)
        i += 1
    end
    gc.collect()
    var delta = gc.allocated() - a0
    check(delta < 256, f"size {n}: 50 serves leaked {delta} B (expected ~0)")
end

cleanup()
print(f"All {passed} /fs streaming checks passed")
