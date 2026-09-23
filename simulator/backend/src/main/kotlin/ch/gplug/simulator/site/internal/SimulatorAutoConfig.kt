package ch.gplug.simulator.site.internal

import ch.gplug.simulator.grid.Grid
import ch.gplug.simulator.grid.GridMeter
import ch.gplug.simulator.grid.GridService
import ch.gplug.simulator.load.Load
import ch.gplug.simulator.load.LoadService
import ch.gplug.simulator.meter.MeterService
import ch.gplug.simulator.production.Production
import ch.gplug.simulator.production.ProductionService
import ch.gplug.simulator.production.ProductionType
import ch.gplug.simulator.site.Site
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
@EnableConfigurationProperties(SimulatorConfigProperties::class)
class SimulatorAutoConfig {

    @Bean
    fun loadService(props: SimulatorConfigProperties): LoadService {
        val loads = props.sites.flatMap { siteConfig ->
            siteConfig.loads.map { loadConfig ->
                Load(
                    id = loadConfig.id,
                    friendlyName = loadConfig.friendlyName,
                    loadType = loadConfig.loadType,
                    priority = loadConfig.priority,
                    duration = loadConfig.duration * 1000,
                    minimalDuration = loadConfig.minimalDuration * 1000,
                    siteId = siteConfig.id
                )
            }
        }
        return LoadService(loads)
    }

    @Bean
    fun productionService(props: SimulatorConfigProperties): ProductionService {
        val productions = props.sites.flatMap { siteConfig ->
            siteConfig.productions.map { productionConfig ->
                val battery = productionConfig.productionType == ProductionType.BATTERY
                Production(
                    id = productionConfig.id,
                    siteId = siteConfig.id,
                    productionType = productionConfig.productionType,
                    maxPower = productionConfig.maxPower,
                    capacityWh = if (battery) productionConfig.capacityWh else null,
                    maxChargePower = if (battery) productionConfig.maxChargePower ?: productionConfig.maxPower else null,
                    soc = if (battery && productionConfig.capacityWh != null) productionConfig.initialSoc ?: 50.0 else null
                )
            }
        }
        return ProductionService(productions)
    }

    @Bean
    fun gridService(props: SimulatorConfigProperties): GridService {
        val grids = props.sites.mapNotNull { siteConfig ->
            siteConfig.grid?.let { gridConfig ->
                Grid(
                    siteId = siteConfig.id,
                    input = GridMeter(id = gridConfig.input.id, name = gridConfig.input.name),
                    output = GridMeter(id = gridConfig.output.id, name = gridConfig.output.name)
                )
            }
        }
        return GridService(grids)
    }

    @Bean
    fun meterService(gridService: GridService): MeterService = MeterService(gridService)

    @Bean
    fun siteRepository(props: SimulatorConfigProperties): SiteRepository {
        val sites = props.sites.map { siteConfig ->
            Site(id = siteConfig.id, name = siteConfig.name, loads = emptyList(), productions = emptyList())
        }
        return SiteRepository(sites)
    }
}
