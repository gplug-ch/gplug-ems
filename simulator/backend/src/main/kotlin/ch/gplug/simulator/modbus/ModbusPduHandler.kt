package ch.gplug.simulator.modbus

import ch.gplug.simulator.modbus.ModbusException.Companion.GATEWAY_TARGET_FAILED
import ch.gplug.simulator.modbus.ModbusException.Companion.ILLEGAL_DATA_ADDRESS
import ch.gplug.simulator.modbus.ModbusException.Companion.ILLEGAL_DATA_VALUE
import ch.gplug.simulator.modbus.ModbusException.Companion.ILLEGAL_FUNCTION
import org.slf4j.LoggerFactory

/**
 * Answers one Modbus PDU (function code + data, no MBAP header) against a
 * [ModbusRegisterMap]: FC 3/4 read holding/input registers, FC 6/16 write
 * holding registers. Everything else yields an exception response.
 */
class ModbusPduHandler(private val map: ModbusRegisterMap) {

    private val log = LoggerFactory.getLogger(ModbusPduHandler::class.java)

    fun handle(unit: Int, pdu: ByteArray): ByteArray {
        val fc = if (pdu.isEmpty()) 0 else pdu[0].toInt() and 0x7F
        return try {
            if (pdu.isEmpty()) throw ModbusException(ILLEGAL_FUNCTION, "Empty PDU")
            if (!map.hasUnit(unit)) throw ModbusException(GATEWAY_TARGET_FAILED, "No slave with unit id $unit")
            when (pdu[0].toInt() and 0xFF) {
                3 -> read(unit, ModbusTable.HOLDING, pdu)
                4 -> read(unit, ModbusTable.INPUT, pdu)
                6 -> writeSingle(unit, pdu)
                16 -> writeMultiple(unit, pdu)
                else -> throw ModbusException(ILLEGAL_FUNCTION, "Unsupported function code $fc")
            }
        } catch (e: ModbusException) {
            log.debug("Modbus exception {} for unit {} fc {}: {}", e.code, unit, fc, e.message)
            byteArrayOf((fc or 0x80).toByte(), e.code.toByte())
        }
    }

    private fun read(unit: Int, table: ModbusTable, pdu: ByteArray): ByteArray {
        if (pdu.size != 5) throw ModbusException(ILLEGAL_DATA_VALUE, "Bad read PDU length ${pdu.size}")
        val address = u16(pdu, 1)
        val count = u16(pdu, 3)
        if (count !in 1..125) throw ModbusException(ILLEGAL_DATA_VALUE, "Bad register count $count")
        if (address + count > 0x10000) throw ModbusException(ILLEGAL_DATA_ADDRESS, "Range beyond 65535")
        val words = map.read(unit, table, address, count)
        val out = ByteArray(2 + 2 * count)
        out[0] = pdu[0]
        out[1] = (2 * count).toByte()
        words.forEachIndexed { i, w -> put16(out, 2 + 2 * i, w) }
        return out
    }

    private fun writeSingle(unit: Int, pdu: ByteArray): ByteArray {
        if (pdu.size != 5) throw ModbusException(ILLEGAL_DATA_VALUE, "Bad write PDU length ${pdu.size}")
        map.write(unit, ModbusTable.HOLDING, u16(pdu, 1), intArrayOf(u16(pdu, 3)))
        return pdu.copyOf()
    }

    private fun writeMultiple(unit: Int, pdu: ByteArray): ByteArray {
        if (pdu.size < 6) throw ModbusException(ILLEGAL_DATA_VALUE, "Bad write PDU length ${pdu.size}")
        val address = u16(pdu, 1)
        val count = u16(pdu, 3)
        val byteCount = pdu[5].toInt() and 0xFF
        if (count !in 1..123 || byteCount != 2 * count || pdu.size != 6 + byteCount) {
            throw ModbusException(ILLEGAL_DATA_VALUE, "Bad count $count / byte count $byteCount")
        }
        if (address + count > 0x10000) throw ModbusException(ILLEGAL_DATA_ADDRESS, "Range beyond 65535")
        map.write(unit, ModbusTable.HOLDING, address, IntArray(count) { u16(pdu, 6 + 2 * it) })
        return pdu.copyOfRange(0, 5)
    }

    private fun u16(b: ByteArray, i: Int) = ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)

    private fun put16(b: ByteArray, i: Int, v: Int) {
        b[i] = (v shr 8).toByte()
        b[i + 1] = v.toByte()
    }
}
