# Minimal site stub for vzev.be's tests (shadows the real site.be, which pulls
# in tasmota-dependent integrations unavailable in the Berry CLI).
# get_site() returns nil (real site.be's own "not configured" shape, so
# _send_announcement's existing nil-check path is exercised the same way
# whether or not this stub is present). get_productions() is what
# _producer_id()'s "local site is itself the producer" fallback checks — same
# signal _send_announcement() already used to tell peers about itself.

var site = module()

site._productions = []
site._tariffs = nil

site.get_site = def() return nil end
site.get_productions = def() return site._productions end
# test helper: set_productions([{...}, ...]) — non-empty => local site is a producer
site.set_productions = def(p) site._productions = p end
# tariffs, as the real site.get_tariffs() serves them (merged over defaults);
# nil (default) exercises vzev's "tariffs unavailable" path
site.get_tariffs = def() return site._tariffs end
site.set_tariffs = def(t) site._tariffs = t end

return site
