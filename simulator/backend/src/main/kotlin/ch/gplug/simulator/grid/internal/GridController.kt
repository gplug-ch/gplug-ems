package ch.gplug.simulator.grid.internal

import ch.gplug.simulator.grid.Grid
import ch.gplug.simulator.grid.GridMeter
import ch.gplug.simulator.grid.GridService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/sites/{siteId}/grid")
class GridController(private val gridService: GridService) {

    @GetMapping
    fun getGrid(@PathVariable siteId: String): ResponseEntity<Grid> {
        val grid = gridService.findBySiteId(siteId) ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(grid)
    }

    @GetMapping("/input")
    fun getInput(@PathVariable siteId: String): ResponseEntity<GridMeter> {
        val grid = gridService.findBySiteId(siteId) ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(grid.input)
    }

    @GetMapping("/output")
    fun getOutput(@PathVariable siteId: String): ResponseEntity<GridMeter> {
        val grid = gridService.findBySiteId(siteId) ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(grid.output)
    }

    @PutMapping("/{meterId}/power")
    fun setPower(
        @PathVariable siteId: String,
        @PathVariable meterId: String,
        @RequestBody body: PowerRequest
    ): ResponseEntity<Grid> {
        return try {
            ResponseEntity.ok(gridService.setPower(siteId, meterId, body.power))
        } catch (e: NoSuchElementException) {
            ResponseEntity.notFound().build()
        } catch (e: IllegalArgumentException) {
            ResponseEntity.badRequest().build()
        }
    }
}

data class PowerRequest(val power: Int)
