package ch.gplug.simulator.modbus

import ch.gplug.simulator.modbus.ModbusException.Companion.ILLEGAL_DATA_ADDRESS
import ch.gplug.simulator.modbus.ModbusException.Companion.ILLEGAL_DATA_VALUE

/**
 * All registers of the simulated slaves, indexed by (unit, table, word
 * address). A read or write may span several registers, but every word in
 * the range must belong to a configured register.
 */
class ModbusRegisterMap(registers: List<ModbusRegister>) {

    private data class Key(val unit: Int, val table: ModbusTable, val address: Int)

    val registers: List<ModbusRegister> =
        registers.sortedWith(compareBy({ it.unit }, { it.table }, { it.address }))

    private val units: Set<Int> = registers.map { it.unit }.toSet()

    private val byWord: Map<Key, ModbusRegister> = buildMap {
        for (r in registers) for (i in 0 until r.dtype.words) {
            val clash = put(Key(r.unit, r.table, r.address + i), r)
            require(clash == null) {
                "Register ${r.unit}/${r.table}/${r.address} overlaps ${clash!!.unit}/${clash.table}/${clash.address}"
            }
        }
    }

    fun hasUnit(unit: Int): Boolean = unit in units

    /** The register starting exactly at [address], if any. */
    fun find(unit: Int, table: ModbusTable, address: Int): ModbusRegister? =
        byWord[Key(unit, table, address)]?.takeIf { it.address == address }

    fun read(unit: Int, table: ModbusTable, address: Int, count: Int): IntArray {
        // each register is encoded once per read, so both words of a 32-bit value match
        val encoded = mutableMapOf<ModbusRegister, IntArray>()
        return IntArray(count) { i ->
            val a = address + i
            val reg = byWord[Key(unit, table, a)]
                ?: throw ModbusException(ILLEGAL_DATA_ADDRESS, "No register $unit/$table/$a")
            encoded.getOrPut(reg) { reg.words() }[a - reg.address]
        }
    }

    /**
     * Writes [words] starting at [address]. A write may cover a 32-bit
     * register only partly; its other word keeps its current value. All
     * addressed registers are checked before any is written.
     */
    @Synchronized
    fun write(unit: Int, table: ModbusTable, address: Int, words: IntArray) {
        val touched = LinkedHashMap<ModbusRegister, IntArray>()
        words.forEachIndexed { i, w ->
            val a = address + i
            val reg = byWord[Key(unit, table, a)]
                ?: throw ModbusException(ILLEGAL_DATA_ADDRESS, "No register $unit/$table/$a")
            if (!reg.writable) {
                throw ModbusException(ILLEGAL_DATA_ADDRESS, "Register $unit/$table/${reg.address} is read-only")
            }
            touched.getOrPut(reg) { reg.words().copyOf() }[a - reg.address] = w and 0xFFFF
        }
        for ((reg, regWords) in touched) {
            try {
                reg.set(ModbusCodec.decode(regWords, reg.dtype, reg.scale, reg.swapWords))
            } catch (e: IllegalArgumentException) {
                throw ModbusException(ILLEGAL_DATA_VALUE, e.message ?: "Illegal value")
            }
        }
    }
}
