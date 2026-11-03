package com.qnetmobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.IOException
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.internal.connection.RealConnection

/**
 * The one HTTP connection pool of every client React Native builds, so it can be emptied as one: out of front no idle
 * connection outlives a short quiet, so no ping comes after a wake, and a new default network retires every older one.
 */
object AppNetwork {
    // The HTTP/2 ping of every open connection, idle pooled ones included.
    const val PING_MS = 15_000L

    // Out of front, how long a connection stays idle after a call: longer than a background wake's gap between two reads
    // of one genesis node, so the wake reuses it, and short enough to close in the radio's tail, before its next ping.
    const val QUIET_MS = 3_000L

    // The longest a WebSocket's opening handshake may take: the screen then opens a new socket.
    const val SOCKET_OPEN_MS = 20_000L

    val pool = ConnectionPool()

    // Closing a TLS socket writes its close alert, a network write the main thread may not make: one worker closes them.
    private val closer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "qnet-net-close").apply { isDaemon = true } }

    // The close armed by the last call that ended out of front.
    private var quietClose: ScheduledFuture<*>? = null

    // Every connection a call took, so a network change reaches the busy ones too; weakly held, so a closed one goes.
    private val taken: MutableSet<Connection> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    // The default network seen last (null before the first and after it was lost).
    private var current: Any? = null

    // Told each time a default network appears (the first, one after none, another): the JS retries that wait on a
    // back-off for aiqnet.io try again at once (AppNetworkModule).
    @Volatile
    internal var networkBack: (() -> Unit)? = null

    // Every line here goes through prodLog, which the release build keeps; a test takes them in its place.
    internal var log: (warn: Boolean, line: String) -> Unit = { warn, line -> prodLog("QNetNetwork", warn, line) }

    // A call that ends while the app is not in front (a background wake's, or one in flight as the app left the front)
    // leaves no idle connection behind once the quiet passed.
    private val afterCall = object : EventListener() {
        override fun connectionAcquired(call: Call, connection: Connection) {
            taken.add(connection)
        }

        override fun callEnd(call: Call) = ifNotInFront()
        override fun callFailed(call: Call, ioe: IOException) = ifNotInFront()
    }

    fun clientBuilder(base: OkHttpClient.Builder, pingMs: Long = PING_MS): OkHttpClient.Builder =
        base.connectionPool(pool).pingInterval(pingMs, TimeUnit.MILLISECONDS).eventListener(afterCall)

    /**
     * React Native's WebSocket client: clientBuilder's, its opening handshake bounded by `openMs`. React Native's own
     * builder sets no read timeout and a ping starts only once a socket is open, so a path gone silent after the connect
     * would hold a socket opening for good; OkHttp lifts the call's timeout once the socket opened.
     */
    fun socketBuilder(base: OkHttpClient.Builder, openMs: Long = SOCKET_OPEN_MS, pingMs: Long = PING_MS): OkHttpClient.Builder =
        clientBuilder(base, pingMs).callTimeout(openMs, TimeUnit.MILLISECONDS)

    /** MainActivity.onResume, first: an idle connection that outlived the background is not reused. */
    fun toFront() = closeIdle()

    /** MainActivity.onPause. */
    fun toBack() = closeIdle()

    /** MainApplication.onCreate, once: the system calls back only when the default network changes. */
    fun watchNetwork(context: Context) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    defaultNetwork(network)
                }

                override fun onLost(network: Network) {
                    defaultNetwork(null)
                }
            })
        }.onFailure {
            log(true, "[WARN][NET] network_watch_failed error=${it.javaClass.simpleName}")
        }
    }

    /**
     * The default network is now `network` (null: none). A connection made on the one before reaches no one from this
     * one: idle ones close, busy ones take no new request and close once theirs end (their ping fails them sooner), so
     * every request from now on opens a new connection. True when connections were retired.
     */
    @Synchronized
    internal fun defaultNetwork(network: Any?): Boolean {
        val before = current
        current = network
        if (network != null && network != before) {
            runCatching { networkBack?.invoke() }.onFailure {
                log(true, "[WARN][NET] network_back_not_told error=${it.javaClass.simpleName}")
            }
        }
        if (before == null || before == network) return false
        closer.execute {
            runCatching {
                var busy = 0
                for (connection in synchronized(taken) { taken.toList() }) {
                    if (connection !is RealConnection) continue
                    synchronized(connection) {
                        if (!connection.noNewExchanges) busy++
                        connection.noNewExchanges = true
                    }
                }
                pool.evictAll()
                log(false, "[INFO][NET] network_changed connections_retired=$busy")
            }.onFailure {
                log(true, "[WARN][NET] network_change_failed error=${it.javaClass.simpleName}")
            }
        }
        return true
    }

    @Synchronized
    private fun ifNotInFront() {
        if (TaskState.inFront) return
        quietClose?.cancel(false)
        quietClose = closer.schedule({ evictIdle() }, QUIET_MS, TimeUnit.MILLISECONDS)
    }

    // The pooled connections no call uses, at once; a call in flight keeps its connection until it ends.
    @Synchronized
    private fun closeIdle() {
        quietClose?.cancel(false)
        quietClose = null
        closer.execute { evictIdle() }
    }

    private fun evictIdle() {
        runCatching { pool.evictAll() }.onFailure {
            log(true, "[WARN][NET] idle_close_failed error=${it.javaClass.simpleName}")
        }
    }
}

/** QNetNetwork: the JS event `qnetNetworkBack` each time a default network appears (src/services/NetworkWake.js). */
class AppNetworkModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private val tell: () -> Unit = { reactApplicationContext.emitDeviceEvent(NETWORK_BACK) }

    override fun getName(): String = "QNetNetwork"

    override fun initialize() {
        super.initialize()
        AppNetwork.networkBack = tell
    }

    // A JS restart's new module may have taken the hook already; only this one's own is let go.
    override fun invalidate() {
        if (AppNetwork.networkBack === tell) AppNetwork.networkBack = null
        super.invalidate()
    }

    // NativeEventEmitter's subscription calls: the event goes whoever listens.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Double) {}

    companion object {
        const val NETWORK_BACK = "qnetNetworkBack"
    }
}
