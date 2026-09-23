package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.modbus.ModbusDataType
import ch.gplug.simulator.modbus.ModbusPduHandler
import ch.gplug.simulator.modbus.ModbusRegister
import ch.gplug.simulator.modbus.ModbusRegisterMap
import ch.gplug.simulator.modbus.ModbusTable
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.io.DataInputStream
import java.net.Socket
import kotlin.test.assertEquals

class ModbusTcpServerTest {

    private val server = ModbusTcpServer(
        ModbusPduHandler(
            ModbusRegisterMap(listOf(ModbusRegister(1, ModbusTable.INPUT, 30775, ModbusDataType.INT32, initialValue = -5.0)))
        ),
        port = 0
    ).also { it.start() }

    @AfterEach
    fun stop() = server.stop()

    private fun frame(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    private fun exchange(socket: Socket, request: ByteArray, replySize: Int): List<Int> {
        socket.getOutputStream().write(request)
        val reply = ByteArray(replySize)
        DataInputStream(socket.getInputStream()).readFully(reply)
        return reply.map { it.toInt() and 0xFF }
    }

    @Test
    fun `answers MBAP requests, several per connection`() {
        Socket("127.0.0.1", server.localPort).use { s ->
            s.soTimeout = 2000
            // tid 0x1234, proto 0, len 6, unit 1, FC 4, addr 30775 (0x7837), qty 2
            assertEquals(
                listOf(0x12, 0x34, 0, 0, 0, 7, 1, 4, 4, 0xFF, 0xFF, 0xFF, 0xFB),
                exchange(s, frame(0x12, 0x34, 0, 0, 0, 6, 1, 4, 0x78, 0x37, 0, 2), 13)
            )
            // exception frame: length 3, fc | 0x80, code 02
            assertEquals(
                listOf(0, 2, 0, 0, 0, 3, 1, 0x84, 2),
                exchange(s, frame(0, 2, 0, 0, 0, 6, 1, 4, 0, 0, 0, 1), 9)
            )
        }
    }

    @Test
    fun `stop closes the listener`() {
        val port = server.localPort
        server.stop()
        assertEquals(-1, server.localPort)
        assertEquals(false, server.isRunning)
        runCatching { Socket("127.0.0.1", port).close() }.onSuccess { error("still accepting on $port") }
    }
}
