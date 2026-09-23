var modbustcp = module()
import logger
import string
import nethost

# modbustcp — reads ONE Modbus TCP register (or register pair) directly over
# the LAN, no Tasmota-side script needed. Built for gateways that bridge
# RS485/M-Bus devices onto Modbus TCP (e.g. an Anybus M-Bus -> Modbus TCP
# unit) — unlike gplug's "sensor"/"field" (issue #10), which reads a value a
# LOCAL Tasmota script already decoded into JSON, this integration is its own
# Modbus master: it opens the TCP connection, frames the MBAP request and
# decodes the register bytes itself.
#
# Config (per load/production/grid item):
#   "url"          "<ip>:<port>" of the Modbus TCP gateway, e.g. "192.168.0.102:502"
#   "unit"         Modbus unit/slave id (default 1)
#   "function"     3 = Read Holding Registers (default), 4 = Read Input Registers
#   "register"     starting register address, wire value as-is (no 40001 offset math)
#   "dtype"        "float32" (default) | "int16" | "uint16" | "int32" | "uint32"
#   "swap_words"   true swaps the two 16-bit words of a 32-bit value before
#                  decoding (CDAB byte order) — the gateway tested against
#                  (2026-09-22, Anybus M-Bus->Modbus TCP) uses plain ABCD, so
#                  this defaults false; opt-in escape hatch for other vendors.
#   "scale"        constant multiplier applied to the decoded value (default
#                  1) — for devices with a fixed, non-SunSpec scale and no
#                  dynamic exponent register (unlike gplug's "scale_field",
#                  issue #12, there is no register here to read a factor
#                  from).
#   "dimension"    "kW" -> result * 1000, same convention as every other
#                  integration.
#
# Read-only for now (set_state below just warns) — the surveyed gateway
# (heat/water submeters) had nothing to write to.

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

# MBAP header (7: transaction, protocol, length, unit) + function byte (1) +
# one more byte is the minimum needed to tell success from a Modbus
# exception apart: a full exception reply is exactly 9 bytes (header + func
# with the high bit set + exception code), shorter than any successful read.
# A success reply's real length (9 + byte_count) is checked separately once
# the byte_count byte itself has arrived.
var HEADER_MIN_SIZE = 9

var _s = {'trans_id': 0}

def _next_trans_id()
    _s['trans_id'] = (_s['trans_id'] + 1) % 65536
    return _s['trans_id']
end

# Modbus TCP request: MBAP header (trans id, protocol id 0, length, unit id)
# + PDU (function code, register address, quantity). `size<0` on bytes.add()
# is big-endian — Modbus is always big-endian on the wire.
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

# Read up to READ_BUDGET_MS worth of response bytes off `tc`, accumulating
# across calls (a LAN response usually arrives in one chunk, but nothing
# guarantees it isn't split, and this loop doesn't know the frame's total
# length up front — that's only known once the byte_count byte itself has
# arrived, checked by the caller). Once data has started arriving, two
# consecutive empty polls (a quiet period) end the wait early instead of
# always burning the full budget; a socket that never answers at all still
# times out at READ_BUDGET_MS.
def _read_response(tc)
    var resp = bytes()
    var waited = 0
    var idle = 0
    while waited < READ_BUDGET_MS
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
        return real(data.get(0, -4))
    else # "float32"
        var v = data.get(0, -4)
        var fb = bytes()
        fb.add(v, 4)
        return fb.getfloat(0)
    end
end

def _swap_words(data)
    return data[2..3] .. data[0..1]
end

# Returns ONLY the fetched fields — see the contract note in gplug.be:
# site._refresh_item() merges them into the item map, which IS the `cfg`
# passed in here, so echoing cfg back is pure churn.
def fetch_item(url, token, cfg)
    var register = cfg.find("register", nil)
    if register == nil
        logger.logMsg(logger.lWarn, "modbustcp: item has no 'register'")
        return nil
    end
    if nethost.skipping(url)
        return nil
    end

    var parts = string.split(url, ":")
    if size(parts) != 2
        logger.logMsg(logger.lWarn, f"modbustcp: bad url '{url}', expected <ip>:<port>")
        return nil
    end
    var host = parts[0]
    var port = int(parts[1])

    var dtype = cfg.find("dtype", "float32")
    var qty = (dtype == "int32" || dtype == "uint32" || dtype == "float32") ? 2 : 1
    var unit = cfg.find("unit", 1)
    var func = cfg.find("function", 3)

    var tc = nil
    try
        tc = tcpclient()
        if !tc.connect(host, port, CONNECT_TIMEOUT_MS)
            logger.logMsg(logger.lWarn, f"modbustcp: connect '{url}' failed")
            nethost.fail(url)
            tc.close()
            return nil
        end

        var req = _build_request(_next_trans_id(), unit, func, register, qty)
        tc.write(req)
        var resp = _read_response(tc)
        tc.close()

        if resp == nil || resp.size() < HEADER_MIN_SIZE
            logger.logMsg(logger.lWarn, f"modbustcp: no/short response from '{url}' reg {register}")
            nethost.fail(url)
            return nil
        end

        var resp_func = resp.get(7, 1)
        if resp_func != func
            # a Modbus exception reply is exactly HEADER_MIN_SIZE bytes
            # (header + func|0x80 + code) — already fully in hand here
            logger.logMsg(logger.lWarn,
                f"modbustcp: '{url}' reg {register} returned exception {resp.get(8,1)}")
            nethost.fail(url)
            return nil
        end

        var byte_count = resp.get(8, 1)
        if resp.size() < 9 + byte_count
            logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {register} response truncated")
            nethost.fail(url)
            return nil
        end
        var data = resp[9..9+byte_count-1]
        if cfg.find("swap_words", false) && qty == 2
            data = _swap_words(data)
        end

        var val = _decode(data, dtype)
        var scale = cfg.find("scale", 1)
        if scale != 1
            val = val * scale
        end
        if cfg.find("dimension", nil) == "kW"
            val = val * 1000
        end

        nethost.ok(url)
        return {"currentPower": val}
    except .. as e
        logger.logMsg(logger.lWarn, f"modbustcp: '{url}' reg {register} failed: {e}")
        nethost.fail(url)
        if tc != nil tc.close() end
        return nil
    end
end

def set_state(url, token, state)
    logger.logMsg(logger.lWarn, "modbustcp: set_state not supported (read-only)")
    return false
end

modbustcp.fetch_item = fetch_item
modbustcp.set_state  = set_state

return modbustcp
