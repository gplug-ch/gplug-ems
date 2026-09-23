package ch.gplug.simulator.site.internal

import ch.gplug.simulator.site.Site
import ch.gplug.simulator.site.SiteService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/sites")
class SiteController(private val siteService: SiteService) {

    @GetMapping
    fun listSites(): ResponseEntity<List<Site>> =
        ResponseEntity.ok(siteService.findAll())

    @GetMapping("/{siteId}")
    fun getSite(@PathVariable siteId: String): ResponseEntity<Site> {
        val site = siteService.findById(siteId)
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(site)
    }
}
