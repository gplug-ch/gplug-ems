package ch.gplug.simulator.production

/**
 * A simulated energy source. For [ProductionType.BATTERY] (issue #20) the
 * power is signed — positive = discharging, negative = charging — within
 * `-maxChargePower..maxPower`, and [soc] (%) follows it over time against
 * [capacityWh]. PV ignores the battery fields.
 */
data class Production(
    val id: String,
    val siteId: String,
    val productionType: ProductionType,
    val maxPower: Int,
    @Volatile var currentPower: Int = 0,
    val capacityWh: Int? = null,
    val maxChargePower: Int? = null,
    @Volatile var soc: Double? = null
)
