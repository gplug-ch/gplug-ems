package ch.gplug.simulator.load

data class Load(
    val id: String,
    val friendlyName: String,
    val loadType: LoadType,
    val priority: Int,
    val duration: Long,
    val minimalDuration: Long,
    val siteId: String,
    @Volatile var state: LoadState = LoadState.INACTIVE
)
