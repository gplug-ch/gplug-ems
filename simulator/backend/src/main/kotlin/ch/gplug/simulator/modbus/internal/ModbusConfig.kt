package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.grid.GridService
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.modbus.ModbusPduHandler
import ch.gplug.simulator.modbus.ModbusRegister
import ch.gplug.simulator.modbus.ModbusRegisterMap
import ch.gplug.simulator.production.ProductionService
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
@EnableConfigurationProperties(ModbusConfigProperties::class)
class ModbusConfig {

    @Bean
    fun modbusRegisterMap(
        props: ModbusConfigProperties,
        productionService: ProductionService,
        gridService: GridService,
        loadService: LoadService
    ): ModbusRegisterMap {
        val bindings = ModbusBindings(productionService, gridService, loadService)
        val duplicate = props.slaves.groupBy { it.unit }.filterValues { it.size > 1 }.keys
        require(duplicate.isEmpty()) { "Duplicate Modbus unit id(s) $duplicate" }
        val registers = props.slaves.flatMap { slave ->
            require(slave.unit in 0..255) { "Modbus unit id ${slave.unit} not in 0..255" }
            slave.registers.map { r ->
                ModbusRegister(
                    unit = slave.unit,
                    table = r.table,
                    address = r.address,
                    dtype = r.dtype,
                    swapWords = r.swapWords,
                    scale = r.scale,
                    name = r.name,
                    source = r.source,
                    action = r.action,
                    initialValue = r.value,
                    reader = r.source?.let(bindings::reader),
                    writer = r.action?.let(bindings::writer)
                )
            }
        }
        return ModbusRegisterMap(registers)
    }

    @Bean
    fun modbusTcpServer(props: ModbusConfigProperties, map: ModbusRegisterMap): ModbusTcpServer =
        ModbusTcpServer(ModbusPduHandler(map), props.port, props.enabled)
}
