package ch.gplug.simulator

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest

// port 0: never clash with a running simulator's Modbus server
@SpringBootTest(properties = ["simulator.modbus.port=0"])
class SimulatorApplicationTests {

	@Test
	fun contextLoads() {
	}

}
