package com.qnetmobile

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

// More links than the user can have tapped while the wallet screen was not taking them; one past it is refused and
// logged, never one already waiting (the screen may be showing it).
internal const val INBOX_MAX = 8
// How long after its arrival a link kept on the device comes back in a new process: a QNet Link session lives 600 s.
internal const val LINK_LIFE_MS = 600_000L

/** Where the inbox keeps its links across a process end: one string, written on every change. */
internal interface LinkStore {
    fun read(): String?
    fun write(value: String)
}

/** A waiting link: its id in this process, its URL and when it arrived (ms since the epoch). */
internal data class WaitingLink(val id: Long, val url: String, val at: Long)

/**
 * The links the system hands to the app, in arrival order, each kept until the wallet screen is done with it, so none is
 * lost or opened twice whatever happens to the activity or the process (docs/applications/mobile-wallet.md, the link inbox).
 */
internal class Inbox(
    private val max: Int = INBOX_MAX,
    private val store: LinkStore? = null,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (warn: Boolean, line: String) -> Unit = { _, _ -> },
) {
    private var next = 1L
    private val links = ArrayList<WaitingLink>()

    init {
        val kept = decodeLinks(store?.read())
        val t = now()
        for ((url, at) in kept) {
            val age = t - at
            if (age < 0 || age > LINK_LIFE_MS) {
                log(false, "[INFO][LINK] link_dropped reason=stale age_s=${age / 1000}")
            } else if (links.size < max && links.none { it.url == url }) {
                links.add(WaitingLink(next++, url, at))
            }
        }
        if (links.size != kept.size) save()
    }

    @Synchronized
    fun offer(url: String) {
        if (links.any { it.url == url }) return
        if (links.size >= max) {
            log(true, "[WARN][LINK] link_dropped reason=full waiting=${links.size}")
            return
        }
        links.add(WaitingLink(next++, url, now()))
        save()
        log(false, "[INFO][LINK] link_received waiting=${links.size}")
    }

    @Synchronized
    fun pending(): List<WaitingLink> = links.toList()

    @Synchronized
    fun done(id: Long) {
        if (links.removeAll { it.id == id }) save()
    }

    private fun save() {
        store?.write(encodeLinks(links.map { it.url to it.at }))
    }
}

/** The kept links as one string, `<at>:<length>:<url>` each: any character of a URL reads back as it was. */
internal fun encodeLinks(links: List<Pair<String, Long>>): String =
    links.joinToString("") { (url, at) -> "$at:${url.length}:$url" }

/** The links [encodeLinks] wrote, oldest first; none at all from a string it did not write. */
internal fun decodeLinks(text: String?): List<Pair<String, Long>> {
    if (text.isNullOrEmpty()) return emptyList()
    val out = ArrayList<Pair<String, Long>>()
    var i = 0
    while (i < text.length) {
        val a = text.indexOf(':', i)
        val b = if (a < 0) -1 else text.indexOf(':', a + 1)
        if (b < 0) return emptyList()
        val at = text.substring(i, a).toLongOrNull()
        val len = text.substring(a + 1, b).toIntOrNull()
        if (at == null || len == null || len <= 0 || len > text.length - b - 1) return emptyList()
        out.add(text.substring(b + 1, b + 1 + len) to at)
        i = b + 1 + len
    }
    return out
}

/**
 * The link an intent brings: a VIEW intent's data, never that of an activity restored after its process ended or
 * relaunched from the recent apps, which still carries the intent that first started it.
 */
internal fun deliveredLink(action: String?, data: String?, flags: Int, restored: Boolean): String? {
    if (restored || (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null
    return if (action == Intent.ACTION_VIEW && !data.isNullOrEmpty()) data else null
}

// The lines of the link path the JS asks for (services/LinkInbox noteLink), each with its own keys; the one at WARN.
internal val NOTE_KEYS = mapOf(
    "request_shown" to listOf("intent", "offer"),
    "answer_delivered" to listOf("intent", "status", "ms"),
    "answer_not_delivered" to listOf("intent", "outcome", "status", "ms"),
    "transfer_form_opened" to listOf("token"),
)
private const val NOTE_WARN = "answer_not_delivered"
private val NOTE_CODE = Regex("^[A-Za-z0-9_]{1,16}$")

/**
 * The line for `event`, or null for one not in NOTE_KEYS: only its keys, each value a code of at most 16 letters,
 * digits or underscores or a whole number below a billion, so no session, key, address or link can reach the log.
 */
internal fun noteLine(event: String, fields: Map<String, Any?>): String? {
    val keys = NOTE_KEYS[event] ?: return null
    val parts = keys.mapNotNull { key -> noteValue(fields[key])?.let { "$key=$it" } }
    val level = if (event == NOTE_WARN) "WARN" else "INFO"
    return (listOf("[$level][LINK] $event") + parts).joinToString(" ")
}

private fun noteValue(value: Any?): String? = when (value) {
    is String -> value.takeIf { NOTE_CODE.matches(it) }
    is Number -> value.toDouble().takeIf { it.isFinite() && it >= 0 && it < 1e9 && it == Math.floor(it) }?.toLong()?.toString()
    else -> null
}

// The native lines that must be in every build (the link path's, AppNetwork's), through Log.println: the release
// build's R8 rules strip Log.d, v, i, w and e. They hold only codes and counts, never a link, an address or a key.
internal fun prodLog(tag: String, warn: Boolean, line: String) {
    Log.println(if (warn) Log.WARN else Log.INFO, tag, line)
}

private fun linkLog(warn: Boolean, line: String) = prodLog(PrefsLinkStore.TAG, warn, line)

// The app's private storage (no backup, no device transfer: AndroidManifest). A commit, so a process that ends right
// after a link came still has it.
private class PrefsLinkStore(private val context: Context) : LinkStore {
    private fun prefs() = context.getSharedPreferences("qnet_link_inbox", Context.MODE_PRIVATE)

    override fun read(): String? = runCatching { prefs().getString("links", null) }.getOrNull()

    override fun write(value: String) {
        if (runCatching { prefs().edit().putString("links", value).commit() }.getOrDefault(false)) return
        linkLog(true, "[WARN][LINK] store_write_failed waiting_bytes=${value.length}")
    }

    companion object {
        const val TAG = "QNetLinkInbox"
    }
}

/** The process's inbox: MainActivity puts every link in it (onCreate, onNewIntent), the JS reads it (LinkInboxModule). */
object LinkInbox {
    @Volatile
    private var inbox: Inbox? = null

    /** The process's inbox, made on the first call from the links an earlier process kept. */
    internal fun of(context: Context): Inbox = inbox ?: synchronized(this) {
        inbox ?: Inbox(store = PrefsLinkStore(context.applicationContext), log = ::linkLog).also { inbox = it }
    }

    /** Keeps the link `intent` brings; false when it brings none (`restored`: deliveredLink). */
    fun receive(context: Context, intent: Intent, restored: Boolean): Boolean {
        // Made first: the links an earlier process kept came before this one.
        val box = of(context)
        val url = deliveredLink(intent.action, intent.dataString, intent.flags, restored) ?: return false
        box.offer(url)
        return true
    }
}

/**
 * QNetLinkInbox for the JS: pending() → [{ id, url }] oldest first; done(id) once the screen is done with that link;
 * note(event, fields) a line of the link path.
 */
class LinkInboxModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "QNetLinkInbox"

    @ReactMethod
    fun pending(promise: Promise) {
        val out = Arguments.createArray()
        for (link in LinkInbox.of(reactApplicationContext).pending()) {
            out.pushMap(Arguments.createMap().apply {
                putDouble("id", link.id.toDouble())
                putString("url", link.url)
            })
        }
        promise.resolve(out)
    }

    @ReactMethod
    fun done(id: Double) {
        LinkInbox.of(reactApplicationContext).done(id.toLong())
    }

    /** A line of the link path (noteLine) in the log, in every build. */
    @ReactMethod
    fun note(event: String, fields: ReadableMap) {
        val line = noteLine(event, fields.toHashMap()) ?: return
        linkLog(line.startsWith("[WARN]"), line)
    }
}
