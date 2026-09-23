package ch.gplug.simulator

import org.junit.jupiter.api.Test
import org.springframework.modulith.core.ApplicationModules

class ModularityTests {

    @Test
    fun verifyModularity() {
        ApplicationModules.of(SimulatorApplication::class.java).verify()
    }
}
