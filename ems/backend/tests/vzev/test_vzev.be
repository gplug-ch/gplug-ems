# Tests for vzev.be (spec 005).
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_vzev.be
#
# Covers: allocation determinism / exact-sum / largest-remainder edge cases,
# message serialize+parse+dispatch, chained receive callback, registry
# upsert/remove persistence, and billing aggregation.
#
# Stubs (assigned WITHOUT 'var' so they are true globals visible to vzev.be
# under 'import strict') stand in for the Tasmota runtime, which is absent in
# the Berry CLI.

# --- Tasmota stub ------------------------------------------------------------
var _rtc_utc = 2000000000     # a fixed, RTC-synced time for deterministic tests

class _TasmotaStub
    def rtc()          return {'utc': _rtc_utc} end
    def wifi()         return {'up': false, 'ip': '192.168.0.99'} end
    def add_driver(d)  end
    def remove_driver(d) end
    def set_timer(a, b) end
end
tasmota = _TasmotaStub()

# --- importable stubs live alongside this test -------------------------------
# vzev.be handlers do lazy `import webserver` / `import store` / `import site`.
# This test runs from its OWN directory (tests/vzev/) via
# `berry -m ../.. test_vzev.be`, so the stub store.be / webserver.be / site.be
# next to it shadow the real backend modules (Berry searches the script's own
# directory first). Keeping them here — not in tests/ — means they never
# shadow the real `store`/`site` for test_store.be / other suites.
import json
import vzev
import webserver
import store
import udpdriver
import site

var passed = 0
def check(cond, msg)
    assert(cond, f"[FAIL] {msg}")
    passed += 1
end

# ---------------------------------------------------------------------------
# Message serialize / parse / dispatch
# ---------------------------------------------------------------------------
var before = passed

var ann = vzev.make_ann('site-a', 'PV Hof', 'Hofweg 1', 'P', 'http://10.0.0.1/')
var pa = json.load(ann)
check(pa['t'] == 'ann' && pa['site'] == 'site-a' && pa['typ'] == 'P', "make_ann roundtrip")
check(ann[0] == '{', "ann payload starts with '{'")

var slot = vzev.make_slot('site-b', 172800000, 1500, 0)
var ps = json.load(slot)
check(ps['t'] == 'slot' && ps['ts'] == 172800000 && ps['imp'] == 1500, "make_slot roundtrip")
# privacy FR-509: slot carries ONLY t/site/ts/imp/exp
var slot_keys = []
for k : ps.keys() slot_keys.push(k) end
check(size(slot_keys) == 5, f"slot has only 5 fields (privacy): {slot_keys}")

var req = vzev.make_req('site-a', 100, 200)
var pr = json.load(req)
check(pr['t'] == 'req' && pr['from_ts'] == 100 && pr['to_ts'] == 200, "make_req roundtrip")

# dispatch: an "ann" from an unknown site populates discovery
vzev.set_file('/tmp/vzev_test_reg.json')
vzev.set_prefix('/tmp/vzev_test_data_')
vzev.reset_data()
vzev.load_registry()   # start clean (no members)
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_ann('site-x', 'X', 'loc', 'C', 'http://10.0.0.5/')})
var disc = vzev.get_discovered()
check(disc.contains('site-x'), "ann populates discovery")
check(disc['site-x']['name'] == 'X', "discovery name captured")

# a "slot" from an UNKNOWN (unregistered) member is ignored (no silent joins)
vzev.on_receive({'from': '10.0.0.6', 'msg': vzev.make_slot('site-unknown', 172800000, 100, 0)})
check(vzev.peer_slot('site-unknown', 172800000) == nil, "unregistered slot ignored")

# legacy URL advert (bare string, no '{') must be ignored, not error
vzev.on_receive({'from': '10.0.0.7', 'msg': 'http://10.0.0.7/'})
check(true, "legacy url advert ignored without error")

# chained callback: a prior consumer still receives every message (FR-508)
var chained_seen = []
vzev.set_prev_callback(def(m) chained_seen.push(m.find('msg', '')) end)
vzev.on_receive({'from': '10.0.0.8', 'msg': 'http://10.0.0.8/'})
vzev.on_receive({'from': '10.0.0.9', 'msg': vzev.make_ann('site-y', 'Y', 'l', 'C', 'u')})
check(size(chained_seen) == 2, "chained callback saw both messages")
vzev.set_prev_callback(nil)

print(f"Protocol tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# Registry upsert / remove / persistence
# ---------------------------------------------------------------------------
before = passed
import os

vzev.set_file('/tmp/vzev_test_reg2.json')
try os.remove('/tmp/vzev_test_reg2.json') except .. end
vzev.load_registry()
check(size(vzev.get_members()) == 0, "registry starts empty")

var m = vzev.upsert_member({'id': 'site-a', 'name': 'Producer', 'location': 'Hof', 'type': 'PRODUCER', 'url': 'http://a/'})
check(m != nil && m['type'] == 'PRODUCER', "upsert producer")
vzev.upsert_member({'id': 'site-b', 'name': 'Müller', 'type': 'CONSUMER', 'url': 'http://b/'})
check(size(vzev.get_members()) == 2, "two members after upsert")

# second PRODUCER rejected (FR-505: exactly one producer)
var rej = vzev.upsert_member({'id': 'site-c', 'name': 'C', 'type': 'PRODUCER'})
check(rej == nil, "second producer rejected")
check(size(vzev.get_members()) == 2, "rejected producer not added")

# edit existing (rename) keeps count, changes name
vzev.upsert_member({'id': 'site-b', 'name': 'Familie Müller', 'type': 'CONSUMER'})
check(vzev.get_member('site-b')['name'] == 'Familie Müller', "rename member")
check(size(vzev.get_members()) == 2, "rename does not duplicate")

# persistence: reload from file, members survive
vzev.load_registry()
check(size(vzev.get_members()) == 2, "members persist across reload")
check(vzev.get_member('site-b')['name'] == 'Familie Müller', "renamed name persisted")

# remove
check(vzev.remove_member('site-b') == true, "remove returns true")
check(vzev.get_member('site-b') == nil, "member gone after remove")
vzev.load_registry()
check(size(vzev.get_members()) == 1, "removal persisted")
check(vzev.remove_member('nope') == false, "remove missing returns false")

print(f"Registry tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# Peer-slot storage (issue #4): append-only bucket files, correction +
# dedupe + newest, lazy discovery of on-disk buckets
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg3.json')
try os.remove('/tmp/vzev_test_reg3.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data3_')
vzev.reset_data()
vzev.load_registry()
vzev.upsert_member({'id': 'peer', 'name': 'P', 'type': 'CONSUMER'})


var t0 = _rtc_utc - 50 * 900
var t1 = _rtc_utc - 49 * 900

# out-of-order inserts still resolve correctly; a correction (same ts,
# DIFFERENT value) is appended and wins on read (last-write); the store is
# still append-only, so this is exercised as "the newest write for that ts"
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('peer', t0, 100, 0)})
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('peer', t1, 200, 0)})
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('peer', t0, 150, 0)})   # correction
check(vzev.peer_slot('peer', t0)[0] == 150, "corrected slot value wins (last write)")
check(vzev.peer_slot('peer', t1)[0] == 200, "second slot stored")
check(vzev.newest_peer_ts('peer') == t1, "newest peer ts")

# an IDENTICAL duplicate (e.g. a repeated legacy req answer) is a no-op —
# guards against unbounded bucket-file growth
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('peer', t0, 150, 0)})
check(vzev.peer_slot('peer', t0)[0] == 150, "identical duplicate is a no-op")

# a fresh member id never touched this session: its bucket file is written
# directly (bypassing on_receive) to prove peer_slot/newest_peer_ts discover
# and scan it cold from flash, not from an in-RAM ring
var t2 = _rtc_utc - 48 * 900
var dayno3 = t2 / 86400
var coldf = open('/tmp/vzev_test_data3_.vz_coldpeer_' + str(dayno3), 'w')
coldf.write(str(t2 - dayno3 * 86400) + ',77,3\n')
coldf.close()
check(vzev.peer_slot('coldpeer', t2)[0] == 77, "peer_slot discovers an on-disk bucket cold")
check(vzev.newest_peer_ts('coldpeer') == t2, "newest_peer_ts discovers an on-disk bucket cold")

print(f"Storage tests passed ({passed - before} checks)")

# NOTE: quarter-range parsing, flows bucketing (15m/1d/1mo) and billing
# aggregation moved to the BROWSER (frontend lib/vzev.js) and are covered by
# frontend node tests (tests/test_vzev_lib.mjs). The device only serves the raw
# per-member rings via /api/vzev/raw (smoke-tested below); since spec 011
# step 3b it does not allocate at all.

# ---------------------------------------------------------------------------
# API endpoint smoke: /api/vzev/members streams member state, privacy safe
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg5.json')
try os.remove('/tmp/vzev_test_reg5.json') except .. end
vzev.load_registry()
vzev.upsert_member({'id': 'site-a', 'name': 'Prod', 'type': 'PRODUCER', 'url': 'http://a/'})

webserver.set_args({})
vzev.members_request()
var body = json.load(webserver.body())
check(classname(body) == 'list' && size(body) == 1, "members endpoint returns list")
check(body[0]['id'] == 'site-a' && body[0]['type'] == 'PRODUCER', "members endpoint content")
check(!body[0].contains('discovered') && !body[0].contains('last_seen'),
      "members endpoint carries registry state only (liveness comes from /discovered)")

# upsert via query args
webserver.set_args({'action': 'upsert', 'id': 'site-b', 'name': 'B', 'typ': 'C'})
vzev.members_request()
check(vzev.get_member('site-b') != nil, "upsert via API args")

# remove via query args
webserver.set_args({'action': 'remove', 'id': 'site-b'})
vzev.members_request()
check(vzev.get_member('site-b') == nil, "remove via API args")

# raw endpoint returns {producer_id, self_id, data:{...}} for browser compute
webserver.set_args({})
vzev.raw_request()
var raw = json.load(webserver.body())
check(classname(raw) == 'instance' || raw != nil, "raw endpoint returns object")
check(raw.contains('producer_id') && raw.contains('data'), "raw endpoint shape")

print(f"API tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# Member optional fields metering_point / entry_ts (spec 009 FR-902)
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg_mp.json')
try os.remove('/tmp/vzev_test_reg_mp.json') except .. end
vzev.load_registry()

# direct upsert stores + validates the two optional fields
vzev.upsert_member({'id': 'site-a', 'name': 'A', 'type': 'PRODUCER',
                    'metering_point': 'CH1001234567890', 'entry_ts': 1700000000})
var ma = vzev.get_member('site-a')
check(ma['metering_point'] == 'CH1001234567890', "metering_point stored on upsert")
check(ma['entry_ts'] == 1700000000, "entry_ts stored on upsert")

# a member without the fields does NOT gain empty keys (legacy round-trip)
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER'})
var mb = vzev.get_member('site-b')
check(!mb.contains('metering_point'), "no metering_point key when unset")
check(!mb.contains('entry_ts'), "no entry_ts key when unset")

# over-long metering point (> 40) is rejected silently (field not set)
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER',
                    'metering_point': '0123456789012345678901234567890123456789X'})
check(!vzev.get_member('site-b').contains('metering_point'), "over-long metering_point rejected")

# editing without the fields keeps previously stored values (partial update)
vzev.upsert_member({'id': 'site-a', 'name': 'A2', 'type': 'PRODUCER'})
check(vzev.get_member('site-a')['metering_point'] == 'CH1001234567890', "metering_point kept on partial edit")

# persistence: fields survive a reload, absent fields stay absent
vzev.load_registry()
check(vzev.get_member('site-a')['entry_ts'] == 1700000000, "entry_ts persisted across reload")
check(!vzev.get_member('site-b').contains('entry_ts'), "unset field stays absent after reload")

# API upsert via query args (mp / entry) + surfaced in members endpoint
webserver.set_args({'action': 'upsert', 'id': 'site-c', 'name': 'C', 'typ': 'C',
                    'mp': 'CH1009999999999', 'entry': '1699999999'})
vzev.members_request()
var mc = json.load(webserver.body())
check(mc['metering_point'] == 'CH1009999999999', "mp arg surfaced in upsert response")
check(mc['entry_ts'] == 1699999999, "entry arg surfaced in upsert response")

print(f"Member-fields tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# vZEV master data endpoint /api/vzev/info (spec 009 FR-903)
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg_info.json')
try os.remove('/tmp/vzev_test_reg_info.json') except .. end
vzev.load_registry()

# unset -> read returns the three keys empty (stable shape for the frontend)
webserver.set_args({})
vzev.info_request()
var info = json.load(webserver.body())
check(info['representative_name'] == '' && info['representative_contact'] == '' &&
      info['connection_point_id'] == '', "info read returns empty stable shape")
check(info['enabled'] == false, "info read defaults enabled to false with no members")

# set via query args -> merged + echoed back
webserver.set_args({'action': 'set', 'representative_name': 'Anna Muster',
                    'representative_contact': 'anna@vzev.ch', 'connection_point_id': 'CP-42'})
vzev.info_request()
info = json.load(webserver.body())
check(info['representative_name'] == 'Anna Muster', "info set representative_name")
check(info['connection_point_id'] == 'CP-42', "info set connection_point_id")

# partial set merges (only supplied key changes)
webserver.set_args({'action': 'set', 'representative_contact': 'new@vzev.ch'})
vzev.info_request()
info = json.load(webserver.body())
check(info['representative_name'] == 'Anna Muster', "partial set keeps other fields")
check(info['representative_contact'] == 'new@vzev.ch', "partial set updates supplied field")

# 'enabled': explicit toggle via query arg, both directions
webserver.set_args({'action': 'set', 'enabled': 'true'})
vzev.info_request()
info = json.load(webserver.body())
check(info['enabled'] == true, "info enabled set via query arg")

webserver.set_args({'action': 'set', 'enabled': 'false'})
vzev.info_request()
info = json.load(webserver.body())
check(info['enabled'] == false, "info enabled can be turned back off")

# persistence across reload; members still round-trip alongside info
vzev.upsert_member({'id': 'site-a', 'name': 'A', 'type': 'PRODUCER'})
vzev.load_registry()
check(vzev.get_info()['representative_name'] == 'Anna Muster', "info persisted across reload")
check(size(vzev.get_members()) == 1, "members coexist with info in registry file")
check(vzev.get_info()['enabled'] == false,
      "explicit enabled=false persists across reload despite existing members")

print(f"vZEV info tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# 'enabled' default for pre-existing installs: a registry that already has
# members configured (upgraded from spec 009, never touched the new toggle)
# must default to enabled=true so the nav entry does not vanish for existing
# vZEV users; a fresh site with no members defaults to false.
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg_enabled_default.json')
try os.remove('/tmp/vzev_test_reg_enabled_default.json') except .. end
vzev.load_registry()
check(vzev.get_info()['enabled'] == false, "fresh site with no members defaults enabled=false")

vzev.upsert_member({'id': 'site-p', 'name': 'P', 'type': 'PRODUCER'})
check(vzev.get_info()['enabled'] == true, "existing members without an explicit toggle default enabled=true")

vzev.load_registry()
check(vzev.get_info()['enabled'] == true, "member-based default survives a registry reload")

print(f"vZEV enabled-default tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# announce_slot: stores the own slot + multicasts it, and NEVER touches store
# (spec 011 FR-1123 — the browser derives the allocation from /api/vzev/raw)
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg6.json')
try os.remove('/tmp/vzev_test_reg6.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data6_')
vzev.reset_data()
vzev.load_registry()
store.reset()
udpdriver.clear()

vzev.set_self_id('site-me')
vzev.upsert_member({'id': 'site-p', 'name': 'PV', 'type': 'PRODUCER'})
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER'})

var st = _rtc_utc - 70 * 900
vzev.announce_slot(st, 500, 0)

# stored under the OWN site id, readable through the normal peer accessors
var own = vzev.peer_slot('site-me', st)
check(own != nil && own[0] == 500 && own[1] == 0, f"own slot stored: {own}")
check(vzev.newest_peer_ts('site-me') == st, "own newest ts tracked")

# ...and multicast as a 'slot' message for the peers
var sent = udpdriver.sent()
check(size(sent) == 1, f"announce_slot must send exactly one packet, got {size(sent)}")
var sm = json.load(sent[0])
check(sm['t'] == 'slot' && sm['site'] == 'site-me' && sm['ts'] == st &&
      sm['imp'] == 500 && sm['exp'] == 0, f"slot payload wrong: {sent[0]}")

# no allocation, no write-back: the store stub must never be called
check(store.count() == 0, "announce_slot must not touch store (no set_vzev)")

# a peer's slot arriving later does not trigger a write either
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('site-p', st, 0, 2000)})
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('site-b', st, 1500, 0)})
check(store.count() == 0, "receiving peer slots must not touch store")
check(vzev.peer_slot('site-p', st)[1] == 2000, "peer slot still stored on receive")

# regression: a producer device that NEVER registers itself as a member.
# There is no UI path to add "yourself" (own announcements are filtered out
# of discovery, see _on_ann, and the member form has no id field) — so
# _producer_id() must resolve the local site via "has productions", the same
# signal _send_announcement() already uses to tell PEERS it is a producer.
# Before this fix /api/vzev/raw.producer_id stayed null (empty browser billing).
vzev.set_file('/tmp/vzev_test_reg8.json')
try os.remove('/tmp/vzev_test_reg8.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data8_')
vzev.reset_data()
vzev.load_registry()
vzev.set_self_id('site-p')
site.set_productions([{'id': 'pv1', 'productionType': 'PHOTOVOLTAIC'}])
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER'})  # only the peer — never self
var st3 = _rtc_utc - 72 * 900
vzev.on_receive({'from': 'x', 'msg': vzev.make_slot('site-b', st3, 400, 0)})
vzev.announce_slot(st3, 0, 2000)     # local (un-registered) producer exports 2000

webserver.set_args({})
vzev.raw_request()
var raw3 = json.load(webserver.body())
check(raw3['producer_id'] == 'site-p', "raw producer_id resolves to self via productions fallback")
check(raw3['data'].contains('site-p'), "the un-registered producer's own slots are served")

site.set_productions([])
vzev.set_self_id(nil)
print(f"announce_slot tests passed ({passed - before} checks)")

# Flows-resolution bucketing (res=15m|1d|1mo) moved to the browser and is
# covered by frontend tests/test_vzev_lib.mjs.

# ---------------------------------------------------------------------------
# Retransmission wiring (FR-504): tick() requests gaps from lagging peers
# (via the tests/vzev/udpdriver.be capture stub)
# ---------------------------------------------------------------------------
before = passed

vzev.set_file('/tmp/vzev_test_reg_gap.json')
try os.remove('/tmp/vzev_test_reg_gap.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data_gap_')
vzev.reset_data()
vzev.load_registry()
vzev.set_self_id('site-me')
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER'})

def sent_reqs()
    var out = []
    for p : udpdriver.sent()
        var d = json.load(p)
        if d != nil && d.find('t') == 'req'
            out.push(d)
        end
    end
    return out
end

# peer registered but never discovered (offline) -> no gap request
udpdriver.clear()
vzev.tick()
check(size(sent_reqs()) == 0, "no req for undiscovered peer")

# peer announces (discovered) but has no stored slots -> tick requests the gap
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_ann('site-b', 'B', 'l', 'C', 'u')})
udpdriver.clear()
vzev.tick()
var reqs = sent_reqs()
check(size(reqs) == 1, "gap request sent for lagging discovered peer")
check(reqs[0]['from_ts'] == 0 && reqs[0]['to_ts'] == _rtc_utc, "req covers full missing range")
check(reqs[0].find('peer') == 'site-b', "gap request targets the lagging peer only")

# rate limit: an immediate second tick sends no further request
udpdriver.clear()
vzev.tick()
check(size(sent_reqs()) == 0, "gap request rate-limited")

# peer catches up to the newest closed slot -> no request once the limit expires
_rtc_utc += 61
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_ann('site-b', 'B', 'l', 'C', 'u')})
var closed_slot = _rtc_utc - _rtc_utc % 900 - 900
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_slot('site-b', closed_slot, 100, 0)})
udpdriver.clear()
vzev.tick()
check(size(sent_reqs()) == 0, "no req when peer is up to date")

# _on_req answering: a legacy (untargeted) req triggers resends of OWN slots
vzev.announce_slot(closed_slot, 250, 0)
udpdriver.clear()
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_req('site-b', 0, _rtc_utc)})
def own_slots_resent()
    var out = []
    for p : udpdriver.sent()
        var d = json.load(p)
        if d != nil && d.find('t') == 'slot' && d['site'] == 'site-me'
            out.push(d)
        end
    end
    return out
end
var resent = own_slots_resent()
check(size(resent) == 1 && resent[0]['ts'] == closed_slot, "legacy req answered with own stored slots")

# targeted req naming ANOTHER peer is ignored (no answer storm)
udpdriver.clear()
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_req('site-b', 0, _rtc_utc, 'site-other')})
check(size(own_slots_resent()) == 0, "targeted req for another peer is not answered")

# targeted req naming US is answered
udpdriver.clear()
vzev.on_receive({'from': '10.0.0.5', 'msg': vzev.make_req('site-b', 0, _rtc_utc, 'site-me')})
check(size(own_slots_resent()) == 1, "targeted req naming us is answered")

print(f"Retransmission tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# Producer tariff sync: ann carries 'tar', consumers adopt + serve it on
# /api/vzev/raw so every site prices billing identically
# ---------------------------------------------------------------------------
before = passed

# make_ann without tar stays unchanged (no 'tar' key on the wire)
var ann_plain = json.load(vzev.make_ann('s', 'n', 'l', 'C', 'u'))
check(!ann_plain.contains('tar'), "ann without tariffs has no tar key")

vzev.set_file('/tmp/vzev_test_reg_tar.json')
try os.remove('/tmp/vzev_test_reg_tar.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data_tar_')
vzev.reset_data()
vzev.load_registry()
vzev.set_self_id('site-me')
vzev.upsert_member({'id': 'site-p', 'name': 'P', 'type': 'PRODUCER'})
vzev.upsert_member({'id': 'site-b', 'name': 'B', 'type': 'CONSUMER'})

var tar = {'vzev_import_chf_kwh': 0.25, 'vzev_export_chf_kwh': 0.125}

# tar from a NON-producer member is ignored
vzev.on_receive({'from': 'x', 'msg': vzev.make_ann('site-b', 'B', 'l', 'C', 'u', tar)})
webserver.set_args({})
vzev.raw_request()
var raw_t = json.load(webserver.body())
check(raw_t.find('tariffs') == nil, "non-producer tar ignored")

# tar from the registered producer is adopted and served
vzev.on_receive({'from': 'x', 'msg': vzev.make_ann('site-p', 'P', 'l', 'P', 'u', tar)})
vzev.raw_request()
raw_t = json.load(webserver.body())
check(raw_t.find('tariffs') != nil && raw_t['tariffs']['vzev_import_chf_kwh'] == 0.25,
      "producer tar adopted and served on /api/vzev/raw")

# producer device: serves the community subset of its OWN site.json tariffs
vzev.set_file('/tmp/vzev_test_reg_tar2.json')
try os.remove('/tmp/vzev_test_reg_tar2.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data_tar2_')
vzev.reset_data()
vzev.load_registry()
vzev.set_self_id('site-p2')
site.set_productions([{'id': 'pv', 'productionType': 'PHOTOVOLTAIC'}])
site.set_tariffs({'vzev_import_chf_kwh': 0.5, 'vzev_export_chf_kwh': 0.5,
                  'grid_import_chf_kwh': 0.26})
vzev.raw_request()
raw_t = json.load(webserver.body())
check(raw_t.find('tariffs') != nil && raw_t['tariffs']['vzev_import_chf_kwh'] == 0.5,
      "producer serves own tariff subset")
check(!raw_t['tariffs'].contains('grid_import_chf_kwh'), "non-community tariff keys filtered")

# ...and its periodic announcement carries them for consumers to adopt
_rtc_utc += 31         # past ANN_INTERVAL so tick() announces again
udpdriver.clear()
vzev.tick()
var ann_out = nil
for p : udpdriver.sent()
    var d = json.load(p)
    if d != nil && d.find('t') == 'ann'
        ann_out = d
    end
end
check(ann_out != nil && ann_out.find('tar') != nil
      && ann_out['tar']['vzev_import_chf_kwh'] == 0.5,
      "producer announcement carries community tariffs")

site.set_productions([])
site.set_tariffs(nil)
vzev.set_self_id(nil)
print(f"Tariff-sync tests passed ({passed - before} checks)")

# ---------------------------------------------------------------------------
# /api/vzev/raw multi-batch streaming: the ring is emitted through a reused
# `bytes` buffer flushed at ~1 KB (Berry strings are immutable, so the former
# `buf += piece` loop reallocated the whole batch per slot value). A ring long
# enough to cross several flush boundaries must still produce ONE valid JSON
# document with every value in ring order.
# ---------------------------------------------------------------------------
before = passed
vzev.set_file('/tmp/vzev_test_reg_raw.json')
try os.remove('/tmp/vzev_test_reg_raw.json') except .. end
vzev.set_prefix('/tmp/vzev_test_data_raw_')
vzev.reset_data()
vzev.load_registry()
vzev.upsert_member({'id': 'bigpeer', 'name': 'Big', 'type': 'CONSUMER'})

var slots = 200
var base = _rtc_utc - 300 * 900   # far from other sections' ts (avoids pending-map collisions)
var k = 0
while k < slots
    vzev.on_receive({'from': 'x',
                     'msg': vzev.make_slot('bigpeer', base + 900 * (k + 1), 100 + k, 10 + k)})
    k += 1
end

webserver.set_args({})
vzev.raw_request()          # content_open() clears the stub body
var rawbody = webserver.body()
check(size(rawbody) > 2048, f"test needs a multi-batch body, got {size(rawbody)} bytes")
var rawdoc = json.load(rawbody)
check(rawdoc != nil, "multi-batch raw body must be valid JSON")
var ring = rawdoc['data']['bigpeer']
check(size(ring) == slots * 3, f"ring must carry {slots * 3} values, got {size(ring)}")
check(ring[0] == base + 900 && ring[1] == 100 && ring[2] == 10, "first slot survives batching")
check(ring[(slots - 1) * 3] == base + 900 * slots, "last slot ts survives batching")
check(ring[(slots - 1) * 3 + 1] == 100 + slots - 1, "last slot imp survives batching")
check(ring[(slots - 1) * 3 + 2] == 10 + slots - 1, "last slot exp survives batching")
print(f"Raw-stream batching tests passed ({passed - before} checks)")

print("")
print(f"--- All vzev tests passed ({passed} checks) ---")
