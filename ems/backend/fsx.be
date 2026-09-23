# fsx.be — filesystem primitives that differ between the Berry CLI (used by
# `make test`: has `os`, no top-level `path`) and Tasmota's embedded Berry (has
# `path`, no `os`). Detected once at runtime and cached (mirrors
# configservice.be's/store.be's own former _has_path()/_remove_file()).
#
# Also home of store.be's bucket-file helpers (issue #9): append-only per-day
# files named <prefix><kind>_<dayno> — prefix split, day-number math, bucket
# discovery and quiet close.

var fsx = module()

import strict

var _s = {'backend': nil}   # 'os' | 'path', detected lazily

def _backend()
    if _s['backend'] != nil
        return _s['backend']
    end
    try
        import os
        _s['backend'] = 'os'
    except ..
        _s['backend'] = 'path'
    end
    return _s['backend']
end

def remove(f)
    if _backend() == 'os'
        import os
        try os.remove(f) except .. end
    else
        import path
        try path.remove(f) except .. end
    end
end

# bare filenames (no directory component), or [] if the directory can't be
# listed. `dir` is '/' on-device, '.' for the Berry CLI test tree.
def listdir(dir)
    try
        if _backend() == 'os'
            import os
            return os.listdir(dir)
        else
            import path
            return path.listdir(dir)
        end
    except ..
        return []
    end
end

def append_line(path, s)
    var f = open(path, 'a')
    f.write(s)
    f.close()
end

# close a handle, ignoring a nil handle and any close error. LittleFS caps the
# number of concurrently open files, so EVERY open must be matched on the
# exception path too — a leaked handle makes the NEXT open fail, which is how a
# single transient error used to cascade into a boot hang.
def close_q(f)
    if f != nil
        try f.close() except .. end
    end
end

def dayno(ts)
    return ts / 86400
end

def _last_slash(p)
    var i = size(p) - 1
    while i >= 0
        if p[i] == '/'
            return i
        end
        i -= 1
    end
    return -1
end

# split a filename prefix into [dir, stem]: `dir` is what listdir() scans,
# `stem` the non-directory part bucket names start with. '/' (the device
# default) -> ['/', '']; a bare stem like 'tst_' (files land in cwd) ->
# ['.', 'tst_']; '/tmp/foo_' -> ['/tmp', 'foo_'].
def split_prefix(p)
    var idx = _last_slash(p)
    if idx >= 0
        return [idx == 0 ? '/' : p[0 .. idx - 1], p[idx + 1 ..]]
    end
    return ['.', p]
end

def _all_digits(s)
    if size(s) == 0
        return false
    end
    var i = 0
    while i < size(s)
        var c = s[i]
        if c < '0' || c > '9'
            return false
        end
        i += 1
    end
    return true
end

# ascending insertion sort, in place (n is tiny: KEEP_DAYS-ish)
def sort_ints(lst)
    var n = size(lst)
    var i = 1
    while i < n
        var key = lst[i]
        var j = i - 1
        while j >= 0 && lst[j] > key
            lst[j + 1] = lst[j]
            j -= 1
        end
        lst[j + 1] = key
        i += 1
    end
    return lst
end

# day numbers of the bucket files <pat><dayno> in `dir`, ascending
def list_daynos(dir, pat)
    var plen = size(pat)
    var out = []
    for n : listdir(dir)
        if size(n) > plen && n[0 .. plen - 1] == pat
            var numstr = n[plen ..]
            if _all_digits(numstr)
                out.push(int(numstr))
            end
        end
    end
    return sort_ints(out)
end

# --- transient modules (issue #27) ------------------------------------------
# `import` puts a module in Berry's import cache for good — there is no way to
# evict it — so a lazily imported service (modbusservice, configservice) only
# DEFERS its heap cost, it never gives it back. load_transient() compiles the
# module's source and runs it, returning the module object WITHOUT touching
# the import cache: once the caller drops the reference, GC frees the
# bytecode. Every call compiles afresh (the same transient peak the first
# import paid), so this is for rarely used request handlers only, never for a
# hot path. Modules the transient one imports itself (logger, json, ...) are
# cached as usual — they are resident anyway.
#
# The source is wrapped in `do … end` before compiling: a chunk compiled with
# compile() runs in GLOBAL scope, so its top-level `var`/`def` would become
# Berry globals — clobbering same-named globals and, worse, keeping every
# function (and so the whole bytecode) reachable, i.e. resident again. Inside
# a block they are locals of the chunk, as under `import`. "do " goes on the
# first line so error line numbers still match the file.

# the source of module `name`: from the .tapp root on-device (autoexec.be
# stashed its "…tapp#" prefix in global._tapp_wd), else along sys.path() —
# the Berry CLI, where the integrations live in their own subdirectory
def _module_src(name)
    var cands = []
    var wd = nil
    try
        import global
        wd = global._tapp_wd
    except ..
    end
    if type(wd) == 'string' && size(wd) > 0 cands.push(wd + name + '.be') end
    import sys
    for p : sys.path()
        cands.push(p + '/' + name + '.be')
        cands.push(p + '/integrations/' + name + '.be')
    end
    for c : cands
        var f = nil
        try
            f = open(c, 'r')
            var src = f.read()
            f.close()
            return src
        except ..
            close_q(f)
        end
    end
    return nil
end

def load_transient(name)
    var src = _module_src(name)
    if src == nil raise 'import_error', f"module '{name}' not found" end
    return compile('do ' + src + '\nend', 'string')()
end

fsx.load_transient = load_transient
fsx.remove       = remove
fsx.listdir      = listdir
fsx.append_line  = append_line
fsx.close_q      = close_q
fsx.dayno        = dayno
fsx.split_prefix = split_prefix
fsx.sort_ints    = sort_ints
fsx.list_daynos  = list_daynos

return fsx
