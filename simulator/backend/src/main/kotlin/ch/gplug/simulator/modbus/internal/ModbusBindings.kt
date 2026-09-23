package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.grid.GridService
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.load.LoadState
import ch.gplug.simulator.production.ProductionService
import kotlin.math.roundToInt

/**
 * Resolves binding paths `<siteId>/<itemId>/<field>` to live simulator
 * values (register `source`) and actions (register `action`):
 *
 * - production: `currentPower` (W, signed for a battery), `soc` (%, read only)
 * - grid meter (`input`/`output` or its id): `currentPower` (W)
 * - load: `state` (0 = INACTIVE, 1 = WAITING, 2 = ACTIVE)
 *
 * Values are read through the services on every call — a battery integrates
 * its SoC on read.
 */
class ModbusBindings(
    private val productionService: ProductionService,
    private val gridService: GridService,
    private val loadService: LoadService
) {
    private data class Path(val siteId: String, val itemId: String, val field: String)

    fun reader(path: String): () -> Double {
        val (siteId, itemId, field) = parse(path)
        productionService.findById(siteId, itemId)?.let {
            return when (field) {
                "currentPower" -> { -> productionService.findById(siteId, itemId)!!.currentPower.toDouble() }
                "soc" -> { -> productionService.findById(siteId, itemId)!!.soc ?: 0.0 }
                else -> unknownField(path)
            }
        }
        gridMeter(siteId, itemId)?.let { meter ->
            if (field != "currentPower") unknownField(path)
            return { meter.currentPower.toDouble() }
        }
        loadService.findLoad(siteId, itemId)?.let { load ->
            if (field != "state") unknownField(path)
            return { load.state.ordinal.toDouble() }
        }
        throw IllegalArgumentException("Unknown Modbus binding item '$path'")
    }

    fun writer(path: String): (Double) -> Unit {
        val (siteId, itemId, field) = parse(path)
        productionService.findById(siteId, itemId)?.let {
            if (field != "currentPower") unknownField(path)
            return { v -> productionService.setPower(siteId, itemId, v.roundToInt()) }
        }
        gridMeter(siteId, itemId)?.let { meter ->
            if (field != "currentPower") unknownField(path)
            return { v -> gridService.setPower(siteId, meter.id, v.roundToInt()) }
        }
        loadService.findLoad(siteId, itemId)?.let {
            if (field != "state") unknownField(path)
            return { v ->
                when (LoadState.entries.getOrNull(v.roundToInt())) {
                    LoadState.INACTIVE -> loadService.setInactive(siteId, itemId)
                    LoadState.WAITING -> loadService.setWaiting(siteId, itemId)
                    LoadState.ACTIVE -> loadService.setActive(siteId, itemId)
                    null -> throw IllegalArgumentException("Load state $v not in 0..2")
                }
            }
        }
        throw IllegalArgumentException("Unknown Modbus binding item '$path'")
    }

    private fun gridMeter(siteId: String, itemId: String) = gridService.findBySiteId(siteId)?.let { grid ->
        when (itemId) {
            "input", grid.input.id -> grid.input
            "output", grid.output.id -> grid.output
            else -> null
        }
    }

    private fun parse(path: String): Path {
        val parts = path.split("/")
        require(parts.size == 3 && parts.none { it.isBlank() }) {
            "Modbus binding '$path' must be <siteId>/<itemId>/<field>"
        }
        return Path(parts[0], parts[1], parts[2])
    }

    private fun unknownField(path: String): Nothing =
        throw IllegalArgumentException("Unknown field in Modbus binding '$path'")
}
