package ch.gplug.simulator.grid

import org.slf4j.LoggerFactory

class GridService(grids: List<Grid>) {

    private val log = LoggerFactory.getLogger(GridService::class.java)
    private val gridBySiteId: Map<String, Grid> = grids.associateBy { it.siteId }

    fun findBySiteId(siteId: String): Grid? = gridBySiteId[siteId]

    fun setPower(siteId: String, meterId: String, power: Int): Grid {
        val grid = gridBySiteId[siteId]
            ?: throw NoSuchElementException("No grid for site $siteId")
        val meter = when (meterId) {
            grid.input.id -> grid.input
            grid.output.id -> grid.output
            else -> throw NoSuchElementException("No grid meter $meterId in site $siteId")
        }
        require(power >= 0) { "Power $power must not be negative" }
        synchronized(meter) {
            log.debug("Setting grid meter power for site {} id {} to {} W", siteId, meterId, power)
            meter.currentPower = power
        }
        return grid
    }
}
