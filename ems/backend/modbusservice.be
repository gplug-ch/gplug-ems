var modbusservice = module()

import strict
import json
import logger

# modbusservice — manual Modbus register read/write for commissioning and
# testing (issue #20), used by the Einstellungen «Modbus» test panel:
#
#   GET  /api/modbus/read?url=<ip:port>&unit=&function=3|4&register=&dtype=
#                        &swap_words=&scale=&dimension=
#   GET  /api/modbus/read?id=<item id>[&field=power|soc|energy|state|write]
#        -> {"value", "raw": [words]} | {"exception": code}
#   POST /api/modbus/write  {url, unit, register, dtype, swap_words, scale,
#                            dimension, function 6|16, value}
#                        or {id, field, value}
#        -> {"ok": true, "function", "raw"} | {"exception": code}
#
# Writes go to holding registers only (FC 6/16; FC 5 only through a
# configured load's coil "write" block) and only on an explicit POST — no
# GET ever writes. Every manual write is logged at Warn, the default level.
#
# LAZY (startup-heap issue #2): main.be's stub imports this module on the
# first request, like configservice. The exchange runs inline in the request
# handler — one user-initiated op, answered with one small JSON reply.

var DTYPES = ['float32', 'int16', 'uint16', 'int32', 'uint32']

var _s = {
    'site': nil,     # site module (injectable for tests)
    'mb': nil        # modbustcp module (injectable for tests)
}

def _site()
    if _s['site'] == nil
        import site
        _s['site'] = site
    end
    return _s['site']
end

def _mb()
    if _s['mb'] == nil
        import modbustcp
        _s['mb'] = modbustcp
    end
    return _s['mb']
end

def set_site(m) _s['site'] = m end
def set_modbus(m) _s['mb'] = m end

def _err(code, msg)
    return [code, json.dump({'error': msg})]
end

# a query/JSON value as a number, nil if absent or not numeric (real("abc")
# would quietly give 0 — json.load only accepts a real number literal)
def _num(v)
    if type(v) == 'int' || type(v) == 'real' return v end
    if type(v) != 'string' || v == '' return nil end
    var n = json.load(v)
    return (type(n) == 'int' || type(n) == 'real') ? n : nil
end

# ... and as an int (nil if not integral)
def _int(v)
    var n = _num(v)
    if n == nil || n != int(n) return nil end
    return int(n)
end

def _bool(v)
    return v == true || v == 'true' || v == '1' || v == 1
end

# configured item by id across loads, productions, grid and modbusRegisters
def _find(id)
    var s = _site()
    for list : [s.get_loads_cached(), s.get_productions_cached(),
                s.get_grid_cached(), s.get_modbus_cached()]
        for it : list
            if it.find('id', nil) == id return it end
        end
    end
    return nil
end

# [url, spec] of one register of a configured modbustcp item, or [nil, msg].
# `field` picks the register: power (default), soc, energy, state, write.
def _item_spec(id, field)
    var it = _find(id)
    if it == nil return [nil, f"unknown id '{id}'"] end
    if it.find('integration', nil) != 'modbustcp'
        return [nil, f"'{id}' is not a modbustcp item"]
    end
    var func = it.find('function', 3)
    var spec = {'unit': it.find('unit', 1), 'swap_words': it.find('swap_words', false)}
    if field == nil || field == '' || field == 'power'
        spec['register'] = it.find('register', nil)
        spec['dtype'] = it.find('dtype', 'float32')
        spec['function'] = func
        spec['scale'] = it.find('scale', 1)
        spec['dimension'] = it.find('dimension', nil)
    elif field == 'soc' || field == 'energy' || field == 'state'
        var p = field + '_'
        spec['register'] = it.find(p + 'register', nil)
        spec['dtype'] = it.find(p + 'dtype', field == 'energy' ? 'uint32' : 'uint16')
        spec['function'] = it.find(p + 'function', func)
        spec['scale'] = it.find(p + 'scale', 1)
    elif field == 'write'
        var w = it.find('write', nil)
        if !isinstance(w, map) return [nil, f"'{id}' has no write block"] end
        spec['register'] = w.find('register', nil)
        spec['dtype'] = w.find('dtype', 'uint16')
        spec['function'] = w.find('function', nil)
        spec['scale'] = w.find('scale', 1)
    else
        return [nil, f"unknown field '{field}'"]
    end
    if spec['register'] == nil return [nil, f"'{id}' has no {field} register"] end
    return [it.find('url', ''), spec]
end

# [url, spec] from free parameters (query args or JSON body), or [nil, msg]
def _free_spec(a)
    var url = a.find('url', '')
    import string
    var parts = string.split(str(url), ':')
    if size(parts) != 2 || parts[0] == '' || _int(parts[1]) == nil
        return [nil, 'url must be <ip>:<port>']
    end
    var reg = _int(a.find('register', nil))
    if reg == nil || reg < 0 || reg > 65535 return [nil, 'register must be 0..65535'] end
    var unit = _int(a.find('unit', nil))
    if unit == nil unit = 1 end
    if unit < 0 || unit > 255 return [nil, 'unit must be 0..255'] end
    var dtype = a.find('dtype', '')
    if dtype == '' || dtype == nil dtype = 'float32' end
    if DTYPES.find(dtype) == nil return [nil, f"unknown dtype '{dtype}'"] end
    var scale = _num(a.find('scale', nil))
    if scale == nil scale = 1 end
    if scale == 0 return [nil, 'scale must not be 0'] end
    var spec = {'unit': unit, 'register': reg, 'dtype': dtype, 'scale': scale,
                'swap_words': _bool(a.find('swap_words', false)),
                'dimension': a.find('dimension', nil) == 'kW' ? 'kW' : nil}
    var func = _int(a.find('function', nil))
    if func != nil spec['function'] = func end
    return [url, spec]
end

def _reply(res)
    if res.contains('error') return [502, json.dump(res)] end
    return [200, json.dump(res)]
end

# GET /api/modbus/read — `a` is the query args as a map of strings
def read(a)
    var r = a.find('id', '') != '' ? _item_spec(a['id'], a.find('field', nil)) : _free_spec(a)
    if r[0] == nil return _err(a.find('id', '') != '' ? 404 : 400, r[1]) end
    var spec = r[1]
    var func = spec.find('function', 3)
    # a write block's register is a holding register, whatever FC writes it
    if func != 3 && func != 4
        if a.find('field', nil) == 'write' && func != 5
            func = 3
        else
            return _err(400, 'function must be 3 or 4')
        end
    end
    spec['function'] = func
    return _reply(_mb().read_register(r[0], spec))
end

# POST /api/modbus/write — `body` is the raw JSON request body
def write(body)
    var a = nil
    try a = json.load(body) except .. end
    if !isinstance(a, map) return _err(400, 'invalid json') end
    var value = _num(a.find('value', nil))
    if value == nil return _err(400, 'value must be a number') end
    var byid = a.find('id', '') != '' && a.find('id', nil) != nil
    var r = byid ? _item_spec(a['id'], a.find('field', nil)) : _free_spec(a)
    if r[0] == nil return _err(byid ? 404 : 400, r[1]) end
    var spec = r[1]
    var func = spec.find('function', nil)
    var coil_block = byid && a.find('field', nil) == 'write' && func == 5
    if byid && !coil_block && a.find('field', nil) != 'write'
        # an item's read register: writable only if it is a holding register
        if func != 3 return _err(400, 'input registers are read-only') end
        spec['function'] = nil
        func = nil
    end
    if func != nil && func != 6 && func != 16 && !coil_block
        return _err(400, 'function must be 6 or 16 (holding registers)')
    end
    var res = _mb().write_register(r[0], spec, value)
    logger.logMsg(logger.lWarn,
        f"Modbus: manual write '{r[0]}' unit {spec['unit']} reg {spec['register']} value {value} -> {json.dump(res)}")
    return _reply(res)
end

def _send(r)
    import webserver
    webserver.content_open(r[0], 'application/json')
    webserver.content_send(r[1])
    webserver.content_close()
end

def _args()
    import webserver
    var a = {}
    for k : ['id', 'field', 'url', 'unit', 'function', 'register', 'dtype',
             'swap_words', 'scale', 'dimension']
        if webserver.has_arg(k) a[k] = webserver.arg(k) end
    end
    return a
end

def readrequest()
    try
        _site().note_serving()
        _send(read(_args()))
    except .. as e, m
        _send(_err(500, f"{e} {m}"))
    end
end

def writerequest()
    import webserver
    try
        _site().note_serving()
        _send(write(webserver.has_arg('plain') ? webserver.arg('plain') : ''))
    except .. as e, m
        _send(_err(500, f"{e} {m}"))
    end
end

modbusservice.read         = read
modbusservice.write        = write
modbusservice.readrequest  = readrequest
modbusservice.writerequest = writerequest
modbusservice.set_site     = set_site
modbusservice.set_modbus   = set_modbus

return modbusservice
