package ch.gplug.simulator.site.internal

import ch.gplug.simulator.load.LoadType
import ch.gplug.simulator.production.ProductionType
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("simulator")
data class SimulatorConfigProperties(
    val sites: List<SiteConfig> = emptyList()
)

data class SiteConfig(
    val id: String = "",
    val name: String = "",
    val productions: List<ProductionConfig> = emptyList(),
    val loads: List<LoadConfig> = emptyList(),
    val grid: GridConfig? = null
)

data class GridConfig(
    val input: GridMeterConfig = GridMeterConfig(),
    val output: GridMeterConfig = GridMeterConfig()
)

data class GridMeterConfig(
    val id: String = "",
    val name: String = ""
)

data class ProductionConfig(
    val id: String = "",
    val productionType: ProductionType = ProductionType.PHOTOVOLTAIC,
    val maxPower: Int = 0,
    // BATTERY only (issue #20): capacity, charge limit (default maxPower) and start SoC %
    val capacityWh: Int? = null,
    val maxChargePower: Int? = null,
    val initialSoc: Double? = null
)

data class LoadConfig(
    val id: String = "",
    val friendlyName: String = "",
    val loadType: LoadType = LoadType.DRYER,
    val priority: Int = 0,
    val duration: Long = 0,
    val minimalDuration: Long = 0
)
