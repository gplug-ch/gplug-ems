package ch.gplug.simulator.modbus

/**
 * One configured register (1 or 2 words, see [ModbusDataType.words]).
 *
 * The value is either static ([set] stores it) or bound to a live simulator
 * value via [reader]. An optional [writer] binds writes to a simulator action
 * (e.g. switching a load); a register bound only for reading is read-only.
 * [source]/[action] are the configured binding paths, kept for display.
 */
class ModbusRegister(
    val unit: Int,
    val table: ModbusTable,
    val address: Int,
    val dtype: ModbusDataType,
    val swapWords: Boolean = false,
    val scale: Double = 1.0,
    val name: String? = null,
    val source: String? = null,
    val action: String? = null,
    initialValue: Double = 0.0,
    private val reader: (() -> Double)? = null,
    private val writer: ((Double) -> Unit)? = null
) {
    init {
        require(address in 0..(0x10000 - dtype.words)) { "Address $address out of range for $dtype" }
        require(scale != 0.0 && scale.isFinite()) { "Scale must be finite and non-zero" }
    }

    @Volatile
    private var stored: Double = initialValue

    /** Settable via REST: static, or bound to a write action. */
    val settable: Boolean get() = reader == null || writer != null

    /** Writable via Modbus FC 6/16: settable and in the holding table. */
    val writable: Boolean get() = table == ModbusTable.HOLDING && settable

    fun value(): Double = reader?.invoke() ?: stored

    fun words(): IntArray = ModbusCodec.encode(value(), dtype, scale, swapWords)

    /** @throws IllegalStateException if read-only, IllegalArgumentException if the action rejects [v] */
    fun set(v: Double) {
        check(settable) { "Register $unit/$table/$address is bound read-only to $source" }
        writer?.invoke(v)
        if (reader == null) stored = v
    }
}
