package ch.gplug.simulator.load.internal

import ch.gplug.simulator.load.Load
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.load.LoadState
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/sites/{siteId}/loads")
class LoadController(private val loadService: LoadService) {

    @GetMapping
    fun listLoads(@PathVariable siteId: String): ResponseEntity<List<Load>> =
        ResponseEntity.ok(loadService.findBySiteId(siteId))

    @GetMapping("/{loadId}")
    fun getLoad(
        @PathVariable siteId: String,
        @PathVariable loadId: String
    ): ResponseEntity<Load> {
        val load = loadService.findLoad(siteId, loadId)
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(load)
    }

    @PutMapping("/{loadId}/state")
    fun setState(
        @PathVariable siteId: String,
        @PathVariable loadId: String,
        @RequestBody body: StateRequest
    ): ResponseEntity<Load> {
        return try {
            if (body.state == LoadState.WAITING) {
                ResponseEntity.ok(loadService.setWaiting(siteId, loadId))
            } else if (body.state == LoadState.ACTIVE) {
                ResponseEntity.ok(loadService.setActive(siteId, loadId))
            } else {
                ResponseEntity.ok(loadService.setInactive(siteId, loadId))
            }
        } catch (e: NoSuchElementException) {
            ResponseEntity.notFound().build()
        }
    }
}

data class StateRequest(val state: LoadState)
