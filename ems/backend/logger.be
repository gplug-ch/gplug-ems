var logger = module()

logger.lOff   = 0
logger.lInfo  = 1
logger.lWarn  = 2
logger.lDebug = 3
logger.lMore  = 4

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat; the old `var level` + `level = x` in setLevel
# was exactly that bug).
var _s = {
    'level': 2     # range from lOff (0) .. lMore (4)
}

logger.setLevel = def(aTrLev)
    assert( (aTrLev >= logger.lOff && aTrLev <= logger.lMore),
        "setLevel(aTrLev) out of range: " + str(aTrLev))
    _s['level'] = aTrLev
end

# cheap guard for hot paths: build a log message (f-string args are evaluated
# EAGERLY in Berry, allocating on the heap even when the message is filtered)
# only when it will actually print:
#   if logger.enabled(logger.lDebug) logger.logMsg(logger.lDebug, f"...") end
logger.enabled = def(aTrLev)
    return _s['level'] >= aTrLev
end

logger.logMsg = def(aTrLev, aMsg)
    if _s['level'] < aTrLev
        return
    end
    print(f"EMS: {aMsg}")
end

return logger
