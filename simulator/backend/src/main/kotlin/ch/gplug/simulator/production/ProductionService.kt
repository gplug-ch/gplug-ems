package ch.gplug.simulator.production

import org.slf4j.LoggerFactory

class ProductionService(
    productions: List<Production>,
    private val clock: () -> Long = System::currentTimeMillis
) {

    private val log = LoggerFactory.getLogger(ProductionService::class.java)
    private val productionBySiteId: Map<String, Production> = productions.associateBy { it.siteId }
    private val productionById: Map<String, Production> = productions.associateBy { it.id }
    // battery id -> time up to which its SoC has been integrated
    private val socMillis = mutableMapOf<String, Long>()

    fun findBySiteId(siteId: String): Production? = productionBySiteId[siteId]?.also(::advance)

    fun findAllBySiteId(siteId: String): List<Production> =
        productionById.values.filter { it.siteId == siteId }.onEach(::advance)

    fun findById(siteId: String, productionId: String): Production? =
        productionById[productionId]?.takeIf { it.siteId == siteId }?.also(::advance)

    fun setPower(siteId: String, productionId: String, power: Int): Production {
        val production = findById(siteId, productionId)
            ?: throw NoSuchElementException("No production $productionId in site $siteId")

        val min = if (production.productionType == ProductionType.BATTERY)
            -(production.maxChargePower ?: production.maxPower) else 0
        require(power in min..production.maxPower) {
            "Power $power out of range $min..${production.maxPower}"
        }

        synchronized(production) {
            log.debug("Setting production power for site {} id {} to {} W (range {}..{})", siteId, productionId, power, min, production.maxPower)
            production.currentPower = power
            // an empty battery cannot discharge, a full one cannot charge
            clampAtLimit(production)
        }
        return production
    }

    /**
     * Integrate a battery's SoC lazily up to now (read-time integration, like
     * the meter registers): discharging lowers it, charging raises it. At 0 %
     * or 100 % the SoC is clamped and the power drops to 0, as a real
     * battery management system would stop the flow.
     */
    private fun advance(p: Production) {
        if (p.productionType != ProductionType.BATTERY) return
        val cap = p.capacityWh ?: return
        if (cap <= 0 || p.soc == null) return
        synchronized(p) {
            val now = clock()
            val last = socMillis.put(p.id, now) ?: return
            val dtH = (now - last) / 3_600_000.0
            if (dtH <= 0) return
            val soc = p.soc!! - p.currentPower * dtH / cap * 100.0
            p.soc = soc.coerceIn(0.0, 100.0)
            clampAtLimit(p)
        }
    }

    private fun clampAtLimit(p: Production) {
        val soc = p.soc ?: return
        if ((soc <= 0.0 && p.currentPower > 0) || (soc >= 100.0 && p.currentPower < 0)) {
            log.debug("Battery {} at {} % SoC, power {} W -> 0", p.id, soc, p.currentPower)
            p.currentPower = 0
        }
    }
}
