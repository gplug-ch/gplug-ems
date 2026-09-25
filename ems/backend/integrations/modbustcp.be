var modbustcp = module()
import logger
import string
import nethost

# modbustcp — own Modbus TCP master: reads registers (and, for loads, writes
# one) directly over the LAN, no Tasmota-side script needed. Built for
# gateways that bridge RS485/M-Bus devices onto Modbus TCP (e.g. an Anybus
# M-Bus -> Modbus TCP unit) and for native Modbus TCP inverters/batteries —
# unlike gplug's "sensor"/"field" (issue #10), which reads a value a LOCAL
# Tasmota script already decoded into JSON, this integration opens the TCP
# connection, frames the MBAP request and decodes the register bytes itself.
#
# Config (per load/production/grid/modbusRegisters item):
#   "url"          "<ip>:<port>" of the Modbus TCP device, e.g. "192.168.0.102:502"
#   "unit"         Modbus unit/slave id (default 1)
#   "function"     3 = Read Holding Registers (default), 4 = Read Input Registers
#   "register"     power register, wire address as-is (no 40001 offset math)
#                  -> "currentPower". Optional on a load that has "state_register".
#   "dtype"        "float32" (default) | "int16" | "uint16" | "int32" | "uint32"
#   "swap_words"   true swaps the two 16-bit words of a 32-bit value (CDAB
#                  order) — the gateway tested against (2026-09-22, Anybus
#                  M-Bus->Modbus TCP) uses plain ABCD, so this defaults false.
#                  Applies to every register of the item.
#   "scale"        constant multiplier applied to the decoded value (default
#                  1) — for devices with a fixed, non-SunSpec scale and no
#                  dynamic exponent register (unlike gplug's "scale_field").
#   "dimension"    "kW" -> result * 1000, same convention as every other
#                  integration.
#
# Extra registers, read over the SAME connection in the same poll tick
# (issue #20; each has its own <prefix>_dtype / _function / _scale, the
# function defaulting to the item's):
#   "soc_register"     battery SoC in % -> "soc" (dtype default uint16);
#                      a value outside 0..100 is dropped
#   "energy_register"  energy counter -> "energyCounter" in Wh (dtype
#                      default uint32; "energy_dimension" "Wh"|"kWh",
#                      defaulting to kWh when "dimension" is "kW") — meter.be
#                      seals a PV slot from its difference (issue #14)
#   "state_register"   load on/off state (dtype default uint16) -> "state",
#                      see _state_of()
#
# Loads are switched by writing ONE holding register (or a coil):
#   "write": {"register": 1100, "dtype": "uint16", "on": 1, "off": 0,
#             "inactive": <optional, default "off">, "function": 6|16|5,
#             "scale": 1}
#   The function defaults to 6 (Write Single Register) for 16-bit dtypes and
#   16 (Write Multiple Registers) for 32-bit ones; 5 writes a coil (on ->
#   0xFF00). ACTIVE writes "on", WAITING "off", INACTIVE "inactive".

# Connect timeout, ms. Unlike webclient() — whose ~9 s default cannot be
# lowered on this firmware and blocks the shared Berry thread on a dead host
# (see nethost.be) — tcpclient().connect() takes an explicit timeout, so a
# dead gateway stalls the poll tick for a bound WE choose, not one imposed on
# us.
var CONNECT_TIMEOUT_MS = 1000

# Total budget waiting for the response after write(), ms. A native Modbus
# TCP device answers within a few ms, but a protocol GATEWAY (e.g. an M-Bus ->
# Modbus TCP bridge) has to run an actual exchange with the physical meter
# over a much slower bus first — M-Bus in particular is serial at a low baud
# rate, and a single meter's telegram can easily take several hundred ms to a
# few seconds. 500 ms was measured too tight against a real Anybus M-Bus
# gateway (2026-09-22: "no/short response" on every read); this is a
# deliberately generous ceiling for that case, not a happy-path expectation —
# a native Modbus TCP device still replies almost immediately.
var READ_BUDGET_MS = 3000
var READ_POLL_MS = 20

# Read budget for a MANUAL op (Einstellungen «Modbus» test panel, issue #30).
# The exchange runs inside the HTTP handler on the shared Berry thread, so
# the whole device (EMS tick, Übersicht polls, meter sampling) waits with it;
# and a manual op skips the host backoff, so every click pays the full wait.
# Half the poll budget still covers a native device by orders of magnitude;
# a gateway that needs longer answers the background poll, not the panel.
var MANUAL_READ_BUDGET_MS = 1500

# _transact's transport error when nothing at all came back within the read
# budget — the host accepted the connection but did not answer. read_register
# / write_register report it with "reason":"timeout" (vs. "connect").
var NO_RESPONSE = "no response"

# MBAP header (7: transaction, protocol, length, unit) + function byte (1) +
# one more byte is the minimum needed to tell success from a Modbus
# exception apart: a full exception reply is exactly 9 bytes (header + func
# with the high bit set + exception code), shorter than any successful read.
# A success reply's real length (9 + byte_count) is checked separately once
# the byte_count byte itself has arrived.
var HEADER_MIN_SIZE = 9

# a write reply (FC 5/6/16) is MBAP (7) + func (1) + address (2) + value or
# quantity (2)
var WRITE_REPLY_SIZE = 12

var _s = {'trans_id': 0}

def _next_trans_id()
    _s['trans_id'] = (_s['trans_id'] + 1) % 65536
    return _s['trans_id']
end

# registers a dtype occupies: 1 for the 16-bit types, 2 otherwise (the
# default float32 included)
def _qty(dtype)
    return (dtype == "int16" || dtype == "uint16") ? 1 : 2
end

# Modbus TCP request: MBAP header (trans id, protocol id 0, length, unit id)
# + PDU (function code, register address, one 16-bit field). `size<0` on
# bytes.add() is big-endian — Modbus is always big-endian on the wire. The
# 16-bit field is the quantity for a read (FC 3/4), the value for FC 6 and
# 0xFF00/0x0000 for FC 5 — the same 12-byte frame shape.
def _build_request(trans_id, unit, func, addr, qty)
    var req = bytes()
    req.add(trans_id, -2)
    req.add(0, -2)       # protocol id, always 0 for Modbus TCP
    req.add(6, -2)       # length: unit + func + addr + qty, fixed for this PDU shape
    req.add(unit, 1)
    req.add(func, 1)
    req.add(addr, -2)
    req.add(qty, -2)
    return req
end

# FC 16 (Write Multiple Registers): address, quantity, byte count, data
def _build_write16(trans_id, unit, addr, data)
    var req = bytes()
    req.add(trans_id, -2)
    req.add(0, -2)
    req.add(7 + data.size(), -2)   # unit + func + addr + qty + byte count + data
    req.add(unit, 1)
    req.add(16, 1)
    req.add(addr, -2)
    req.add(data.size() / 2, -2)
    req.add(data.size(), 1)
    return req .. data
end

# Read up to READ_BUDGET_MS worth of response bytes off `tc`, accumulating
# across calls (a LAN response usually arrives in one chunk, but nothing
# guarantees it isn't split, and this loop doesn't know the frame's total
# length up front — that's only known once the byte_count byte itself has
# arrived, checked by the caller). Once data has started arriving, two
# consecutive empty polls (a quiet period) end the wait early instead of
# always burning the full budget; a socket that never answers at all still
# times out at READ_BUDGET_MS.
def _read_response(tc, budget)
    var resp = bytes()
    var waited = 0
    var idle = 0
    while waited < budget
        var chunk = tc.readbytes()
        if chunk != nil && chunk.size() > 0
            resp = resp .. chunk
            idle = 0
        elif resp.size() > 0
            idle += READ_POLL_MS
            if idle >= READ_POLL_MS * 2
                return resp
            end
        end
        tasmota.delay(READ_POLL_MS)
        waited += READ_POLL_MS
    end
    return resp.size() > 0 ? resp : nil
end

# One request/reply exchange. Returns [resp, nil] on success, or [nil, err]
# where err is the Modbus exception code (int) or a transport error (string,
# NO_RESPONSE when nothing came back within `budget` ms, default
# READ_BUDGET_MS).
def _transact(tc, req, func, budget)
    tc.write(req)
    var resp = _read_response(tc, budget != nil ? budget : READ_BUDGET_MS)
    if resp == nil return [nil, NO_RESPONSE] end
    if resp.size() < HEADER_MIN_SIZE
        return [nil, "short response"]
    end
    var rf = resp.get(7, 1)
    if rf == (func | 0x80)
        # a Modbus exception reply is exactly HEADER_MIN_SIZE bytes (header +
        # func|0x80 + code) — already fully in hand here
        return [nil, resp.get(8, 1)]
    elif rf != func
        return [nil, f"unexpected function {rf}"]
    end
    return [resp, nil]
end

# Decode the register bytes (network/big-endian order, already word-swapped
# if "swap_words" asked for it) per `dtype`. float32 has no big-endian
# variant of bytes.getfloat() (it reads the native little-endian layout), so
# the 4 bytes are re-encoded little-endian first via add()/get(-4).
def _decode(data, dtype)
    if dtype == "int16"
        return real(data.geti(0, -2))
    elif dtype == "uint16"
        return real(data.get(0, -2))
    elif dtype == "int32"
        return real(data.geti(0, -4))
    elif dtype == "uint32"
        # Berry's int is 32-bit: get() hands a value >= 2^31 back negative
        var u = real(data.get(0, -4))
        return u < 0 ? u + 4294967296.0 : u
    else # "float32"
        var v = data.get(0, -4)
        var fb = bytes()
        fb.add(v, 4)
        return fb.getfloat(0)
    end
end

def _round(v)
    return v >= 0 ? int(v + 0.5) : -int(-v + 0.5)
end

# Inverse of _decode: a register value (already un-scaled) -> big-endian
# register bytes, or nil if it does not fit the dtype. An integer dtype
# rounds; uint32 above the signed range is passed as its two's-complement
# twin, since Berry's int is 32-bit on the device and bytes.add() writes the
# same bits either way.
def _encode(v, dtype)
    var b = bytes()
    if dtype == "float32" || dtype == nil
        var le = bytes()
        le.resize(4)
        le.setfloat(0, real(v))
        b.add(le.get(0, 4), -4)
        return b
    end
    var r = _round(v)
    if dtype == "int16"
        if r < -32768 || r > 32767 return nil end
        b.add(r, -2)
    elif dtype == "uint16"
        if r < 0 || r > 65535 return nil end
        b.add(r, -2)
    elif dtype == "int32"
        if v < -2147483648.0 || v > 2147483647.0 return nil end
        b.add(r, -4)
    elif dtype == "uint32"
        if v < -0.5 || v > 4294967295.0 return nil end
        if v >= 2147483647.5
            r = _round(v - 4294967296.0)
        end
        b.add(r, -4)
    else
        return nil
    end
    return b
end

def _swap_words(data)
    return data[2..3] .. data[0..1]
end

# the register's words, for the manual read/write view ({raw: [words]})
def _words(data)
    var w = []
    var i = 0
    while i + 1 < data.size()
        w.push(data.get(i, -2))
        i += 2
    end
    return w
end

# decoded value -> engineering units: * scale, kW -> W
def _apply(v, scale, kw)
    if scale != nil && scale != 1 v = v * scale end
    if kw v = v * 1000 end
    return v
end

# note a failed exchange for the host backoff — but not for a MANUAL op
# (Einstellungen test panel): a typo'd address there must not stall the
# polling of a working device on that host
def _fail(url, manual)
    if !manual nethost.fail(url) end
end

# Open a connection to "<ip>:<port>". Returns [tc, nil], or [nil, reason] if
# the host is in its cool-off window, the url is malformed or the connect
# fails (logged, backoff noted); a failed connect returns [nil, reason, true]. A MANUAL op (`manual` true) ignores the
# cool-off: the user asked for exactly this one exchange, and answering
# "connect failed" for a host nobody even tried was the panel's 502 mystery.
def _connect(url, manual)
    if !manual && nethost.skipping(url)
        return [nil, "host in backoff after earlier failures"]
    end
    var parts = string.split(str(url), ":")
    if size(parts) != 2
        logger.logMsg(logger.lWarn, f"modbustcp: bad url '{url}', expected <ip>:<port>")
        return [nil, f"bad url '{url}', expected <ip>:<port>"]
    end
    var tc = tcpclient()
    if !tc.connect(parts[0], int(parts[1]), CONNECT_TIMEOUT_MS)
        logger.logMsg(logger.lWarn, f"modbustcp: connect '{url}' failed")
        _fail(url, manual)
        tc.close()
        return [nil, f"connect to {url} failed (no answer within {CONNECT_TIMEOUT_MS} ms)", true]
    end
    return [tc, nil]
end

# Read ONE register (pair) on an open connection. Returns [value, data] —
# the decoded (unscaled) value and the register bytes after any word swap —
# or [nil, err] as _transact.
def _read_one(tc, unit, func, reg, dtype, swap, budget)
    var qty = _qty(dtype)
    var r = _transact(tc, _build_request(_next_trans_id(), unit, func, reg, qty), func, budget)
    if r[0] == nil return r end
    var resp = r[0]
    var byte_count = resp.get(8, 1)
    if byte_count < qty * 2 || resp.size() < 9 + byte_count
        return [nil, "response truncated"]
    end
    var data = resp[9..9+byte_count-1]
    if swap && qty == 2
        data = _swap_words(data)
    end
    return [_decode(data, dtype), data]
end

def _log_err(url, reg, err)
    if type(err) == 'int'
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {reg} returned exception {err}")
    else
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {reg} failed: {err}")
    end
end

# Map a state register reading to a load state. The register only knows
# on/off, while the EMS also tells WAITING (wants power) from INACTIVE
# (deselected), so an "off" reading keeps the EMS's own distinction:
#   * == on value (default write.on)                   -> ACTIVE
#   * == a DISTINCT inactive value (write.inactive)    -> INACTIVE
#   * anything else while the EMS believes ACTIVE      -> WAITING (switched
#     off outside the EMS, stays a candidate)
#   * anything else otherwise                          -> nil (no change)
def _state_of(v, cfg)
    var w = cfg.find("write", nil)
    if !isinstance(w, map) w = {} end
    var on = cfg.find("on_value", w.find("on", 1))
    var off = cfg.find("off_value", w.find("off", 0))
    var inactive = w.find("inactive", off)
    v = _round(v)
    if v == on return "ACTIVE" end
    if inactive != off && v == inactive return "INACTIVE" end
    if cfg.find("state", nil) == "ACTIVE" return "WAITING" end
    return nil
end

# Returns ONLY the fetched fields — see the contract note in gplug.be:
# site._refresh_item() merges them into the item map, which IS the `cfg`
# passed in here, so echoing cfg back is pure churn.
#
# ONE connection per call (the scheduler's one-outbound-op-per-tick budget),
# the item's registers read one after the other on it. The main register
# failing fails the whole read (nil, host backoff); an extra register failing
# drops only its own field — and ends the exchange, since a late reply could
# otherwise be taken for the next request's.
def fetch_item(url, token, cfg)
    var register = cfg.find("register", nil)
    var sreg = cfg.find("state_register", nil)
    if register == nil && sreg == nil
        logger.logMsg(logger.lWarn, "modbustcp: item has no 'register'")
        return nil
    end
    var tc = nil
    try
        tc = _connect(url, false)[0]
        if tc == nil return nil end
        var unit = cfg.find("unit", 1)
        var func = cfg.find("function", 3)
        var swap = cfg.find("swap_words", false)
        var result = {}

        if register != nil
            var r = _read_one(tc, unit, func, register, cfg.find("dtype", "float32"), swap)
            if r[0] == nil
                tc.close()
                _log_err(url, register, r[1])
                nethost.fail(url)
                return nil
            end
            result["currentPower"] = _apply(r[0], cfg.find("scale", 1),
                                            cfg.find("dimension", nil) == "kW")
        end

        # extra registers: [config prefix, default dtype]
        for x : [["soc_", "uint16"], ["energy_", "uint32"], ["state_", "uint16"]]
            var p = x[0]
            var reg = cfg.find(p + "register", nil)
            if reg == nil continue end
            var r = _read_one(tc, unit, cfg.find(p + "function", func), reg,
                              cfg.find(p + "dtype", x[1]), swap)
            if r[0] == nil
                _log_err(url, reg, r[1])
                if size(result) == 0
                    # the only register of the item failed — like the main one
                    tc.close()
                    nethost.fail(url)
                    return nil
                end
                break
            end
            var v = _apply(r[0], cfg.find(p + "scale", 1), false)
            if p == "soc_"
                if v >= 0 && v <= 100 result["soc"] = v end
            elif p == "energy_"
                var edim = cfg.find("energy_dimension",
                                    cfg.find("dimension", nil) == "kW" ? "kWh" : "Wh")
                result["energyCounter"] = edim == "kWh" ? v * 1000 : v
            else
                var st = _state_of(r[0], cfg)
                if st != nil result["state"] = st end
            end
        end
        tc.close()
        nethost.ok(url)
        return result
    except .. as e
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {register} failed: {e}")
        nethost.fail(url)
        if tc != nil tc.close() end
        return nil
    end
end

# Error map for read_register / write_register: {"error"} plus, for the two
# transport failures the panel explains to the user (issue #30), "reason"
# ("connect" | "timeout") and "ms", the budget that ran out.
def _transport_err(msg, reason, ms)
    return {"error": msg, "reason": reason, "ms": ms}
end

# Read budget of a spec: manual ops get the short one (see MANUAL_READ_BUDGET_MS)
def _budget(manual)
    return manual ? MANUAL_READ_BUDGET_MS : READ_BUDGET_MS
end

# Read one register by an explicit spec {unit, function, register, dtype,
# swap_words, scale, dimension, manual} — the manual read (issue #20).
# Returns {"value", "raw": [words]}, {"exception": code} or {"error": msg}.
# "manual": true bypasses the host backoff (see _connect) and waits at most
# MANUAL_READ_BUDGET_MS for the reply. A failed connect or a silent host adds
# "reason"/"ms" (see _transport_err).
def read_register(url, spec)
    var reg = spec.find("register", nil)
    if reg == nil return {"error": "no register"} end
    var manual = spec.find("manual", false)
    var budget = _budget(manual)
    var tc = nil
    try
        var c = _connect(url, manual)
        tc = c[0]
        if tc == nil
            return size(c) > 2 ? _transport_err(c[1], "connect", CONNECT_TIMEOUT_MS) : {"error": c[1]}
        end
        var r = _read_one(tc, spec.find("unit", 1), spec.find("function", 3), reg,
                          spec.find("dtype", "float32"), spec.find("swap_words", false), budget)
        tc.close()
        if r[0] == nil
            _log_err(url, reg, r[1])
            if type(r[1]) == 'int'
                nethost.ok(url)   # the device answered: config error, not a dead host
                return {"exception": r[1]}
            end
            _fail(url, manual)
            if r[1] == NO_RESPONSE
                return _transport_err(f"no response within {budget} ms", "timeout", budget)
            end
            return {"error": r[1]}
        end
        nethost.ok(url)
        return {"value": _apply(r[0], spec.find("scale", 1), spec.find("dimension", nil) == "kW"),
                "raw": _words(r[1])}
    except .. as e
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {reg} read failed: {e}")
        _fail(url, manual)
        if tc != nil tc.close() end
        return {"error": str(e)}
    end
end

# Write `value` (engineering units: "dimension":"kW" and "scale" are undone
# before encoding) to one holding register (pair) or coil, spec as
# read_register plus "function" 6|16|5 (default by dtype). The reply must
# echo the request. Returns {"ok": true, "function", "raw": [words]},
# {"exception": code} or {"error": msg}. Every write is logged. "manual":
# true bypasses the host backoff and shortens the wait, as for read_register.
def write_register(url, spec, value)
    var reg = spec.find("register", nil)
    if reg == nil return {"error": "no register"} end
    if type(value) != 'int' && type(value) != 'real'
        return {"error": "value must be a number"}
    end
    var dtype = spec.find("dtype", "float32")
    var qty = _qty(dtype)
    var func = spec.find("function", nil)
    if func == nil func = qty == 1 ? 6 : 16 end
    if func != 5 && func != 6 && func != 16
        return {"error": f"function {func} cannot write"}
    end
    if func == 6 && qty == 2
        return {"error": "function 6 writes one register, dtype needs two"}
    end
    var tid = _next_trans_id()
    var unit = spec.find("unit", 1)
    var req
    var data = nil
    if func == 5
        req = _build_request(tid, unit, 5, reg, value != 0 ? 0xFF00 : 0)
    else
        var v = value
        if spec.find("dimension", nil) == "kW" v = v / 1000.0 end
        var scale = spec.find("scale", 1)
        if scale != nil && scale != 1 && scale != 0 v = v / real(scale) end
        data = _encode(v, dtype)
        if data == nil
            return {"error": f"value {value} out of range for {dtype}"}
        end
        if spec.find("swap_words", false) && qty == 2
            data = _swap_words(data)
        end
        req = func == 6 ? _build_request(tid, unit, 6, reg, data.get(0, -2))
                        : _build_write16(tid, unit, reg, data)
    end
    logger.logMsg(logger.lInfo, f"modbustcp: write '{url}' unit {unit} reg {reg} FC {func} value {value}")
    var manual = spec.find("manual", false)
    var budget = _budget(manual)
    var tc = nil
    try
        var c = _connect(url, manual)
        tc = c[0]
        if tc == nil
            return size(c) > 2 ? _transport_err(c[1], "connect", CONNECT_TIMEOUT_MS) : {"error": c[1]}
        end
        var r = _transact(tc, req, func, budget)
        tc.close()
        if r[0] == nil
            _log_err(url, reg, r[1])
            if type(r[1]) == 'int'
                nethost.ok(url)
                return {"exception": r[1]}
            end
            _fail(url, manual)
            if r[1] == NO_RESPONSE
                return _transport_err(f"no response within {budget} ms", "timeout", budget)
            end
            return {"error": r[1]}
        end
        # FC 5/6 echo the whole request PDU; FC 16 echoes address + quantity
        var resp = r[0]
        if resp.size() < WRITE_REPLY_SIZE || resp[8..11].tohex() != req[8..11].tohex()
            _log_err(url, reg, "reply does not echo the request")
            _fail(url, manual)
            return {"error": "reply does not echo the request"}
        end
        nethost.ok(url)
        return {"ok": true, "function": func, "raw": data != nil ? _words(data) : [req.get(10, -2)]}
    except .. as e
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {reg} write failed: {e}")
        _fail(url, manual)
        if tc != nil tc.close() end
        return {"error": str(e)}
    end
end

# Switch a load (called from the site scheduler's actuation queue, one op
# per tick): writes the item's "write" block value for `state`. `cfg` is the
# load's item map — site._actuate_load() passes it as the 4th argument.
def set_state(url, token, state, cfg)
    var w = cfg != nil ? cfg.find("write", nil) : nil
    if !isinstance(w, map) || w.find("register", nil) == nil
        logger.logMsg(logger.lWarn, "modbustcp: load has no 'write' register, cannot switch")
        return false
    end
    var off = w.find("off", 0)
    var val = state == "ACTIVE" ? w.find("on", 1)
            : state == "INACTIVE" ? w.find("inactive", off) : off
    var spec = {
        "unit": cfg.find("unit", 1),
        "register": w["register"],
        "dtype": w.find("dtype", "uint16"),
        "function": w.find("function", nil),
        "swap_words": cfg.find("swap_words", false),
        "scale": w.find("scale", 1)
    }
    return write_register(url, spec, val).find("ok", false)
end

modbustcp.fetch_item     = fetch_item
modbustcp.set_state      = set_state
modbustcp.read_register  = read_register
modbustcp.write_register = write_register

return modbustcp
