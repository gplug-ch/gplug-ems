package ch.gplug.simulator.load

import org.slf4j.LoggerFactory
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class LoadService(loads: List<Load>) {

    private val log = LoggerFactory.getLogger(LoadService::class.java)
    private val scheduler: ScheduledExecutorService = Executors.newScheduledThreadPool(4)
    private val loadsMap: Map<String, Load> = loads.associateBy { it.id }

    fun findBySiteId(siteId: String): List<Load> =
        loadsMap.values.filter { it.siteId == siteId }

    fun findLoad(siteId: String, loadId: String): Load? =
        loadsMap[loadId]?.takeIf { it.siteId == siteId }

    fun setWaiting(siteId: String, loadId: String): Load {
        val load = findLoad(siteId, loadId)
            ?: throw NoSuchElementException("Load $loadId not found in site $siteId")

        synchronized(load) {
            log.debug("Transitioning load {} in site {} to WAITING", loadId, siteId)
            load.state = LoadState.WAITING
        }

        return load
    }

    fun setInactive(siteId: String, loadId: String): Load {
        val load = findLoad(siteId, loadId)
            ?: throw NoSuchElementException("Load $loadId not found in site $siteId")

        synchronized(load) {
            log.debug("Transitioning load {} in site {} to INACTIVE", loadId, siteId)
            load.state = LoadState.INACTIVE
        }

        return load
    }

    fun setActive(siteId: String, loadId: String): Load {
        val load = findLoad(siteId, loadId)
            ?: throw NoSuchElementException("Load $loadId not found in site $siteId")

        synchronized(load) {
            log.debug("Transitioning load {} in site {} to ACTIVE for duration {} s", loadId, siteId, load.duration / 1000.0)
            load.state = LoadState.ACTIVE
        }

        scheduler.schedule({
            synchronized(load) {
                if (load.state == LoadState.ACTIVE) {
                    log.debug("Timer expired for load {} in site {}, transitioning to INACTIVE", loadId, siteId)
                    load.state = LoadState.INACTIVE
                }
            }
        }, load.duration, TimeUnit.MILLISECONDS)

        return load
    }
}
