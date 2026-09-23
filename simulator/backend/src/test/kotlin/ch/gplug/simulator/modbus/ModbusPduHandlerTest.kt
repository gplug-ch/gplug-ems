package ch.gplug.simulator.modbus

import ch.gplug.simulator.modbus.ModbusDataType.FLOAT32
import ch.gplug.simulator.modbus.ModbusDataType.INT16
import ch.gplug.simulator.modbus.ModbusDataType.INT32
import ch.gplug.simulator.modbus.ModbusDataType.UINT16
import ch.gplug.simulator.modbus.ModbusTable.HOLDING
import ch.gplug.simulator.modbus.ModbusTable.INPUT
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals

class ModbusPduHandlerTest {

    private var live = 1500.0
    private var actionValue: Double? = null

    private val map = ModbusRegisterMap(
        listOf(
            ModbusRegister(1, INPUT, 100, INT16, reader = { live }),
            ModbusRegister(1, INPUT, 101, INT32, reader = { live }),
            ModbusRegister(1, HOLDING, 10, UINT16, initialValue = 7.0),
            ModbusRegister(1, HOLDING, 11, FLOAT32, initialValue = 1.5),
            ModbusRegister(1, HOLDING, 13, INT16, reader = { live }),
            ModbusRegister(1, HOLDING, 30, UINT16, writer = { v ->
                require(v <= 2) { "bad state" }
                actionValue = v
            }),
            ModbusRegister(2, HOLDING, 0, UINT16, initialValue = 2.0)
        )
    )
    private val handler = ModbusPduHandler(map)

    private fun pdu(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    private fun call(unit: Int, vararg b: Int) = handler.handle(unit, pdu(*b)).map { it.toInt() and 0xFF }

    @Test
    fun `FC 4 reads input registers, FC 3 holding registers`() {
        assertEquals(listOf(4, 2, 0x05, 0xDC), call(1, 4, 0, 100, 0, 1))
        assertEquals(listOf(3, 2, 0, 7), call(1, 3, 0, 10, 0, 1))
        assertEquals(listOf(3, 2, 0, 2), call(2, 3, 0, 0, 0, 1))
    }

    @Test
    fun `a read may span several registers`() {
        // int16 at 100 + int32 at 101..102
        assertEquals(listOf(4, 6, 0x05, 0xDC, 0, 0, 0x05, 0xDC), call(1, 4, 0, 100, 0, 3))
        // half of a 32-bit register
        assertEquals(listOf(4, 2, 0x05, 0xDC), call(1, 4, 0, 102, 0, 1))
    }

    @Test
    fun `bound registers follow the live value`() {
        live = -2.0
        assertEquals(listOf(4, 2, 0xFF, 0xFE), call(1, 4, 0, 100, 0, 1))
    }

    @Test
    fun `FC 6 writes a holding register and echoes the request`() {
        assertEquals(listOf(6, 0, 10, 0x12, 0x34), call(1, 6, 0, 10, 0x12, 0x34))
        assertEquals(listOf(3, 2, 0x12, 0x34), call(1, 3, 0, 10, 0, 1))
    }

    @Test
    fun `FC 16 writes several registers`() {
        // 10 = 5, 11..12 = 2.5f (0x40200000)
        assertEquals(listOf(16, 0, 10, 0, 3), call(1, 16, 0, 10, 0, 3, 6, 0, 5, 0x40, 0x20, 0, 0))
        assertEquals(5.0, map.find(1, HOLDING, 10)!!.value())
        assertEquals(2.5, map.find(1, HOLDING, 11)!!.value())
    }

    @Test
    fun `FC 6 on one word of a 32-bit register keeps the other word`() {
        // 1.5f = 0x3FC00000 -> high word 0x4020 gives 2.5f
        call(1, 6, 0, 11, 0x40, 0x20)
        assertEquals(2.5, map.find(1, HOLDING, 11)!!.value())
    }

    @Test
    fun `a write bound to an action runs it`() {
        assertEquals(listOf(6, 0, 30, 0, 2), call(1, 6, 0, 30, 0, 2))
        assertEquals(2.0, actionValue)
    }

    @Test
    fun `unsupported function code is exception 01`() {
        assertEquals(listOf(0x81, 1), call(1, 1, 0, 0, 0, 1))
        assertEquals(listOf(0x85, 1), call(1, 5, 0, 10, 0xFF, 0))
    }

    @Test
    fun `unmapped address is exception 02`() {
        assertEquals(listOf(0x83, 2), call(1, 3, 0, 99, 0, 1))
        assertEquals(listOf(0x84, 2), call(1, 4, 0, 100, 0, 4))    // 103 not mapped
        assertEquals(listOf(0x86, 2), call(1, 6, 0, 99, 0, 1))
        assertEquals(listOf(0x84, 2), call(1, 4, 0xFF, 0xFF, 0, 2)) // beyond 65535
    }

    @Test
    fun `writes to read-only registers are exception 02 and change nothing`() {
        assertEquals(listOf(0x86, 2), call(1, 6, 0, 13, 0, 1))  // bound, no action
        assertEquals(listOf(0x90, 2), call(1, 16, 0, 101, 0, 1, 2, 0, 1)) // input table only
        // 10..12 writable, 13 not: whole request rejected, 10 unchanged
        assertEquals(listOf(0x90, 2), call(1, 16, 0, 10, 0, 4, 8, 0, 9, 0, 0, 0, 0, 0, 1))
        assertEquals(7.0, map.find(1, HOLDING, 10)!!.value())
    }

    @Test
    fun `bad quantity, length or value is exception 03`() {
        assertEquals(listOf(0x83, 3), call(1, 3, 0, 10, 0, 0))
        assertEquals(listOf(0x83, 3), call(1, 3, 0, 10, 0, 126))
        assertEquals(listOf(0x83, 3), call(1, 3, 0, 10))
        assertEquals(listOf(0x90, 3), call(1, 16, 0, 10, 0, 1, 4, 0, 1)) // byte count mismatch
        assertEquals(listOf(0x86, 3), call(1, 6, 0, 30, 0, 9))           // action rejects 9
        assertEquals(null, actionValue)
    }

    @Test
    fun `unknown unit id is exception 0B`() {
        assertEquals(listOf(0x83, 0x0B), call(9, 3, 0, 10, 0, 1))
    }

    @Test
    fun `overlapping registers are rejected`() {
        assertThrows<IllegalArgumentException> {
            ModbusRegisterMap(listOf(ModbusRegister(1, INPUT, 0, INT32), ModbusRegister(1, INPUT, 1, INT16)))
        }
        // same address in another table or unit is fine
        ModbusRegisterMap(listOf(ModbusRegister(1, INPUT, 0, INT32), ModbusRegister(1, HOLDING, 1, INT16)))
    }
}
