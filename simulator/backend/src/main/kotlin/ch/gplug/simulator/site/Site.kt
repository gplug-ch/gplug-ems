package ch.gplug.simulator.site

import ch.gplug.simulator.grid.Grid
import ch.gplug.simulator.load.Load
import ch.gplug.simulator.production.Production

data class Site(
    val id: String,
    val name: String,
    val loads: List<Load>,
    val productions: List<Production>,
    val grid: Grid? = null
)
