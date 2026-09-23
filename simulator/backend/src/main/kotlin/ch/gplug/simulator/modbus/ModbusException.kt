package ch.gplug.simulator.modbus

/** A Modbus exception response with its exception [code]. */
class ModbusException(val code: Int, message: String) : RuntimeException(message) {
    companion object {
        const val ILLEGAL_FUNCTION = 0x01
        const val ILLEGAL_DATA_ADDRESS = 0x02
        const val ILLEGAL_DATA_VALUE = 0x03
        const val GATEWAY_TARGET_FAILED = 0x0B
    }
}
