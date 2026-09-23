package ch.gplug.simulator.modbus

import ch.gplug.simulator.modbus.ModbusDataType.FLOAT32
import ch.gplug.simulator.modbus.ModbusDataType.INT16
import ch.gplug.simulator.modbus.ModbusDataType.INT32
import ch.gplug.simulator.modbus.ModbusDataType.UINT16
import ch.gplug.simulator.modbus.ModbusDataType.UINT32
import org.junit.jupiter.api.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class ModbusCodecTest {

    private fun enc(v: Double, t: ModbusDataType, scale: Double = 1.0, swap: Boolean = false) =
        ModbusCodec.encode(v, t, scale, swap).toList()

    @Test
    fun `16-bit types are one big-endian word`() {
        assertEquals(listOf(0x1234), enc(0x1234.toDouble(), UINT16))
        assertEquals(listOf(0xFFFF), enc(-1.0, INT16))
        assertEquals(listOf(0x8000), enc(-32768.0, INT16))
        assertEquals(listOf(0xFFFF), enc(65535.0, UINT16))
    }

    @Test
    fun `32-bit types are ABCD, swapWords gives CDAB`() {
        assertEquals(listOf(0x0001, 0x86A0), enc(100_000.0, INT32))
        assertEquals(listOf(0x86A0, 0x0001), enc(100_000.0, INT32, swap = true))
        assertEquals(listOf(0xFFFF, 0xFFFE), enc(-2.0, INT32))
        assertEquals(listOf(0xFFFF, 0xFFFF), enc(4_294_967_295.0, UINT32))
        // 1234.5f = 0x449A5000
        assertEquals(listOf(0x449A, 0x5000), enc(1234.5, FLOAT32))
        assertEquals(listOf(0x5000, 0x449A), enc(1234.5, FLOAT32, swap = true))
        // swapWords has no effect on a single word
        assertEquals(listOf(0x0005), enc(5.0, UINT16, swap = true))
    }

    @Test
    fun `raw value is value divided by scale, rounded`() {
        assertEquals(listOf(4321), enc(43_214.0, INT16, scale = 10.0))
        assertEquals(listOf(505), enc(50.5, UINT16, scale = 0.1))
        assertEquals(listOf(0x3FC0, 0x0000), enc(1500.0, FLOAT32, scale = 1000.0)) // 1.5f
    }

    @Test
    fun `integers clamp to the dtype range`() {
        assertEquals(listOf(0x7FFF), enc(50_000.0, INT16))
        assertEquals(listOf(0x0000), enc(-10.0, UINT16))
        assertEquals(listOf(0x0000, 0x0000), enc(-10.0, UINT32))
        assertEquals(listOf(0x7FFF, 0xFFFF), enc(1e12, INT32))
        assertEquals(listOf(0), enc(Double.NaN, INT16))
    }

    @Test
    fun `decode inverts encode for every dtype, word order and scale`() {
        val cases = listOf(
            Triple(INT16, -1234.0, 1.0), Triple(UINT16, 50_000.0, 1.0),
            Triple(INT32, -123_456.0, 1.0), Triple(UINT32, 3_000_000_000.0, 1.0),
            Triple(FLOAT32, -42.25, 1.0), Triple(INT16, 12_340.0, 10.0),
            Triple(FLOAT32, 2500.0, 1000.0), Triple(UINT16, 55.5, 0.1)
        )
        for ((t, v, scale) in cases) for (swap in listOf(false, true)) {
            val words = ModbusCodec.encode(v, t, scale, swap)
            assertEquals(v, ModbusCodec.decode(words, t, scale, swap), 1e-9, "$t $v scale $scale swap $swap")
        }
    }

    @Test
    fun `decode matches the EMS client's reading of the bytes`() {
        // modbustcp.be: int16 geti(0,-2), uint32 get(0,-4) big-endian, swap = exchange words
        assertEquals(-2.0, ModbusCodec.decode(intArrayOf(0xFFFE), INT16))
        assertEquals(65_534.0, ModbusCodec.decode(intArrayOf(0xFFFE), UINT16))
        assertEquals(0x12345678.toDouble(), ModbusCodec.decode(intArrayOf(0x5678, 0x1234), UINT32, swapWords = true))
        assertContentEquals(intArrayOf(0x449A, 0x5000), ModbusCodec.encode(1234.5, FLOAT32))
    }
}
