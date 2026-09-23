package ch.gplug.simulator

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class SimulatorApplication

fun main(args: Array<String>) {
	runApplication<SimulatorApplication>(*args)
}
