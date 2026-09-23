package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.modbus.ModbusDataType
import ch.gplug.simulator.modbus.ModbusTable
import org.springframework.boot.context.properties.ConfigurationProperties

/** `simulator.modbus` in `application.yaml`: the Modbus TCP server and its slaves' registers. */
@ConfigurationProperties("simulator.modbus")
data class ModbusConfigProperties(
    val enabled: Boolean = true,
    /** TCP port; 502 needs root, hence 5020. 0 picks a free port (tests). */
    val port: Int = 5020,
    val slaves: List<ModbusSlaveConfig> = emptyList()
)

data class ModbusSlaveConfig(
    val unit: Int = 1,
    val registers: List<ModbusRegisterConfig> = emptyList()
)

data class ModbusRegisterConfig(
    /** Wire address, no 40001 offset. */
    val address: Int = 0,
    val table: ModbusTable = ModbusTable.HOLDING,
    val dtype: ModbusDataType = ModbusDataType.UINT16,
    val swapWords: Boolean = false,
    val scale: Double = 1.0,
    val name: String? = null,
    /** Live value `<siteId>/<itemId>/<field>`; absent = static [value]. */
    val source: String? = null,
    /** Static (initial) value; ignored when [source] is set. */
    val value: Double = 0.0,
    /** Simulator action `<siteId>/<itemId>/<field>` run on write. */
    val action: String? = null
)
