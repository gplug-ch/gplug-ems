package ch.gplug.simulator.meter.internal

import ch.gplug.simulator.meter.MeterService
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * Exposes the synthesised smart-meter descriptor so the EMS device can poll it
 * via its `simulator` integration:
 *
 *   GET /simulator/sites/{siteId}/meter[?variant=full|basis|minimal]
 *
 * The response body is the raw `z`-shaped object (matching what a physical
 * gPlug reports under `tasmota.read_sensors()` key `z`). `variant` lets a
 * developer exercise the three real-world meter shapes the «Zähler» page must
 * degrade across: the extended CIP list (full), the 15-element Basisliste
 * (no per-phase power), and a Pi/Po-only descriptor (minimal).
 */
@RestController
@RequestMapping("/sites/{siteId}/meter")
class MeterController(private val meterService: MeterService) {

    @GetMapping
    fun getMeter(
        @PathVariable siteId: String,
        @RequestParam(required = false) variant: String?,
    ): ResponseEntity<Map<String, Any>> {
        val v = when (variant?.lowercase()) {
            "basis" -> MeterService.Variant.BASIS
            "minimal" -> MeterService.Variant.MINIMAL
            else -> MeterService.Variant.FULL
        }
        val descriptor = meterService.read(siteId, v)
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(descriptor)
    }
}
