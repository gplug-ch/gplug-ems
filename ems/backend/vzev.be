# vzev.be — vZEV community backend (spec 005).
#
# Three (or more) gPlug devices form a virtual energy community (vZEV) over the
# local multicast group (239.3.0.1:5007, via messaging/udpdriver.be). One member
# is the PRODUCER (PV site); the others are CONSUMERs. Per 15-min slot the
# producer's grid export is computationally allocated to the members' grid
# imports. The allocation and its money value must come out IDENTICAL on every
# device (deterministic, integer Wh) and reconcile with the grid operator per
# quarter.
#
# Trust model: the multicast LAN is assumed trusted (no auth/encryption — out of
# scope, spec 005). PRIVACY (FR-509): slot messages carry ONLY the two Wh fields
# needed for allocation (imp/exp). No load states, production detail or total
# consumption ever leave the device, and /api/vzev/* never exposes a peer's
# un-allocated import/export beyond what allocation requires locally.
#
# Responsibilities:
#   - member registry persisted at /vzev.json (get/upsert/remove/discovered)
#   - UDP protocol (announcement "ann", slot exchange "slot", retransmission
#     request "req") layered inside udpdriver's existing {from,timestamp,msg}
#     envelope; new payloads are JSON strings whose first byte is '{'. The
#     existing startup URL-advertisement (a bare "http://..." string) is left
#     untouched (C-1) and ignored by the new handler.
#   - discovery list in RAM (entries expire after 60 s)
#   - compact peer-slot storage (issue #4): per-member, per-day append-only
#     files /.vz_<sanitized-id>_<dayno>, KEEP_DAYS kept per member. No ring is
#     ever held in RAM — writes are a single line append; reads scan the
#     relevant bucket file(s). A member's "newest ts" and per-day line counts
#     are cached lazily (RAM: a few ints per member actually touched this
#     session, not a flash-resident ring per member).
#   - /api/vzev/* GET endpoints (own web_add_handler; apiservice.be untouched)
#
# The device does NOT allocate: since spec 011 step 3b the browser derives the
# per-slot allocation, the own vZEV share and the quarterly billing from
# /api/vzev/raw (frontend lib/vzev.js). This module only stores raw slots and
# moves them between sites.
#
# The receive callback CHAINS any previously registered udpdriver callback so
# other consumers keep working (FR-508). All webserver imports are lazy so the
# module stays loadable in the Berry CLI for tests.

var vzev = module()

import strict
import json
import logger
import drivershim
import string
import fsx

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

var ANN_INTERVAL   = 30      # seconds between announcements (discovery
                             # heartbeat + tariff sync; kept well under
                             # DISCOVER_TTL so a dropped packet doesn't
                             # expire a still-online peer)
var DISCOVER_TTL   = 120     # seconds a discovered entry lives
var SLOT_SECS      = 900     # 15-minute slot
var VZ_KEEP_DAYS   = 14      # per-member day buckets kept (issue #4; spec 011
                             # FR-1120 — 14 not 30, see STORAGE.md flash budget)
var VZ_BUCKET      = '.vz_'    # peer bucket filename stem; the leading '.'
                             # hides it in Tasmota's file-manager view (#18)
var REQ_MIN_GAP    = 60      # >=1 request per minute (rate-limit)
var REQ_MAX_SLOTS  = 8       # <=8 slots answered/requested per request
# tolerate a peer missing only the just-closed slot for this long after
# the close (normal announce latency) before requesting retransmission
var REQ_SETTLE_S   = 60
# tariff keys a producer advertises so every site prices identically:
# the internal vZEV rates + the HT/NT split inputs billing uses
var TAR_KEYS       = ['vzev_export_chf_kwh', 'vzev_import_chf_kwh',
                      'grid_import_ht_chf_kwh', 'grid_import_nt_chf_kwh',
                      'ht_windows']
var VZEV_FILE      = '/vzev.json'

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    # registry: list of {id,name,location,type,url,added_ts}
    'members': [],
    # vZEV master data (spec 009 FR-903): {representative_name,
    # representative_contact, connection_point_id, enabled}; persisted
    # alongside members. 'enabled' gates the frontend nav entry.
    'info': {},
    # discovery: id -> {id,name,loc,typ,url,last_seen}
    'discovered': {},
    # peer slot storage (issue #4): id -> {dayno: line_count}, lazily
    # populated the first time a member's data is touched this boot
    'vznb': {},
    # id -> newest slot ts stored for that member (-1 = none), lazy cache
    'newest': {},
    'prev_cb': nil,       # chained prior udpdriver callback
    'last_ann': 0,        # utc of last announcement sent
    'last_req': 0,        # utc of last retransmission request sent
    # last tariff set seen in the registered producer's announcement (RAM
    # only — refreshed every ANN_INTERVAL, so a reboot recovers within ~10 s)
    'producer_tar': nil,
    'file': '/vzev.json',
    'prefix': '/',    # peer-slot bucket filename prefix (issue #4)
    'dir': '/',
    'stem': '',
    'self_id': nil
}

# test/deployment hooks
def set_file(p) _s['file'] = p end

# test/deployment hook: override the peer-slot bucket filename prefix. '/'
# (default) on the device; a bare stem like 'tst_' or an absolute prefix
# like '/tmp/foo_' in the Berry CLI.
def set_prefix(p)
    _s['prefix'] = p
    var ds = fsx.split_prefix(p)
    _s['dir'] = ds[0]
    _s['stem'] = ds[1]
end

# test/deployment hook: force this device's site id (bypasses site.be)
def set_self_id(id)
    _s['self_id'] = id
end

def _site_id()
    if _s['self_id'] != nil
        return _s['self_id']       # test/deployment override
    end
    try
        import site
        var s = site.get_site()
        if s != nil
            return s.find('id', nil)
        end
    except ..
    end
    return nil
end

def _now()
    try
        return tasmota.rtc().find('utc', 0)
    except ..
        return 0
    end
end

# --- registry (FR-501) ----------------------------------------------------

def get_members()
    return _s['members']
end

def _find_index(id)
    var i = 0
    while i < size(_s['members'])
        if _s['members'][i].find('id', nil) == id
            return i
        end
        i += 1
    end
    return -1
end

def get_member(id)
    var i = _find_index(id)
    if i < 0
        return nil
    end
    return _s['members'][i]
end

# count of members currently typed PRODUCER (excluding a given id)
def _producer_count(except_id)
    var n = 0
    for m : _s['members']
        if m.find('type', 'CONSUMER') == 'PRODUCER' && m.find('id', nil) != except_id
            n += 1
        end
    end
    return n
end

def _is_int(x)
    return type(x) == 'int' || type(x) == 'real'
end

def _save_registry()
    var f = nil
    try
        f = open(_s['file'], 'w')
        f.write('{"members":')
        f.write(json.dump(_s['members']))
        # spec 009 FR-903: persist the vZEV master data alongside members;
        # written only when non-empty so pre-009 files stay bit-identical
        if _s['info'] != nil && size(_s['info']) > 0
            f.write(',"info":')
            f.write(json.dump(_s['info']))
        end
        f.write('}')
        fsx.close_q(f)
        f = nil
    except .. as e
        fsx.close_q(f)
        logger.logMsg(logger.lWarn, f"vzev: save registry failed: {e}")
    end
end

# upsert a member map {id,name,location,type,url}. Enforces exactly one
# PRODUCER (FR-505): a second producer is rejected (returns nil).
def upsert_member(m)
    var id = m.find('id', nil)
    if id == nil || id == ''
        logger.logMsg(logger.lWarn, "vzev: upsert without id ignored")
        return nil
    end
    var typ = m.find('type', 'CONSUMER')
    if typ != 'PRODUCER' && typ != 'CONSUMER'
        typ = 'CONSUMER'
    end
    if typ == 'PRODUCER' && _producer_count(id) > 0
        logger.logMsg(logger.lWarn, f"vzev: rejecting second PRODUCER '{id}'")
        return nil
    end
    var idx = _find_index(id)
    var rec
    if idx < 0
        rec = {'id': id, 'added_ts': m.find('added_ts', 0)}
        _s['members'].push(rec)
    else
        rec = _s['members'][idx]
    end
    rec['name']     = m.find('name', rec.find('name', id))
    rec['location'] = m.find('location', rec.find('location', ''))
    rec['type']     = typ
    rec['url']      = m.find('url', rec.find('url', ''))
    if !rec.contains('added_ts') || rec['added_ts'] == 0
        rec['added_ts'] = m.find('added_ts', 0)
    end
    # optional spec 009 FR-902 fields: metering point (Zählpunkt, string
    # <= 40) and entry timestamp (utc int). Only overwritten when supplied
    # so legacy peers (which never send them) keep any existing value and
    # flat/legacy configs round-trip unchanged.
    var mp = m.find('metering_point', nil)
    if mp != nil
        if type(mp) == 'string' && size(mp) <= 40
            rec['metering_point'] = mp
        end
    end
    var ets = m.find('entry_ts', nil)
    if ets != nil && _is_int(ets)
        rec['entry_ts'] = int(ets)
    end
    _save_registry()
    return rec
end

# --- compact peer-slot storage (FR-503, NFR-502, issue #4) ----------------
# Per member, per UTC day, an append-only file /.vz_<san(id)>_<dayno> holds
# "<ts-delta>,<imp>,<exp>\n" lines. VZ_KEEP_DAYS files are kept per member.
# Correcting an existing slot (a late/out-of-order retransmit with a
# different value) APPENDS a fresh line rather than rewriting in place —
# every reader treats duplicate ts entries as last-line-wins, so no line-wise
# rewrite is ever needed on this path (unlike store.be's set_vzev, which
# patches an already-served 15m/1d/1mo record).

def _san(id)
    var out = ''
    var n = size(id)
    if n > 20
        n = 20
    end
    var i = 0
    while i < n
        var c = id[i]
        if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c == '_' || c == '-'
            out += c
        else
            out += '_'
        end
        i += 1
    end
    return out
end

def _vz_path(san, dayno)
    return _s['prefix'] + VZ_BUCKET + san + '_' + str(dayno)
end

def _full_path(name)
    if _s['dir'] == '.'
        return name
    elif _s['dir'] == '/'
        return '/' + name
    end
    return _s['dir'] + '/' + name
end

def _enc_slot_line(delta, imp, exp)
    return str(delta) + ',' + str(imp) + ',' + str(exp) + '\n'
end

# decode one line -> [delta, imp, exp], or nil if not '\n'-terminated (a
# torn trailing append) or malformed
def _parse_vz_line(line)
    var n = size(line)
    if n < 2 || line[n - 1] != '\n'
        return nil
    end
    var toks = string.split(line[0 .. n - 2], ',')
    if size(toks) != 3
        return nil
    end
    return [int(toks[0]), int(toks[1]), int(toks[2])]
end

def _count_vz_lines(path)
    var n = 0
    var f = nil
    try
        f = open(path, 'r')
        var line = f.readline()
        while size(line) > 0
            if _parse_vz_line(line) != nil
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

# maximum ts across all (possibly out-of-order/duplicate) lines in a bucket
def _max_vz_ts(path, dayno)
    var best = nil
    var f = nil
    try
        f = open(path, 'r')
        var base = dayno * 86400
        var line = f.readline()
        while size(line) > 0
            var p = _parse_vz_line(line)
            if p != nil
                var ts = base + p[0]
                if best == nil || ts > best
                    best = ts
                end
            end
            line = f.readline()
        end
        fsx.close_q(f)
        f = nil
    except ..
        fsx.close_q(f)
    end
    return best
end

# discover a member's kept day buckets on flash (prunes to VZ_KEEP_DAYS,
# populates vznb/newest). Lazy — runs once per member per boot, the first
# time that member's data is touched.
def _newest_scan(id, san)
    var daynos = fsx.list_daynos(_s['dir'], _s['stem'] + VZ_BUCKET + san + '_')
    while size(daynos) > VZ_KEEP_DAYS
        var old = daynos[0]
        fsx.remove(_vz_path(san, old))
        daynos.remove(0)
    end
    var nb = {}
    var newest_ts = -1
    for d : daynos
        var cnt = _count_vz_lines(_vz_path(san, d))
        if cnt > 0
            nb[d] = cnt
            var best = _max_vz_ts(_vz_path(san, d), d)
            if best != nil && best > newest_ts
                newest_ts = best
            end
        end
    end
    _s['vznb'][id] = nb
    _s['newest'][id] = newest_ts
    return newest_ts
end

def _touch_vz_dayno(id, san, dayno)
    var nb = _s['vznb'][id]
    if !nb.contains(dayno)
        nb[dayno] = 0
        if size(nb) > VZ_KEEP_DAYS
            # never evict the dayno just added above (see store.be's
            # _touch_dayno for the backward-clock-step rationale)
            var min_d = nil
            for d : nb.keys()
                if d != dayno && (min_d == nil || d < min_d)
                    min_d = d
                end
            end
            if min_d != nil
                nb.remove(min_d)
                fsx.remove(_vz_path(san, min_d))
            end
        end
    end
end

# scan one bucket for the LAST (most recent write) line matching `ts`
def _peer_slot_scan(san, dayno, ts)
    var result = nil
    var f = nil
    try
        f = open(_vz_path(san, dayno), 'r')
        var target = ts - dayno * 86400
        var line = f.readline()
        while size(line) > 0
            var p = _parse_vz_line(line)
            if p != nil && p[0] == target
                result = [p[1], p[2]]
            end
            line = f.readline()
        end
        fsx.close_q(f)
        f = nil
    except ..
        fsx.close_q(f)
    end
    return result
end

# store (or correct) a peer's slot. New-ts append is the hot path (no scan);
# an update to an already-stored ts is deduped (identical value -> skipped)
# to avoid unbounded growth from repeated legacy (untargeted) req answers.
def _store_peer_slot(id, ts, imp, exp)
    var san = _san(id)
    if !_s['newest'].contains(id)
        _newest_scan(id, san)
    end
    var newest = _s['newest'][id]
    var dayno = fsx.dayno(ts)
    if ts > newest
        _touch_vz_dayno(id, san, dayno)
        fsx.append_line(_vz_path(san, dayno), _enc_slot_line(ts - dayno * 86400, imp, exp))
        _s['vznb'][id][dayno] += 1
        _s['newest'][id] = ts
        return
    end
    var nb = _s['vznb'][id]
    if !nb.contains(dayno)
        return   # bucket no longer retained -- nothing to correct
    end
    var existing = _peer_slot_scan(san, dayno, ts)
    if existing != nil && existing[0] == imp && existing[1] == exp
        return   # identical duplicate -- skip
    end
    fsx.append_line(_vz_path(san, dayno), _enc_slot_line(ts - dayno * 86400, imp, exp))
    nb[dayno] += 1
end

# newest stored slot ts for a member, or nil
def newest_peer_ts(id)
    if !_s['newest'].contains(id)
        _newest_scan(id, _san(id))
    end
    var ts = _s['newest'][id]
    return ts < 0 ? nil : ts
end

# [imp, exp] for a member's slot ts, or nil
def peer_slot(id, ts)
    var san = _san(id)
    if !_s['vznb'].contains(id)
        _newest_scan(id, san)
    end
    var dayno = fsx.dayno(ts)
    if !_s['vznb'][id].contains(dayno)
        return nil
    end
    return _peer_slot_scan(san, dayno, ts)
end

# test/deployment hook: wipe every .vz_* bucket file under the current prefix
# + RAM caches
def reset_data()
    var names = fsx.listdir(_s['dir'])
    var pat = _s['stem'] + VZ_BUCKET
    var plen = size(pat)
    for n : names
        if size(n) > plen && n[0 .. plen - 1] == pat
            fsx.remove(_full_path(n))
        end
    end
    _s['vznb'] = {}
    _s['newest'] = {}
end

def remove_member(id)
    var idx = _find_index(id)
    if idx < 0
        return false
    end
    _s['members'].remove(idx)
    _save_registry()
    var san = _san(id)
    if !_s['vznb'].contains(id)
        _newest_scan(id, san)
    end
    var nb = _s['vznb'].find(id, nil)
    if nb != nil
        for d : nb.keys()
            fsx.remove(_vz_path(san, d))
        end
    end
    _s['vznb'].remove(id)
    _s['newest'].remove(id)
    return true
end

def load_registry()
    var members = []
    var info = {}
    var f = nil
    try
        f = open(_s['file'], 'r')
        var raw = f.read()
        fsx.close_q(f)
        f = nil
        var d = json.load(raw)
        if d != nil
            var ms = d.find('members', [])
            for m : ms
                if m.find('id', nil) != nil
                    members.push(m)
                end
            end
            var inf = d.find('info', nil)
            if isinstance(inf, map)
                info = inf
            end
        end
    except .. as e
        fsx.close_q(f)
        logger.logMsg(logger.lInfo, f"vzev: no registry yet ({e})")
    end
    _s['members'] = members
    _s['info']    = info
end

# --- vZEV master data (spec 009 FR-903) -----------------------------------

def get_info()
    # 'enabled': the vZEV nav entry stays hidden until the user opts in
    # from Einstellungen. Existing installs that already have members
    # configured keep working without an extra click; a brand-new site
    # (the common case) defaults OFF.
    return {
        'representative_name':    _s['info'].find('representative_name', ''),
        'representative_contact': _s['info'].find('representative_contact', ''),
        'connection_point_id':    _s['info'].find('connection_point_id', ''),
        'enabled':                _s['info'].find('enabled', size(_s['members']) > 0)
    }
end

def _to_bool(v)
    if type(v) == 'string'
        return v == 'true' || v == '1'
    end
    if type(v) == 'int' || type(v) == 'real'
        return v != 0
    end
    return v == true
end

# merge the supplied fields (the three known string keys + 'enabled',
# coerced) and persist. Returns the resulting info map.
def set_info(m)
    if !isinstance(m, map)
        return get_info()
    end
    for k : ['representative_name', 'representative_contact', 'connection_point_id']
        var v = m.find(k, nil)
        if v != nil
            _s['info'][k] = str(v)
        end
    end
    var en = m.find('enabled', nil)
    if en != nil
        _s['info']['enabled'] = _to_bool(en)
    end
    _save_registry()
    return get_info()
end

# --- discovery (FR-502) ---------------------------------------------------

def get_discovered()
    return _s['discovered']
end

# drop discovery entries older than DISCOVER_TTL. Called every second from
# tick(): the dead-list is allocated LAZILY so the common case (nothing
# expired, usually nothing discovered) allocates nothing on the tiny heap.
def _expire_discovered(now)
    if size(_s['discovered']) == 0
        return
    end
    var dead = nil
    for id : _s['discovered'].keys()
        if now - _s['discovered'][id].find('last_seen', 0) > DISCOVER_TTL
            if dead == nil dead = [] end
            dead.push(id)
        end
    end
    if dead != nil
        for id : dead
            _s['discovered'].remove(id)
        end
    end
end

# --- producer identity ----------------------------------------------------

def _producer_id()
    for m : _s['members']
        if m.find('type', 'CONSUMER') == 'PRODUCER'
            return m.find('id', nil)
        end
    end
    # the local site itself may be the producer. It never appears in its
    # OWN members list (own announcements are filtered out of discovery,
    # see _on_ann, and there is no "add myself" path in the member form)
    # — so fall back to the same "has productions -> producer" check
    # _send_announcement() already uses to tell PEERS about itself.
    # Without this, /api/vzev/raw's producer_id stays nil and the browser
    # cannot allocate at all (billing empty).
    try
        import site
        var prods = site.get_productions()
        if prods != nil && size(prods) > 0
            return _site_id()
        end
    except ..
    end
    return nil
end

# the community tariff subset (TAR_KEYS) from this device's own site.json,
# or nil when unconfigured/unavailable. A producer advertises this in its
# announcements so every member's browser prices the same Wh identically.
def _vzev_tariffs()
    try
        import site
        var t = site.get_tariffs()
        if t == nil
            return nil
        end
        var out = {}
        for k : TAR_KEYS
            var v = t.find(k, nil)
            if v != nil
                out[k] = v
            end
        end
        return size(out) > 0 ? out : nil
    except ..
        return nil
    end
end

# the tariffs billing must use: the producer's own site.json when this
# device IS the producer, else the last set advertised by the registered
# producer (nil until its first announcement arrives).
def _billing_tariffs()
    var pid = _producer_id()
    if pid != nil && pid == _site_id()
        return _vzev_tariffs()
    end
    return _s['producer_tar']
end

# --- UDP protocol (FR-502/503/504/508) ------------------------------------

# build & serialize the outbound payloads (kept pure for tests).
# tar (optional, producer only): the community tariff subset — omitted
# entirely when nil so consumer announcements stay unchanged.
def make_ann(site_id, name, loc, typ, url, tar)
    var m = {'t': 'ann', 'site': site_id, 'name': name,
             'loc': loc, 'typ': typ, 'url': url}
    if tar != nil
        m['tar'] = tar
    end
    return json.dump(m)
end

def make_slot(site_id, ts, imp, exp)
    return json.dump({'t': 'slot', 'site': site_id, 'ts': ts,
                      'imp': imp, 'exp': exp})
end

# peer (optional): the site whose slots are wanted. When present, ONLY that
# peer answers (_on_req), so a single gap request no longer triggers a
# resend from every device on the group (answer storm). Omitted -> legacy
# broadcast where every device answers (kept for mixed-version fleets).
def make_req(site_id, from_ts, to_ts, peer)
    var m = {'t': 'req', 'site': site_id, 'from_ts': from_ts, 'to_ts': to_ts}
    if peer != nil
        m['peer'] = peer
    end
    return json.dump(m)
end

def _send(payload)
    try
        import udpdriver
        udpdriver.send(payload)
    except .. as e
        logger.logMsg(logger.lWarn, f"vzev: send failed: {e}")
    end
end

# store this device's own slot, then multicast it (spec 011 FR-1123)
def announce_slot(ts, imp, exp)
    var id = _site_id()
    if id == nil
        return
    end
    _store_peer_slot(id, ts, imp, exp)
    _send(make_slot(id, ts, imp, exp))
end

def _on_ann(d, from_ip)
    var id = d.find('site', nil)
    if id == nil
        return
    end
    var self_id = _site_id()
    if id == self_id
        return          # our own announcement
    end
    var url = d.find('url', from_ip == nil ? '' : ('http://' + from_ip + '/'))
    _s['discovered'][id] = {
        'id':        id,
        'name':      d.find('name', id),
        'loc':       d.find('loc', ''),
        'typ':       d.find('typ', 'C'),
        'url':       url,
        'last_seen': _now()
    }
    # adopt the community tariffs advertised by the REGISTERED producer
    # (cross-site cost consistency; ignored from anyone else)
    var tar = d.find('tar', nil)
    if tar != nil && id == _producer_id()
        _s['producer_tar'] = tar
    end
end

def _on_slot(d)
    var id = d.find('site', nil)
    if id == nil
        return
    end
    # only accept slots from REGISTERED members (no silent joins, UC-501)
    if get_member(id) == nil
        return
    end
    var ts  = d.find('ts', nil)
    var imp = d.find('imp', 0)
    var exp = d.find('exp', 0)
    if ts == nil
        return
    end
    # sanity-bound a peer's slot ts (issue #4): a wildly wrong ts would
    # otherwise create a stray day-bucket file. Skipped while our own RTC
    # isn't synced yet (ts would be compared against a bogus `now`).
    var now = _now()
    if now >= 1000000000 && (ts < now - VZ_KEEP_DAYS * 86400 || ts > now + SLOT_SECS)
        return
    end
    _store_peer_slot(id, ts, imp, exp)          # stores + dedupes by (id,ts)
end

# answer from our own bucket file for one day, up to `sent` -> REQ_MAX_SLOTS
def _answer_from_bucket(san, dayno, from_ts, to_ts, sent, self_id)
    var f = nil
    try
        f = open(_vz_path(san, dayno), 'r')
        var base = dayno * 86400
        var line = f.readline()
        while size(line) > 0 && sent < REQ_MAX_SLOTS
            var p = _parse_vz_line(line)
            if p != nil
                var ts = base + p[0]
                if ts >= from_ts && ts <= to_ts
                    _send(make_slot(self_id, ts, p[1], p[2]))
                    sent += 1
                end
            end
            line = f.readline()
        end
        fsx.close_q(f)
        f = nil
    except ..
        fsx.close_q(f)
    end
    return sent
end

def _on_req(d)
    var from_ts = d.find('from_ts', nil)
    var to_ts   = d.find('to_ts', nil)
    if from_ts == nil || to_ts == nil
        return
    end
    var self_id = _site_id()
    if self_id == nil
        return
    end
    # a targeted request is answered ONLY by the named peer; anyone else
    # stays quiet (no answer storm). An untargeted (legacy) req -> we answer.
    var peer = d.find('peer', nil)
    if peer != nil && peer != self_id
        return
    end
    var san = _san(self_id)
    var d_to = fsx.dayno(to_ts)
    var d_start = fsx.dayno(from_ts)
    if d_to - (VZ_KEEP_DAYS - 1) > d_start
        d_start = d_to - (VZ_KEEP_DAYS - 1)
    end
    var sent = 0
    var day = d_start
    while day <= d_to && sent < REQ_MAX_SLOTS
        sent = _answer_from_bucket(san, day, from_ts, to_ts, sent, self_id)
        day += 1
    end
end

# udpdriver receive callback. msg = {from, timestamp, msg:<string>}.
def on_receive(msg)
    # forward to any chained consumer first (do not steal messages)
    if _s['prev_cb'] != nil
        try
            _s['prev_cb'](msg)
        except .. as e
            logger.logMsg(logger.lWarn, f"vzev: chained cb error: {e}")
        end
    end
    var payload = msg.find('msg', nil)
    if type(payload) != 'string' || size(payload) == 0
        return
    end
    # new-protocol messages are JSON objects; the legacy URL advert is a
    # bare "http://..." string with no leading '{' -> ignored here (C-1)
    if payload[0] != '{'
        return
    end
    var d = json.load(payload)
    if d == nil
        return
    end
    var t = d.find('t', nil)
    if t == 'ann'
        _on_ann(d, msg.find('from', nil))
    elif t == 'slot'
        _on_slot(d)
    elif t == 'req'
        _on_req(d)
    end
end

# explicit chaining: remember a prior callback and forward to it
def set_prev_callback(cb)
    _s['prev_cb'] = cb
end

# Install our receive handler, CHAINING any previously registered udpdriver
# callback so existing consumers keep working (FR-508): the prior cb is
# snapshotted via get_on_receive() and forwarded to from on_receive. Callers
# can also wire chaining explicitly via set_prev_callback.
def install_receiver()
    try
        import udpdriver
        var prev = udpdriver.get_on_receive()
        if prev != nil
            _s['prev_cb'] = prev
        end
        udpdriver.set_on_receive(/ msg -> on_receive(msg))
        logger.logMsg(logger.lInfo, "vzev: receiver installed")
    except .. as e
        logger.logMsg(logger.lWarn, f"vzev: install_receiver failed: {e}")
    end
end

# request a peer's missing slots since our newest stored slot for it.
# rate-limited to one request per REQ_MIN_GAP seconds.
def request_gap(peer_id, now)
    if now - _s['last_req'] < REQ_MIN_GAP
        return false
    end
    var newest = newest_peer_ts(peer_id)
    var from_ts = newest == nil ? 0 : newest + SLOT_SECS
    var self_id = _site_id()
    # target the request at the lagging peer so only it resends (not all)
    _send(make_req(self_id, from_ts, now, peer_id))
    _s['last_req'] = now
    return true
end

# --- driver ticks ---------------------------------------------------------

def _send_announcement(now)
    var id = _site_id()
    if id == nil
        return
    end
    var name = id
    var loc = ''
    var url = ''
    var typ = 'C'
    try
        import site
        var s = site.get_site()
        if s != nil
            name = s.find('name', id)
            loc  = s.find('location', '')
        end
        var prods = site.get_productions()
        if prods != nil && size(prods) > 0
            typ = 'P'
        end
        var w = tasmota.wifi()
        if w != nil && w.contains('ip')
            url = 'http://' + w['ip'] + '/'
        end
    except ..
    end
    # a producer piggybacks its community tariffs on the announcement so
    # consumers price billing with the SAME rates (no extra HTTP, tiny map)
    var tar = typ == 'P' ? _vzev_tariffs() : nil
    _send(make_ann(id, name, loc, typ, url, tar))
end

# periodic announcement (every ANN_INTERVAL) + discovery expiry.
def tick()
    var now = _now()
    if now < 1000000000        # RTC not synced yet
        return
    end
    _expire_discovered(now)
    if now - _s['last_ann'] >= ANN_INTERVAL
        _send_announcement(now)
        _s['last_ann'] = now
    end
    # retransmission (FR-504): when a registered peer that is currently
    # online (recent ann in discovered) is missing recent slots, broadcast
    # a gap request for the peer lagging furthest behind. request_gap()
    # rate-limits to one packet per REQ_MIN_GAP; every receiver answers
    # with its OWN slots in range and _store_peer_slot dedupes, so dropped
    # multicast packets converge instead of leaving permanent gaps.
    if now - _s['last_req'] >= REQ_MIN_GAP
        var closed = now - now % SLOT_SECS - SLOT_SECS
        # right after a close, tolerate a peer that has not announced the
        # just-closed slot yet (normal announce latency)
        var need = now % SLOT_SECS >= REQ_SETTLE_S ? closed : closed - SLOT_SECS
        var self_id = _site_id()
        var worst = nil
        var worst_ts = 0
        for m : _s['members']
            var id = m.find('id', nil)
            if id == nil || id == self_id
                continue
            end
            if _s['discovered'].find(id, nil) == nil
                continue
            end
            var newest = newest_peer_ts(id)
            var ts = newest == nil ? 0 : newest
            if ts < need && (worst == nil || ts < worst_ts)
                worst = id
                worst_ts = ts
            end
        end
        if worst != nil
            request_gap(worst, now)
        end
    end
end

def every_second()
    tick()
end

# --- API endpoints (FR-507, streamed) -------------------------------------

# registry state only — liveness (`discovered`/`last_seen`) is served by
# /api/vzev/discovered and joined by id in the browser (spec 011 step 1).
def _member_state(m)
    var out = {
        'id':       m.find('id', nil),
        'name':     m.find('name', m.find('id', nil)),
        'location': m.find('location', ''),
        'type':     m.find('type', 'CONSUMER'),
        'url':      m.find('url', ''),
        'added_ts': m.find('added_ts', 0)
    }
    # spec 009 FR-902 optional fields, only present when configured so
    # legacy consumers see no new keys
    if m.contains('metering_point')
        out['metering_point'] = m['metering_point']
    end
    if m.contains('entry_ts')
        out['entry_ts'] = m['entry_ts']
    end
    return out
end

def _send_json(code, s)
    import webserver
    webserver.content_open(code, 'application/json')
    webserver.content_send(s)
    webserver.content_close()
end

def _typ_expand(t)
    if t == 'P' || t == 'PRODUCER'
        return 'PRODUCER'
    end
    return 'CONSUMER'
end

def _members_mutate()
    import webserver
    var action = webserver.arg('action')
    if action == 'remove'
        var id = webserver.arg('id')
        var ok = remove_member(id)
        _send_json(200, json.dump({'ok': ok}))
        return
    end
    if action == 'upsert'
        var m = {
            'id':       webserver.arg('id'),
            'name':     webserver.has_arg('name') ? webserver.arg('name') : nil,
            'location': webserver.has_arg('loc')  ? webserver.arg('loc')  : nil,
            'type':     _typ_expand(webserver.has_arg('typ') ? webserver.arg('typ') : 'C')
        }
        if webserver.has_arg('url')
            m['url'] = webserver.arg('url')
        end
        # spec 009 FR-902 optional query args (metering point + entry ts)
        if webserver.has_arg('mp')
            m['metering_point'] = webserver.arg('mp')
        end
        if webserver.has_arg('entry')
            m['entry_ts'] = int(webserver.arg('entry'))
        end
        var rec = upsert_member(m)
        if rec == nil
            _send_json(400, '{"error":"upsert rejected (id missing or second producer)"}')
            return
        end
        _send_json(200, json.dump(rec))
        return
    end
    _send_json(400, '{"error":"unknown action"}')
end

def members_request()
    import webserver
    if webserver.has_arg('action')
        return _members_mutate()
    end
    webserver.content_open(200, 'application/json')
    webserver.content_send('[')
    var first = true
    for m : _s['members']
        webserver.content_send((first ? '' : ',') + json.dump(_member_state(m)))
        first = false
    end
    webserver.content_send(']')
    webserver.content_close()
end

def discovered_request()
    import webserver
    var now = _now()
    _expire_discovered(now)
    webserver.content_open(200, 'application/json')
    webserver.content_send('[')
    var first = true
    for id : _s['discovered'].keys()
        webserver.content_send((first ? '' : ',') + json.dump(_s['discovered'][id]))
        first = false
    end
    webserver.content_send(']')
    webserver.content_close()
end

# /api/vzev/info (spec 009 FR-903): GET reads the vZEV master data;
# GET ?action=set&representative_name=..&representative_contact=..&
# connection_point_id=.. mutates it (same query-arg pattern as members).
def info_request()
    import webserver
    if webserver.has_arg('action') && webserver.arg('action') == 'set'
        var m = {}
        for k : ['representative_name', 'representative_contact', 'connection_point_id']
            if webserver.has_arg(k)
                m[k] = webserver.arg(k)
            end
        end
        if webserver.has_arg('enabled')
            m['enabled'] = webserver.arg('enabled')
        end
        _send_json(200, json.dump(set_info(m)))
        return
    end
    _send_json(200, json.dump(get_info()))
end

# /api/vzev/raw -> {"producer_id":..,"self_id":..,"tariffs":..,
#                   "data":{id:[ts,imp,exp,...]}}
# "tariffs" is the community tariff set (producer-authoritative, null until
# known) — the browser prices billing with it on EVERY site identically.
# The RAW per-member peer-slot rings. The browser (frontend lib/vzev.js) runs
# allocate() per slot, buckets to 15m/1d/1mo and builds the quarterly billing
# from this — no allocated-series or billing math ever runs on the device
# heap. Privacy (FR-509): the rings carry only the imp/exp Wh already
# exchanged over multicast; no load states or totals.
# Streaming buffer — same rationale as webservice.be's _new_buf/_put/_flush.
# Berry strings are immutable, so the former `buf += _enc_slot_v(...)` loop
# reallocated the whole batch on EVERY slot value. A full member ring is 240
# slots = 720 ~6-byte pieces, which made GET /api/vzev/raw by far the biggest
# allocator on the device (hundreds of KB of garbage per member, per request).
# `bytes` appends in place; the only strings built are one asstring() per
# flushed ~1 KB chunk. Chunking stays at ~1 KB — one content_send per slot
# value would be 720 TCP chunks and stall the single-threaded VM.
var RAW_BATCH = 1024

def _raw_new_buf()
    var b = bytes()
    b.resize(RAW_BATCH + 64)
    b.clear()
    return b
end

def _raw_flush(b)
    import webserver
    if size(b) > 0
        webserver.content_send(b.asstring())
        b.clear()
    end
end

def _raw_put(b, s)
    b .. s
    if size(b) >= RAW_BATCH
        _raw_flush(b)
    end
end

# current members + self (real ids, not sanitized) — the set raw_request
# reports data for
def _raw_ids()
    var ids = []
    for m : _s['members']
        var mid = m.find('id', nil)
        if mid != nil
            ids.push(mid)
        end
    end
    var self_id = _site_id()
    if self_id != nil
        var found = false
        for id : ids
            if id == self_id
                found = true
            end
        end
        if !found
            ids.push(self_id)
        end
    end
    return ids
end

def raw_request()
    import webserver
    try import site site.note_serving() except .. end
    webserver.content_open(200, 'application/json')
    var tar = _billing_tariffs()
    webserver.content_send('{"producer_id":' + json.dump(_producer_id()) +
                           ',"self_id":' + json.dump(_site_id()) +
                           ',"tariffs":' + (tar == nil ? 'null' : json.dump(tar)) +
                           ',"data":{')
    var b = _raw_new_buf()
    var first_id = true
    for id : _raw_ids()
        var san = _san(id)
        if !_s['vznb'].contains(id)
            _newest_scan(id, san)
        end
        var nb = _s['vznb'].find(id, nil)
        if nb == nil || size(nb) == 0
            continue
        end
        var dnos = []
        for d : nb.keys()
            dnos.push(d)
        end
        fsx.sort_ints(dnos)
        if !first_id
            b .. ','
        end
        first_id = false
        _raw_put(b, json.dump(id))
        b .. ':['
        # stream each bucket in ~1 KB batches — a full member's history
        # (VZ_KEEP_DAYS*96 triples) as one json.dump would spike the heap
        var first_val = true
        for d : dnos
            var f = nil
            try
                f = open(_vz_path(san, d), 'r')
                var base = d * 86400
                var line = f.readline()
                while size(line) > 0
                    var p = _parse_vz_line(line)
                    if p != nil
                        if !first_val
                            b .. ','
                        end
                        first_val = false
                        _raw_put(b, str(base + p[0]) + ',' + str(p[1]) + ',' + str(p[2]))
                    end
                    line = f.readline()
                end
                fsx.close_q(f)
                f = nil
            except ..
                fsx.close_q(f)
            end
        end
        b .. ']'
    end
    b .. '}}'
    _raw_flush(b)
    webserver.content_close()
end

def web_add_handler()
    import webserver
    webserver.on('/api/vzev/members',    /-> members_request(),    webserver.HTTP_GET)
    webserver.on('/api/vzev/discovered', /-> discovered_request(), webserver.HTTP_GET)
    webserver.on('/api/vzev/info',       /-> info_request(),       webserver.HTTP_GET)
    webserver.on('/api/vzev/raw',        /-> raw_request(),        webserver.HTTP_GET)
end

# --- lifecycle ------------------------------------------------------------

def start()
    load_registry()
    # no migration (issue #4): the pre-bucket peer-data file is just removed;
    # peer-slot buckets are discovered lazily per member (_newest_scan)
    fsx.remove('/vzevdata.json')
    install_receiver()
    var w = tasmota.wifi()
    if w != nil && w.find('up', false)
        web_add_handler()
    end
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, "vzev started (/api/vzev/*)")
end

def stop()
    tasmota.remove_driver(_driver)
    logger.logMsg(logger.lInfo, "vzev stopped")
end

def save_before_restart()
    stop()
end

_driver = drivershim.make({
    'every_second': every_second,
    'web_add_handler': web_add_handler,
    'save_before_restart': save_before_restart
})

vzev.start          = start
vzev.stop           = stop
vzev.get_members    = get_members
vzev.get_member     = get_member
vzev.upsert_member  = upsert_member
vzev.remove_member  = remove_member
vzev.get_discovered = get_discovered
vzev.get_info       = get_info
vzev.set_info       = set_info
vzev.make_ann       = make_ann
vzev.make_slot      = make_slot
vzev.make_req       = make_req
vzev.on_receive     = on_receive
vzev.set_prev_callback = set_prev_callback
vzev.announce_slot  = announce_slot
vzev.request_gap    = request_gap
vzev.set_file       = set_file
vzev.set_prefix     = set_prefix
vzev.reset_data     = reset_data
vzev.set_self_id    = set_self_id
vzev.load_registry  = load_registry
vzev.tick           = tick
vzev.newest_peer_ts = newest_peer_ts
vzev.peer_slot      = peer_slot
# request handlers exported for the tests (were reached via _instance before)
vzev.members_request    = members_request
vzev.discovered_request = discovered_request
vzev.info_request       = info_request
vzev.raw_request        = raw_request

return vzev
