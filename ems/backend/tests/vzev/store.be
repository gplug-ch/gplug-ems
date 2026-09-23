# Importable store stub for Berry-CLI vzev tests. Since spec 011 step 3b
# vzev.be must not touch the store at all (FR-1123), so this stub is a
# TRIPWIRE: it records any set_vzev() call and the announce_slot section
# asserts store.count() == 0. State is held on the module object (module-level
# `var` upvalues are not reliably shared across the import boundary in the
# Berry CLI).

var store = module()

store._calls = {}    # ts -> [in_wh, out_wh] (last write wins)

store.set_vzev = def(ts, in_wh, out_wh)
    store._calls[ts] = [in_wh, out_wh]
    return true
end

# test helpers
store.reset  = def() store._calls = {} end
store.get    = def(ts) return store._calls.find(ts, nil) end
store.count  = def() return size(store._calls) end

return store
