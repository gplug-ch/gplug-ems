package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.grid.Grid
import ch.gplug.simulator.grid.GridMeter
import ch.gplug.simulator.grid.GridService
import ch.gplug.simulator.load.Load
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.load.LoadState
import ch.gplug.simulator.load.LoadType
import ch.gplug.simulator.production.Production
import ch.gplug.simulator.production.ProductionService
import ch.gplug.simulator.production.ProductionType
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals

class ModbusBindingsTest {

    private val productions = ProductionService(
        listOf(
            Production("pv", "s", ProductionType.PHOTOVOLTAIC, 5000),
            Production("bat", "s", ProductionType.BATTERY, 3000, capacityWh = 10_000, maxChargePower = 3000, soc = 42.0)
        )
    )
    private val grid = GridService(listOf(Grid("s", GridMeter("in", "Import"), GridMeter("out", "Export"))))
    private val loads = LoadService(listOf(Load("boiler", "Boiler", LoadType.BOILER, 1, 60_000, 0, "s")))
    private val bindings = ModbusBindings(productions, grid, loads)

    @Test
    fun `readers follow production, battery, grid and load state`() {
        val pv = bindings.reader("s/pv/currentPower")
        val bat = bindings.reader("s/bat/currentPower")
        val soc = bindings.reader("s/bat/soc")
        val import = bindings.reader("s/input/currentPower")
        val export = bindings.reader("s/out/currentPower")
        val state = bindings.reader("s/boiler/state")

        productions.setPower("s", "pv", 1234)
        productions.setPower("s", "bat", -2000)
        grid.setPower("s", "in", 800)
        loads.setWaiting("s", "boiler")

        assertEquals(1234.0, pv())
        assertEquals(-2000.0, bat())
        assertEquals(42.0, soc(), 0.1)
        assertEquals(800.0, import())
        assertEquals(0.0, export())
        assertEquals(1.0, state())
    }

    @Test
    fun `writers run simulator actions`() {
        bindings.writer("s/pv/currentPower")(2500.4)
        assertEquals(2500, productions.findById("s", "pv")!!.currentPower)
        bindings.writer("s/output/currentPower")(300.0)
        assertEquals(300, grid.findBySiteId("s")!!.output.currentPower)
        bindings.writer("s/boiler/state")(2.0)
        assertEquals(LoadState.ACTIVE, loads.findLoad("s", "boiler")!!.state)
        bindings.writer("s/boiler/state")(0.0)
        assertEquals(LoadState.INACTIVE, loads.findLoad("s", "boiler")!!.state)
        assertThrows<IllegalArgumentException> { bindings.writer("s/boiler/state")(3.0) }
        assertThrows<IllegalArgumentException> { bindings.writer("s/pv/currentPower")(-1.0) }
    }

    @Test
    fun `bad paths fail at startup`() {
        assertThrows<IllegalArgumentException> { bindings.reader("s/pv") }
        assertThrows<IllegalArgumentException> { bindings.reader("s/nope/currentPower") }
        assertThrows<IllegalArgumentException> { bindings.reader("s/pv/voltage") }
        assertThrows<IllegalArgumentException> { bindings.writer("s/bat/soc") }
        assertThrows<IllegalArgumentException> { bindings.reader("other/pv/currentPower") }
    }
}
