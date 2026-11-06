package app.hapi.data.api

import java.util.concurrent.ConcurrentHashMap

/**
 * Short-lived cache for the machine-scoped model catalogs.
 *
 * The machine endpoints enumerate an agent's models by running it: the DSH
 * probe spawns a full DeepSeek Harness process, which costs ~10s cold. The
 * hub caches its own probe for 60s, but that is per runner and does not
 * survive an app restart, so opening the new-session form for a second agent
 * pays the cost again.
 *
 * This cache sits above the hub: same key → same answer for [ttlMillis].
 * Model lists change only when the machine's agent configuration changes, so
 * a short TTL is enough to make repeated opens instant without hiding a
 * legitimate change for long.
 */
internal class ModelCatalogCache(private val ttlMillis: Long = DEFAULT_TTL_MILLIS) {

    private data class Entry<T>(val value: T, val storedAt: Long)

    private val entries = ConcurrentHashMap<String, Entry<Any?>>()

    /** Returns the cached value for [key], or null when absent or stale. */
    @Suppress("UNCHECKED_CAST")
    fun <T> get(key: String): T? {
        val entry = entries[key] ?: return null
        if (now() - entry.storedAt > ttlMillis) {
            entries.remove(key)
            return null
        }
        return entry.value as? T
    }

    fun put(key: String, value: Any?) {
        entries[key] = Entry(value, now())
    }

    /** Drops every entry whose key starts with [prefix]. */
    fun invalidate(prefix: String) {
        entries.keys.removeAll { it.startsWith(prefix) }
    }

    fun clear() {
        entries.clear()
    }

    private fun now(): Long = System.currentTimeMillis()

    companion object {
        const val DEFAULT_TTL_MILLIS: Long = 5 * 60 * 1000L
    }
}
