package com.qnetmobile

/** Whether a listing of the Keystore that is known to have been answered names an alias, or no such listing was had. */
internal enum class AliasListing { LISTED, NOT_LISTED, UNKNOWN }

/** What reading a Keystore entry found: the entry, an entry that is not there, or a Keystore that did not answer. */
internal sealed class KeyRead<out T> {
    data class Found<T>(val value: T) : KeyRead<T>()
    object Absent : KeyRead<Nothing>()
    object Unanswered : KeyRead<Nothing>()
}

/**
 * Reads a Keystore entry that stored data may depend on (MA-R2-01). The platform's reads answer null both for an alias
 * that does not exist and for a Keystore that failed to answer: containsAlias and getCertificate swallow every keystore2
 * error, and below Android 12 getKey does the same when the daemon does not answer. So a null read alone says nothing.
 * The entry is absent only when `listing` (one listing of the store, known to have been answered) leaves the alias out;
 * an alias the listing names, or a listing that could not be had, is read again after `pause(attempt)`, and after the
 * last try the Keystore counts as not answering. A read that throws passes its error on: it carries the Keystore's code.
 */
internal fun <T : Any> readKeystoreEntry(
    tries: Int,
    pause: (Int) -> Unit,
    read: () -> T?,
    listing: () -> AliasListing,
): KeyRead<T> {
    for (attempt in 0 until tries) {
        if (attempt > 0) pause(attempt)
        read()?.let { return KeyRead.Found(it) }
        if (listing() == AliasListing.NOT_LISTED) {
            // The listing may have been taken just after a read that failed: one more read settles it.
            return read()?.let { KeyRead.Found(it) } ?: KeyRead.Absent
        }
    }
    return KeyRead.Unanswered
}

/**
 * What a listing of the store says about `alias`. keystore2 and the older daemon both answer an empty listing when they
 * fail, so only a listing that names something is known to have been answered. An empty one is taken again after
 * `ensureProbe` has made sure an entry of the app's own exists (the probe alias); if the probe is still not listed, or
 * could not be made, the listing is unknown.
 */
internal fun aliasListing(
    alias: String,
    probeAlias: String,
    list: () -> Collection<String>,
    ensureProbe: () -> Boolean,
): AliasListing {
    var names = runCatching { list() }.getOrDefault(emptyList())
    if (names.isEmpty()) {
        if (!runCatching { ensureProbe() }.getOrDefault(false)) return AliasListing.UNKNOWN
        names = runCatching { list() }.getOrDefault(emptyList())
        if (probeAlias !in names) return AliasListing.UNKNOWN
    }
    return if (alias in names) AliasListing.LISTED else AliasListing.NOT_LISTED
}
