package ch.gplug.simulator.modbus

import kotlin.math.roundToLong

/** Register table a Modbus register lives in: FC 3 reads [HOLDING], FC 4 reads [INPUT]. */
enum class ModbusTable { HOLDING, INPUT }

/** Wire data types, as the EMS `modbustcp` integration names them (`dtype`). */
enum class ModbusDataType(val words: Int) {
    INT16(1), UINT16(1), INT32(2), UINT32(2), FLOAT32(2)
}

/**
 * Encodes a value into 16-bit register words the way the EMS `modbustcp`
 * integration (`ems/backend/integrations/modbustcp.be`) decodes them:
 * big-endian ABCD, `swapWords` exchanges the two words of a 32-bit value
 * (CDAB), and the client multiplies the decoded raw value by `scale` — so the
 * raw value is `value / scale`. Integers are rounded and clamped to the
 * dtype's range.
 */
object ModbusCodec {

    fun encode(value: Double, dtype: ModbusDataType, scale: Double = 1.0, swapWords: Boolean = false): IntArray {
        val scaled = value / scale
        val bits: Long = when (dtype) {
            ModbusDataType.INT16 -> clampRound(scaled, Short.MIN_VALUE.toLong(), Short.MAX_VALUE.toLong()) and 0xFFFF
            ModbusDataType.UINT16 -> clampRound(scaled, 0, 0xFFFF)
            ModbusDataType.INT32 -> clampRound(scaled, Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()) and 0xFFFF_FFFFL
            ModbusDataType.UINT32 -> clampRound(scaled, 0, 0xFFFF_FFFFL)
            ModbusDataType.FLOAT32 -> java.lang.Float.floatToRawIntBits(scaled.toFloat()).toLong() and 0xFFFF_FFFFL
        }
        if (dtype.words == 1) return intArrayOf(bits.toInt())
        val hi = ((bits ushr 16) and 0xFFFF).toInt()
        val lo = (bits and 0xFFFF).toInt()
        return if (swapWords) intArrayOf(lo, hi) else intArrayOf(hi, lo)
    }

    fun decode(words: IntArray, dtype: ModbusDataType, scale: Double = 1.0, swapWords: Boolean = false): Double {
        require(words.size == dtype.words) { "$dtype needs ${dtype.words} word(s), got ${words.size}" }
        val raw: Double = if (dtype.words == 1) {
            val w = words[0] and 0xFFFF
            if (dtype == ModbusDataType.INT16) w.toShort().toDouble() else w.toDouble()
        } else {
            val (hi, lo) = if (swapWords) words[1] to words[0] else words[0] to words[1]
            val bits = ((hi.toLong() and 0xFFFF) shl 16) or (lo.toLong() and 0xFFFF)
            when (dtype) {
                ModbusDataType.INT32 -> bits.toInt().toDouble()
                ModbusDataType.UINT32 -> bits.toDouble()
                else -> java.lang.Float.intBitsToFloat(bits.toInt()).toDouble()
            }
        }
        return raw * scale
    }

    private fun clampRound(v: Double, min: Long, max: Long): Long =
        if (v.isNaN()) 0 else v.coerceIn(min.toDouble(), max.toDouble()).roundToLong()
}
