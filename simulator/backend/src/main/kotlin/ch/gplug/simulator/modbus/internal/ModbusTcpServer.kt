package ch.gplug.simulator.modbus.internal

import ch.gplug.simulator.modbus.ModbusPduHandler
import org.slf4j.LoggerFactory
import org.springframework.context.SmartLifecycle
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer

/**
 * Modbus TCP slave: MBAP framing over plain sockets, one virtual thread per
 * connection, any number of requests per connection. The PDU is answered by
 * [ModbusPduHandler]; the reply goes out in a single write (the EMS client
 * ends its read on 40 ms of silence).
 */
class ModbusTcpServer(
    private val handler: ModbusPduHandler,
    private val port: Int,
    private val autoStartup: Boolean = true
) : SmartLifecycle {

    private val log = LoggerFactory.getLogger(ModbusTcpServer::class.java)

    @Volatile
    private var server: ServerSocket? = null

    /** The bound port, or -1 when not running. */
    val localPort: Int get() = server?.localPort ?: -1

    override fun isAutoStartup() = autoStartup

    override fun isRunning() = server != null

    @Synchronized
    override fun start() {
        if (server != null) return
        val socket = ServerSocket(port)
        server = socket
        Thread.ofVirtual().name("modbus-accept").start { accept(socket) }
        log.info("Modbus TCP server listening on port {}", socket.localPort)
    }

    @Synchronized
    override fun stop() {
        server?.close()
        server = null
    }

    private fun accept(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                break
            }
            Thread.ofVirtual().name("modbus-conn").start { serve(client) }
        }
    }

    private fun serve(client: Socket) {
        client.use {
            try {
                it.soTimeout = 60_000
                val input = DataInputStream(BufferedInputStream(it.getInputStream()))
                val output = it.getOutputStream()
                while (true) {
                    val header = ByteArray(7)
                    try {
                        input.readFully(header)
                    } catch (e: EOFException) {
                        return
                    }
                    val mbap = ByteBuffer.wrap(header)
                    val transactionId = mbap.short
                    val protocol = mbap.short.toInt() and 0xFFFF
                    val length = mbap.short.toInt() and 0xFFFF
                    val unit = mbap.get()
                    if (protocol != 0 || length !in 2..254) {
                        log.debug("Dropping Modbus connection: protocol {} length {}", protocol, length)
                        return
                    }
                    val pdu = ByteArray(length - 1)
                    input.readFully(pdu)
                    val reply = handler.handle(unit.toInt() and 0xFF, pdu)
                    val frame = ByteBuffer.allocate(7 + reply.size)
                        .putShort(transactionId).putShort(0).putShort((reply.size + 1).toShort())
                        .put(unit).put(reply)
                        .array()
                    output.write(frame)
                    output.flush()
                }
            } catch (e: IOException) {
                log.debug("Modbus connection closed: {}", e.message)
            }
        }
    }
}
