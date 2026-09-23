# Importable webserver stub for Berry-CLI tests (real module lives in Tasmota
# firmware). Captures the streamed response body / status so tests can inspect
# handler output. State is held on the module object so it survives across the
# import boundary (module-level `var` upvalues are not reliably shared once the
# module is loaded from a file).

var webserver = module()

webserver.HTTP_GET = 1
webserver._body = ''
webserver._code = 0
webserver._args = {}

webserver.content_open  = def(code, ctype)
    webserver._code = code
    webserver._body = ''
end
webserver.content_send  = def(s) webserver._body = webserver._body + str(s) end
webserver.content_close = def() end
webserver.on            = def(path, cb, method) end
webserver.has_arg       = def(k) return webserver._args.contains(k) end
webserver.arg           = def(k) return webserver._args.find(k, '') end

# test helpers
webserver.set_args      = def(a) webserver._args = a end
webserver.body          = def() return webserver._body end
webserver.code          = def() return webserver._code end

return webserver
