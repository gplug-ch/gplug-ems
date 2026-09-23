# udpdriver.be — UDP multicast transport for gPlug site-to-site messaging.
#
# Reads the multicast group/port from site.json's `messaging.udp` block
# (defaults 239.3.0.1:5007), wraps each payload in a {from,timestamp,msg} JSON
# envelope and polls the socket via the every_250ms() driver hook. One receive
# callback; vzev.be chains any prior one via get_on_receive() (FR-508). The
# former messaging/udpclient.be pass-through was folded in here (issue #9).

var udpdriver = module()

import strict
import json
import logger
import drivershim
import site

# Tasmota driver registration needs a class instance (see drivershim.be);
# assigned ONCE at module load, below the hook definitions.
var _driver

#- Default multicast group and port for gPlug UDP communication -#
udpdriver.MULTICAST_IP   = "239.3.0.1"
udpdriver.MULTICAST_PORT = 5007

# Module-private state: ONE map, mutated in place only (never reassign a
# top-level var from inside a function — see nethost.be for the Berry
# `import` upvalue caveat).
var _s = {
    'socket': nil,
    'on_receive': nil
}

def stop()
    tasmota.remove_driver(_driver)
    if _s['socket'] != nil
        _s['socket'].close()
        _s['socket'] = nil
    end
    logger.logMsg(logger.lInfo, "UdpDriver: stopped")
end

def start()
    var cfg = site.get_messaging_udp()
    if cfg == nil
        logger.logMsg(logger.lInfo, "UdpDriver: no messaging.udp config, not starting")
        return false
    end
    var multicast_ip = cfg.find("multicast_ip", udpdriver.MULTICAST_IP)
    var port         = cfg.find("port",         udpdriver.MULTICAST_PORT)
    var sock = udp()
    if !sock.begin_multicast(multicast_ip, port)
        logger.logMsg(logger.lWarn, f"UdpDriver: failed to join multicast {multicast_ip}:{port}")
        return false
    end
    _s['socket'] = sock
    tasmota.add_driver(_driver)
    logger.logMsg(logger.lInfo, f"UdpDriver: joined multicast {multicast_ip}:{port}")
    return true
end

# Register a callback invoked on every received message.
# Signature: cb(msg) where msg is a map {"from":..., "timestamp":..., "msg":...}
def set_on_receive(cb)
    _s['on_receive'] = cb
end

def get_on_receive()
    return _s['on_receive']
end

# true once start() joined the multicast group (and until stop())
def started()
    return _s['socket'] != nil
end

def _local_ip()
    var w = tasmota.wifi()
    if w != nil && w.contains("ip")
        return w["ip"]
    end
    return "0.0.0.0"
end

# Send msg (string) as a JSON-wrapped multicast datagram.
def send(msg)
    if _s['socket'] == nil
        logger.logMsg(logger.lWarn, "UdpDriver: not started, cannot send")
        return false
    end
    var payload = {
        "from":      _local_ip(),
        "timestamp": tasmota.rtc().find("utc", 0),
        "msg":       msg
    }
    var json_str = json.dump(payload)
    var result = _s['socket'].send_multicast(bytes().fromstring(json_str))
    if result
        # guarded: sends happen every ANN_INTERVAL + per slot/req — don't
        # build the f-string when the level filters it anyway
        if logger.enabled(logger.lDebug)
            logger.logMsg(logger.lDebug, f"UdpDriver: sent -> {json_str}")
        end
    else
        logger.logMsg(logger.lWarn, "UdpDriver: send_multicast failed")
    end
    return result
end

def every_250ms()
    var sock = _s['socket']
    if sock == nil return end
    var data = sock.read()
    if data == nil return end
    var msg_str = data.asstring()
    # Debug (was Info) + guarded: this fires for EVERY multicast packet from
    # every peer — an f-string allocation and serial write per packet is
    # steady heap churn in an active vZEV fleet
    if logger.enabled(logger.lDebug)
        logger.logMsg(logger.lDebug, f"UdpDriver: received from {sock.remote_ip}:{sock.remote_port} -> {msg_str}")
    end
    if _s['on_receive'] == nil return end
    var msg = json.load(msg_str)
    if msg == nil
        logger.logMsg(logger.lWarn, f"UdpDriver: invalid JSON ignored: {msg_str}")
        return
    end
    _s['on_receive'](msg)
end

_driver = drivershim.make({'every_250ms': every_250ms})

udpdriver.start          = start
udpdriver.stop           = stop
udpdriver.send           = send
udpdriver.set_on_receive = set_on_receive
udpdriver.get_on_receive = get_on_receive
udpdriver.started        = started

return udpdriver
