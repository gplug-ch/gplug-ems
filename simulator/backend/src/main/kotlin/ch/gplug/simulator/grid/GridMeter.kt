package ch.gplug.simulator.grid

data class GridMeter(
    val id: String,
    val name: String,
    @Volatile var currentPower: Int = 0
)
