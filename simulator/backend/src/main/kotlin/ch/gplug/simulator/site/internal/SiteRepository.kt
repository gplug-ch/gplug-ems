package ch.gplug.simulator.site.internal

import ch.gplug.simulator.site.Site

class SiteRepository(sites: List<Site>) {

    private val sitesMap: Map<String, Site> = sites.associateBy { it.id }

    fun findAll(): List<Site> = sitesMap.values.toList()

    fun findById(id: String): Site? = sitesMap[id]
}
