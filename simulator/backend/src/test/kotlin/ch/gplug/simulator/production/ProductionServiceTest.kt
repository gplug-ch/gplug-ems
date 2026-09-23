package ch.gplug.simulator.production

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ProductionServiceTest {

    private var now = 1_000_000L

    private fun battery(soc: Double = 50.0) = Production(
        id = "bat", siteId = "s", productionType = ProductionType.BATTERY,
        maxPower = 5000, capacityWh = 10_000, maxChargePower = 4000, soc = soc
    )

    private fun service(vararg p: Production) = ProductionService(p.toList()) { now }

    private fun hours(h: Double) { now += (h * 3_600_000).toLong() }

    @Test
    fun `battery accepts a signed power within its charge and discharge limits`() {
        val svc = service(battery())
        assertEquals(-4000, svc.setPower("s", "bat", -4000).currentPower)
        assertEquals(5000, svc.setPower("s", "bat", 5000).currentPower)
        assertThrows<IllegalArgumentException> { svc.setPower("s", "bat", -4001) }
        assertThrows<IllegalArgumentException> { svc.setPower("s", "bat", 5001) }
    }

    @Test
    fun `photovoltaic still rejects negative power`() {
        val pv = Production("pv", "s", ProductionType.PHOTOVOLTAIC, 5000)
        val svc = service(pv)
        assertThrows<IllegalArgumentException> { svc.setPower("s", "pv", -1) }
        assertNull(svc.findById("s", "pv")!!.soc)
    }

    @Test
    fun `soc follows the power over time`() {
        val svc = service(battery(soc = 50.0))
        svc.setPower("s", "bat", -2000)          // charge 2 kW
        hours(1.0)
        assertEquals(70.0, svc.findById("s", "bat")!!.soc!!, 1e-6)
        svc.setPower("s", "bat", 1000)           // discharge 1 kW
        hours(2.0)
        assertEquals(50.0, svc.findById("s", "bat")!!.soc!!, 1e-6)
    }

    @Test
    fun `soc clamps at the limits and the flow stops`() {
        val svc = service(battery(soc = 90.0))
        svc.setPower("s", "bat", -4000)
        hours(1.0)                                // would reach 130 %
        val full = svc.findById("s", "bat")!!
        assertEquals(100.0, full.soc!!, 1e-6)
        assertEquals(0, full.currentPower)
        // a full battery cannot be told to charge, but may discharge
        assertEquals(0, svc.setPower("s", "bat", -1000).currentPower)
        assertEquals(1000, svc.setPower("s", "bat", 1000).currentPower)
    }

    @Test
    fun `empty battery stops discharging`() {
        val svc = service(battery(soc = 5.0))
        svc.setPower("s", "bat", 5000)
        hours(1.0)
        val empty = svc.findAllBySiteId("s").single()
        assertEquals(0.0, empty.soc!!, 1e-6)
        assertEquals(0, empty.currentPower)
    }
}
