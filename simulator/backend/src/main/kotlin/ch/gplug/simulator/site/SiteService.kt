package ch.gplug.simulator.site

import ch.gplug.simulator.grid.GridService
import ch.gplug.simulator.load.Load
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.production.ProductionService
import ch.gplug.simulator.site.internal.SiteRepository
import org.springframework.stereotype.Service

@Service
class SiteService(
    private val siteRepository: SiteRepository,
    private val loadService: LoadService,
    private val productionService: ProductionService,
    private val gridService: GridService
) {

    fun findAll(): List<Site> = siteRepository.findAll().map { it.enrich() }

    fun findById(id: String): Site? = siteRepository.findById(id)?.enrich()

    fun findLoad(siteId: String, loadId: String): Load? =
        loadService.findLoad(siteId, loadId)

    private fun Site.enrich() = copy(
        loads = loadService.findBySiteId(id),
        productions = productionService.findAllBySiteId(id),
        grid = gridService.findBySiteId(id)
    )
}
