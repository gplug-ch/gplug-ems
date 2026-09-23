# Shared test helper (not a test itself — make runs tests/*/test_*.be only):
# loaded with `var _mb = compile('mbslave.be', 'file')()`, it installs the
# global `tcpclient` stub and returns the slave's state map.

# A tiny in-memory Modbus TCP slave behind the tcpclient stub: one shared
# 16-bit register space (holding and input alike), coils, per-address
# exception codes, and knobs for a silent or non-echoing device.
var _mb = {'regs': {}, 'coils': {}, 'exc': {}, 'pending': nil, 'connects': 0,
           'frames': [], 'mute': false, 'bad_echo': false}

def _hdr(tid, unit, len)
    var b = bytes()
    b.add(tid, -2)
    b.add(0, -2)
    b.add(len, -2)
    b.add(unit, 1)
    return b
end

def _serve(req)
    var tid = req.get(0, -2)
    var unit = req.get(6, 1)
    var func = req.get(7, 1)
    var addr = req.get(8, -2)
    var code = _mb['exc'].find(addr, nil)
    if code != nil
        var r = _hdr(tid, unit, 3)
        r.add(func | 0x80, 1)
        r.add(code, 1)
        return r
    end
    if func == 3 || func == 4
        var qty = req.get(10, -2)
        var r = _hdr(tid, unit, 3 + qty * 2)
        r.add(func, 1)
        r.add(qty * 2, 1)
        for i : 0 .. qty - 1
            r.add(_mb['regs'].find(addr + i, 0), -2)
        end
        return r
    end
    if func == 6
        _mb['regs'][addr] = req.get(10, -2)
    elif func == 5
        _mb['coils'][addr] = req.get(10, -2) == 0xFF00
    elif func == 16
        var qty = req.get(10, -2)
        for i : 0 .. qty - 1
            _mb['regs'][addr + i] = req.get(13 + i * 2, -2)
        end
    end
    var r = _hdr(tid, unit, 6)
    r.add(func, 1)
    r.add(_mb['bad_echo'] ? addr + 1 : addr, -2)
    r.add(req.get(10, -2), -2)
    return r
end

class _TcpClientStub
    def connect(host, port, timeout_ms)
        _mb['connects'] = _mb['connects'] + 1
        return true
    end
    def connected() return true end
    def close() end
    def write(content)
        _mb['frames'].push(content)
        _mb['pending'] = _mb['mute'] ? nil : _serve(content)
        return content.size()
    end
    def readbytes()
        var r = _mb['pending']
        _mb['pending'] = nil
        return r
    end
end
tcpclient = _TcpClientStub

return _mb
