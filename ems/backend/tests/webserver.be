# Stub for the Tasmota built-in `webserver` module (unavailable in the Berry
# CLI). webservice.be does `import webserver` at module scope, so this must
# resolve for any test that imports webservice.
#
# Captures the response so tests can assert on it:
#   webserver.set_args({'res': '1d', 'count': '10'})  # simulate query params
#   ... invoke a handler ...
#   webserver.last_code() / webserver.last_mime() / webserver.body()

var webserver = module()

webserver.HTTP_GET  = 1
webserver.HTTP_POST = 2

var _args = {}
var _code = nil
var _mime = nil
var _body = ''

# --- test control / inspection ---
webserver.set_args = def(a) _args = (a == nil ? {} : a) end
webserver.reset    = def() _args = {} _code = nil _mime = nil _body = '' end
webserver.last_code = def() return _code end
webserver.last_mime = def() return _mime end
webserver.body      = def() return _body end

# --- API used by webservice.be ---
webserver.on       = def(uri, cb, method) end
webserver.redirect = def(location) end

webserver.has_arg  = def(name) return _args.contains(name) end
webserver.arg      = def(name) return _args.find(name, '') end
webserver.arg_size = def() return size(_args) end

webserver.content_open  = def(code, mime) _code = code _mime = mime _body = '' end
webserver.content_send  = def(chunk) _body += chunk end
webserver.content_close = def() end

return webserver
