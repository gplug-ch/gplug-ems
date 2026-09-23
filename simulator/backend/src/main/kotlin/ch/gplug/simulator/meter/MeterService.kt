package ch.gplug.simulator.meter

import ch.gplug.simulator.grid.GridService
import java.time.Instant
import java.time.LocalTime
import kotlin.math.abs
import kotlin.math.sin

/**
 * Synthesises a realistic Tasmota Smart-Meter-Interface sensor object (the JSON
 * that a physical gPlug puts under key `z` in `tasmota.read_sensors()`) so the
 * «Zähler» page (EMS spec 007) can be developed without a real smart meter.
 *
 * The values are derived from the site's *live* grid + production state, so the
 * per-phase power/current move consistently with the rest of the simulation.
 * Energy registers (OBIS 1.8.0 / 2.8.0 …) are integrated on each read from the
 * grid power, so they climb monotonically like a real meter — which lets the
 * frontend's stale-counter heuristic (UC-704) be exercised end-to-end.
 *
 * The EMS device polls this via the `simulator` integration through its
 * one-op-per-tick scheduler and caches the descriptor; `GET /api/meter` then
 * serves it verbatim. All interpretation (labels, units, Schieflast, cosφ)
 * happens in the browser — this only produces the raw numbers.
 */
class MeterService(
    private val gridService: GridService,
) {
    enum class Variant { FULL, BASIS, MINIMAL }

    /** Per-site accumulating registers, integrated on read. */
    private data class Registers(
        var importWh: Double,
        var exportWh: Double,
        var reactiveImportVarh: Double,
        var reactiveExportVarh: Double,
        var lastMillis: Long,
    )

    private val registers = mutableMapOf<String, Registers>()

    /**
     * @return the raw `z`-shaped descriptor for [siteId], or null when the site
     *   has no grid (the EMS integration then treats it as no meter data).
     */
    @Synchronized
    fun read(siteId: String, variant: Variant = Variant.FULL): Map<String, Any>? {
        val grid = gridService.findBySiteId(siteId) ?: return null

        val importW = grid.input.currentPower.coerceAtLeast(0)
        val exportW = grid.output.currentPower.coerceAtLeast(0)
        val netW = importW - exportW // signed: import positive, export negative

        val reg = integrate(siteId, importW, exportW)

        val meterId = "LGZ${1030000000L + siteId.hashCode().toLong().and(0xFFFFFFL)}"

        // MINIMAL: a descriptor that exposes only the two configured power fields
        // (the gPlug default) — exercises the Pi/Po-only degradation path.
        if (variant == Variant.MINIMAL) {
            return linkedMapOf(
                "Meter_id" to meterId,
                "Pi" to importW,
                "Po" to exportW,
            )
        }

        // per-phase active power: a deliberately uneven split so the derived
        // «Schieflast» (max−min phase power) is non-zero and visible.
        val p1 = Math.round(netW * 0.36).toInt()
        val p2 = Math.round(netW * 0.33).toInt()
        val p3 = netW - p1 - p2

        // per-phase voltage: ~230 V with a stable per-phase offset plus a gentle
        // time wobble so the live table updates and Min/Max has something to track.
        val tt = Instant.now().epochSecond.toDouble()
        val u1 = round1(230.0 + 1.8 + 1.4 * sin(tt / 17.0))
        val u2 = round1(230.0 - 1.1 + 1.4 * sin(tt / 17.0 + 2.1))
        val u3 = round1(230.0 + 0.4 + 1.4 * sin(tt / 17.0 + 4.2))

        val i1 = current(p1, u1)
        val i2 = current(p2, u2)
        val i3 = current(p3, u3)

        // reactive power at ~cosφ 0.97 (tan φ ≈ 0.25)
        val q1 = Math.round(p1 * 0.25).toInt()
        val q2 = Math.round(p2 * 0.25).toInt()
        val q3 = Math.round(p3 * 0.25).toInt()

        val hour = LocalTime.now().hour
        val tariff = if (hour in 7 until 20) 1 else 2

        val z = linkedMapOf<String, Any>(
            "Meter_id" to meterId,
            // instantaneous power (OBIS 1.7.0 / 2.7.0 / 16.7.0)
            "Pi" to importW,
            "Po" to exportW,
            // per-phase voltage (32/52/72.7.0) and current (31/51/71.7.0)
            "U1" to u1, "U2" to u2, "U3" to u3,
            "I1" to i1, "I2" to i2, "I3" to i3,
            // energy registers (1.8.0 / 2.8.0), kWh
            "E_in" to round3(reg.importWh / 1000.0),
            "E_out" to round3(reg.exportWh / 1000.0),
            // active tariff (96.14.0): 1 = Hochtarif, 2 = Niedertarif
            "Tariff" to tariff,
        )

        // BASIS ("15-element Basisliste"): no per-phase active/reactive power,
        // no reactive-energy registers — the frontend must hide those rows/
        // sections entirely rather than render empty cells.
        if (variant == Variant.BASIS) {
            return z
        }

        // FULL extended CIP list: add net power, per-phase P/Q and reactive
        // energy registers (3.8.0 / 4.8.0).
        z["P"] = netW
        z["P1"] = p1; z["P2"] = p2; z["P3"] = p3
        z["Q1"] = q1; z["Q2"] = q2; z["Q3"] = q3
        z["Er_in"] = round3(reg.reactiveImportVarh / 1000.0)
        z["Er_out"] = round3(reg.reactiveExportVarh / 1000.0)
        return z
    }

    private fun integrate(siteId: String, importW: Int, exportW: Int): Registers {
        val now = System.currentTimeMillis()
        val reg = registers.getOrPut(siteId) {
            // seed with plausible meter mileage so the registers don't start at 0
            Registers(
                importWh = 12_345_678.0,
                exportWh = 3_210_000.0,
                reactiveImportVarh = 456_000.0,
                reactiveExportVarh = 78_000.0,
                lastMillis = now,
            )
        }
        val dtH = (now - reg.lastMillis) / 3_600_000.0
        if (dtH > 0) {
            reg.importWh += importW * dtH
            reg.exportWh += exportW * dtH
            reg.reactiveImportVarh += importW * 0.25 * dtH
            reg.reactiveExportVarh += exportW * 0.25 * dtH
            reg.lastMillis = now
        }
        return reg
    }

    private fun current(powerW: Int, voltage: Double): Double =
        if (voltage <= 0) 0.0 else round2(abs(powerW) / voltage)

    private fun round1(v: Double) = Math.round(v * 10.0) / 10.0
    private fun round2(v: Double) = Math.round(v * 100.0) / 100.0
    private fun round3(v: Double) = Math.round(v * 1000.0) / 1000.0
}
