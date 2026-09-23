package ch.gplug.simulator.production.internal

import ch.gplug.simulator.production.Production
import ch.gplug.simulator.production.ProductionService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/sites/{siteId}/productions")
class ProductionController(private val productionService: ProductionService) {

    @GetMapping
    fun listProductions(@PathVariable siteId: String): ResponseEntity<List<Production>> =
        ResponseEntity.ok(productionService.findAllBySiteId(siteId))

    @GetMapping("/{productionId}")
    fun getProduction(
        @PathVariable siteId: String,
        @PathVariable productionId: String
    ): ResponseEntity<Production> {
        val production = productionService.findById(siteId, productionId)
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(production)
    }

    @PutMapping("/{productionId}/power")
    fun setPower(
        @PathVariable siteId: String,
        @PathVariable productionId: String,
        @RequestBody body: PowerRequest
    ): ResponseEntity<Production> {
        return try {
            ResponseEntity.ok(productionService.setPower(siteId, productionId, body.power))
        } catch (e: NoSuchElementException) {
            ResponseEntity.notFound().build()
        } catch (e: IllegalArgumentException) {
            ResponseEntity.badRequest().build()
        }
    }
}

data class PowerRequest(val power: Int)
