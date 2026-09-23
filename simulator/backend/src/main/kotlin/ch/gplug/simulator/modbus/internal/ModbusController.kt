package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.modbus.ModbusCodec
import ch.gplug.simulator.modbus.ModbusRegister
import ch.gplug.simulator.modbus.ModbusRegisterMap
import ch.gplug.simulator.modbus.ModbusTable
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/modbus")
class ModbusController(
    private val map: ModbusRegisterMap,
    private val server: ModbusTcpServer,
    private val props: ModbusConfigProperties
) {

    @GetMapping
    fun list(): ModbusStatus = ModbusStatus(
        running = server.isRunning,
        port = if (server.isRunning) server.localPort else props.port,
        registers = map.registers.map(::view)
    )

    @PutMapping("/{unit}/{table}/{address}")
    fun setValue(
        @PathVariable unit: Int,
        @PathVariable table: String,
        @PathVariable address: Int,
        @RequestBody body: ValueRequest
    ): ResponseEntity<ModbusRegisterView> {
        val t = ModbusTable.entries.firstOrNull { it.name.equals(table, ignoreCase = true) }
            ?: return ResponseEntity.badRequest().build()
        val register = map.find(unit, t, address) ?: return ResponseEntity.notFound().build()
        return try {
            register.set(body.value)
            ResponseEntity.ok(view(register))
        } catch (e: IllegalStateException) {
            ResponseEntity.badRequest().build()
        } catch (e: IllegalArgumentException) {
            ResponseEntity.badRequest().build()
        } catch (e: NoSuchElementException) {
            ResponseEntity.notFound().build()
        }
    }

    private fun view(r: ModbusRegister): ModbusRegisterView {
        val words = r.words()
        return ModbusRegisterView(
            unit = r.unit,
            table = r.table.name.lowercase(),
            address = r.address,
            dtype = r.dtype.name.lowercase(),
            swapWords = r.swapWords,
            scale = r.scale,
            name = r.name,
            source = r.source,
            action = r.action,
            words = words.toList(),
            // what a client decodes, i.e. after rounding/clamping to the dtype
            value = ModbusCodec.decode(words, r.dtype, r.scale, r.swapWords),
            settable = r.settable,
            writable = r.writable
        )
    }
}

data class ValueRequest(val value: Double)

data class ModbusStatus(val running: Boolean, val port: Int, val registers: List<ModbusRegisterView>)

data class ModbusRegisterView(
    val unit: Int,
    val table: String,
    val address: Int,
    val dtype: String,
    val swapWords: Boolean,
    val scale: Double,
    val name: String?,
    val source: String?,
    val action: String?,
    /** Raw register words as sent on the wire. */
    val words: List<Int>,
    /** Decoded value, as the EMS `modbustcp` client sees it. */
    val value: Double,
    /** Settable via `PUT /modbus/...`. */
    val settable: Boolean,
    /** Writable via Modbus FC 6/16. */
    val writable: Boolean
)
