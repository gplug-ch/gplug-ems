# Minimal udpdriver capture stub for vzev.be's tests (shadows the real
# messaging/udpdriver.be, which needs the Tasmota udp driver). vzev._send()
# lazily imports 'udpdriver' and calls send(payload); this stub records every
# payload so tests can assert what went out on the wire.

var udpdriver = module()

udpdriver._sent = []
udpdriver._cb   = nil

udpdriver.send  = def(p) udpdriver._sent.push(p) end
udpdriver.set_on_receive = def(cb) udpdriver._cb = cb end
udpdriver.get_on_receive = def() return udpdriver._cb end
# test helpers
udpdriver.sent  = def() return udpdriver._sent end
udpdriver.clear = def() udpdriver._sent = [] end

return udpdriver
