# store.be — flash-persisted 15-min energy records (spec 001, spec 011 step 3b).
#
# Record fields (per 15-min slot): ts, imp_wh, exp_wh, pv_wh, and on a site
# with a battery (issue #20) bat_chg_wh, bat_dis_wh.
# imp/exp/pv may be nil (sensor failed during the slot -> "partial").
#
# Memory layout (issue #4): records are never held in RAM. They live in small
# append-only text files on flash, one per UTC day:
#   /.e15_<dayno>  dayno = ts/86400, KEEP_DAYS kept (today + 29 previous ->
#                  up to 2880 slots)
# Each line: "<ts-delta>,<imp>,<exp>,<pv>\n" — the delta is relative to the
# day's start (small numbers), an empty field means nil. Lines written before
# spec 011 step 3b carry a trailing ",<vin>,<vout>" tail (the former
# community share); those still parse (the tail is ignored) so buckets
# survive the upgrade.
# A battery site (issue #20) appends ",<chg>,<dis>," — SEVEN fields, the last
# one reserved and empty, so the count never collides with the legacy six.
# (The SoC would fit there but is not recorded: its history pushed the
# worst-case flash headroom below the 40 KB rule, see STORAGE.md §4.) Sites
# without a battery keep writing the four-field line byte for byte.
# A line not terminated by '\n' (a torn trailing append) is never counted or
# served — a crash mid-append corrupts at most the last, not-yet-flushed line.
#
# RAM only holds `nb`: one int per kept bucket file (its line count).
#
# Writes are APPEND-ONLY (spec 011 NFR-1102): push_15m() appends ONE line to
# the current day's bucket file (a few dozen bytes, LittleFS commits one
# block). No file is ever read and rewritten — the day/month roll-ups
# (/e1d, /e1mo) and the line-wise rewrite that needed the ".tmp" copy-back
# pattern were removed in spec 011 step 3b: the browser archive
# (ems/frontend/src/lib/archive.js) keeps the history and derives the
# roll-ups and costs from its own copy.

var store = module()

import strict
import string
import logger
import fsx

var KEEP_DAYS = 30     # /.e15_<dayno> buckets kept (spec 011 FR-1120: the
                       # browser archive syncs at most once a month)
# bucket filename stem; the leading '.' hides the buckets in Tasmota's
# file-manager view (issue #18)
var BUCKET = '.e15_'

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    'prefix': '/',    # filename prefix; files are prefix + BUCKET + dayno
    'dir': '/',        # directory to list (fsx.listdir) to discover buckets
    'stem': '',        # prefix's non-directory part (filename-matching only)
    'nb': {}           # dayno -> line count, for the KEEP_DAYS kept buckets
}

# test/deployment hook: override the filename prefix. '/' (default) on the
# device; a bare stem like 'tst_' (files land in cwd) or an absolute prefix
# like '/tmp/foo_' in the Berry CLI.
def set_prefix(p)
    _s['prefix'] = p
    var ds = fsx.split_prefix(p)
    _s['dir'] = ds[0]
    _s['stem'] = ds[1]
end

def _p15(dayno)
    return _s['prefix'] + BUCKET + str(dayno)
end

# discover /.e15_<dayno> buckets present under the current prefix, ascending
def _list_daynos()
    return fsx.list_daynos(_s['dir'], _s['stem'] + BUCKET)
end

# serialise one value: nil -> '' (empty field), else its integer text
def _enc_v(v)
    return v == nil ? '' : str(v)
end

# decode one packed field: '' -> nil, else int()
def _field(tok)
    return size(tok) == 0 ? nil : int(tok)
end

# "<delta>,<imp>,<exp>,<pv>\n" — `delta` is the day-relative offset; with
# any battery value the ",<chg>,<dis>," tail follows (issue #20)
def _enc_line(delta, imp, exp, pv, chg, dis)
    var s = str(delta) + ',' + _enc_v(imp) + ',' + _enc_v(exp) + ',' + _enc_v(pv)
    if chg != nil || dis != nil
        s += ',' + _enc_v(chg) + ',' + _enc_v(dis) + ','
    end
    return s + '\n'
end

# decode one line -> [delta, imp, exp, pv, chg, dis] (the battery values
# nil on a 4-field line; the reserved 7th field is ignored), or nil if the line is not '\n'-terminated
# (a torn trailing append) or malformed. A 6-field line written before spec
# 011 step 3b parses too; its legacy tail is ignored.
def _parse_line(line)
    var n = size(line)
    if n < 2 || line[n - 1] != '\n'
        return nil
    end
    var toks = string.split(line[0 .. n - 2], ',')
    var nt = size(toks)
    if nt != 4 && nt != 6 && nt != 7
        return nil
    end
    var bat = nt == 7
    return [int(toks[0]), _field(toks[1]), _field(toks[2]), _field(toks[3]),
            bat ? _field(toks[4]) : nil, bat ? _field(toks[5]) : nil]
end

# set m[k] = v, or REMOVE k when v is nil (the map may be reused)
def _put_opt(m, k, v)
    if v != nil
        m[k] = v
    elif m.contains(k)
        m.remove(k)
    end
end

# fill an EXISTING map, so a streaming caller can hand the same map back on
# every record. `partial` is REMOVED when it does not apply — a reused map
# would otherwise carry the flag over from an earlier record.
def _fill_map(m, ts, imp, exp, pv, chg, dis)
    m['ts'] = ts
    m['imp_wh'] = imp
    m['exp_wh'] = exp
    m['pv_wh'] = pv
    # battery fields only on a battery site's records (issue #20); absent
    # rather than null, so a battery-less site streams the same JSON as before
    _put_opt(m, 'bat_chg_wh', chg)
    _put_opt(m, 'bat_dis_wh', dis)
    if imp == nil || exp == nil || pv == nil
        m['partial'] = true
    elif m.contains('partial')
        m.remove('partial')
    end
    return m
end

def _append_line(path, s)
    fsx.append_line(path, s)
end

# register a (possibly new) day bucket; evicts the oldest once more than
# KEEP_DAYS are tracked
def _touch_dayno(dayno)
    if !_s['nb'].contains(dayno)
        _s['nb'][dayno] = 0
        if size(_s['nb']) > KEEP_DAYS
            # never evict the dayno just added above (a backward clock step
            # could otherwise make it the minimum and leave nb without the
            # key push_15m() is about to write to)
            var min_d = nil
            for d : _s['nb'].keys()
                if d != dayno && (min_d == nil || d < min_d)
                    min_d = d
                end
            end
            if min_d != nil
                _s['nb'].remove(min_d)
                fsx.remove(_p15(min_d))
            end
        end
    end
end

# seal a 15-min slot; the single append-per-slot write happens here.
# chg/dis (Wh) are the optional battery values (issue #20).
def push_15m(ts, imp, exp, pv, chg, dis)
    try
        var dayno = fsx.dayno(ts)
        _touch_dayno(dayno)
        _append_line(_p15(dayno), _enc_line(ts - dayno * 86400, imp, exp, pv, chg, dis))
        _s['nb'][dayno] += 1
    except .. as e
        logger.logMsg(logger.lWarn, f"store: push_15m failed: {e}")
    end
end

# files written by earlier firmware that this build no longer maintains:
# the pre-bucket ring (issue #4), the day/month seal files and any stray
# rewrite temporary (both gone with spec 011 step 3b). Removed once, at the
# next load() — there is no migration, the browser archive holds the history.
def _remove_obsolete()
    fsx.remove('/energy.json')
    fsx.remove('/energy.json.new')
    fsx.remove(_s['prefix'] + 'e1d')
    fsx.remove(_s['prefix'] + 'e1d.tmp')
    fsx.remove(_s['prefix'] + 'e1mo')
    fsx.remove(_s['prefix'] + 'e1mo.tmp')
    for d : _list_daynos()
        fsx.remove(_p15(d) + '.tmp')
    end
    # the former community feature (issue #1): member registry and the
    # per-member peer buckets <prefix>.vz_<id>_<dayno>
    fsx.remove('/vzev.json')
    var pat = _s['stem'] + '.vz_'
    var plen = size(pat)
    for n : fsx.listdir(_s['dir'])
        if size(n) > plen && n[0 .. plen - 1] == pat
            fsx.remove(_s['prefix'] + n[size(_s['stem']) ..])
        end
    end
end

# test/deployment hook: wipe every file under the current prefix + RAM state
def reset()
    for d : _list_daynos()
        fsx.remove(_p15(d))
    end
    _remove_obsolete()
    _s['nb'] = {}
end

def _count_lines(path)
    var n = 0
    var f = nil
    try
        f = open(path, 'r')
        var line = f.readline()
        while size(line) > 0
            if _parse_line(line) != nil
                n += 1
            end
            line = f.readline()
        end
        fsx.close_q(f)
        f = nil
    except ..
        fsx.close_q(f)
    end
    return n
end

# keep only the newest KEEP_DAYS daynos (mutates `dnos`, deletes the rest)
def _prune_daynos(dnos)
    while size(dnos) > KEEP_DAYS
        var old = dnos[0]
        fsx.remove(_p15(old))
        dnos.remove(0)
    end
end

# number of 15m records held; -1 for any other resolution (the day/month
# roll-ups moved to the browser archive with spec 011 step 3b)
def count(res)
    if res != '15m'
        return -1
    end
    var n = 0
    for d : _s['nb'].keys()
        n += _s['nb'][d]
    end
    return n
end

def capacity(res)
    return res == '15m' ? KEEP_DAYS * 96 : 0
end

def load()
    _s['nb'] = {}
    _remove_obsolete()
    var dnos = _list_daynos()
    _prune_daynos(dnos)
    for d : dnos
        _s['nb'][d] = _count_lines(_p15(d))
    end
    logger.logMsg(logger.lInfo, f"store: loaded 15m={count('15m')}")
end

# --- streaming cursor (issue #4): read API replacing get_rec/get_rec_into.
# Skips whole bucket files by their tracked line count before opening any
# file, so a `count=96` request against a full 2880-slot buffer only opens the
# bucket(s) it actually needs. ---

def _cursor_next_15m(cur, m)
    while true
        if cur['fh'] == nil
            if cur['di'] >= size(cur['dnos'])
                return false
            end
            var d = cur['dnos'][cur['di']]
            var n = _s['nb'][d]
            if cur['skip'] >= n
                cur['skip'] -= n
                cur['di'] += 1
                continue
            end
            cur['fh'] = open(_p15(d), 'r')
            cur['dts'] = d * 86400
        end
        var line = cur['fh'].readline()
        if size(line) == 0
            cur['fh'].close()
            cur['fh'] = nil
            cur['di'] += 1
            continue
        end
        var p = _parse_line(line)
        if p == nil
            continue
        end
        if cur['skip'] > 0
            cur['skip'] -= 1
            continue
        end
        _fill_map(m, cur['dts'] + p[0], p[1], p[2], p[3], p[4], p[5])
        return true
    end
end

def open_cursor(res, skip)
    if res != '15m'
        return nil
    end
    var dnos = []
    for d : _s['nb'].keys()
        dnos.push(d)
    end
    fsx.sort_ints(dnos)
    return {'res': res, 'dnos': dnos, 'di': 0, 'fh': nil, 'skip': skip}
end

def next_into(cur, m)
    if cur == nil
        return false
    end
    return _cursor_next_15m(cur, m)
end

# Berry has no `finally` — callers must call this after their try/except,
# not inside it, so a mid-stream throw still releases the file handle.
def close_cursor(cur)
    if cur != nil && cur.contains('fh') && cur['fh'] != nil
        try cur['fh'].close() except .. end
    end
end

# read(res, n) -> newest-last list of DISTINCT record maps (bulk convenience
# for tests/small n; on-device consumers should stream via open_cursor)
def read(res, n)
    var total = count(res)
    if total < 0
        return nil
    end
    var take = n < total ? n : total
    var cur = open_cursor(res, total - take)
    var result = []
    var m = {}
    while next_into(cur, m)
        result.push(m)
        m = {}
    end
    close_cursor(cur)
    return result
end

store.load        = load
store.reset       = reset
store.set_prefix  = set_prefix
store.push_15m    = push_15m
store.read        = read
store.count       = count
store.open_cursor = open_cursor
store.next_into   = next_into
store.close_cursor = close_cursor
store.capacity    = capacity

return store
