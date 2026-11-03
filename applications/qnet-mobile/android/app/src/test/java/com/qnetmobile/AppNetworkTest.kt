package com.qnetmobile

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// The app's HTTP clients: one pool, a ping that retires a connection gone silent, no idle connection out of front past a
// short quiet, and none made on a network the device left.
class AppNetworkTest {
    private val servers = mutableListOf<Closeable>()
    private var wasInFront = false
    private val logged = LinkedBlockingQueue<String>()
    private val warned = LinkedBlockingQueue<String>()
    private lateinit var wasLog: (Boolean, String) -> Unit

    @Before
    fun setUp() {
        wasInFront = TaskState.inFront
        wasLog = AppNetwork.log
        AppNetwork.log = { warn, line -> (if (warn) warned else logged).add(line) }
        if (AppNetwork.defaultNetwork(null)) retired()
        logged.clear()
        warned.clear()
        AppNetwork.pool.evictAll()
    }

    @After
    fun tearDown() {
        servers.forEach { runCatching { it.close() } }
        TaskState.inFront = wasInFront
        if (AppNetwork.defaultNetwork(null)) retired()
        AppNetwork.log = wasLog
        AppNetwork.pool.evictAll()
    }

    // The closing worker finished a network change.
    private fun retired(): String = logged.poll(2, TimeUnit.SECONDS) ?: error("no network change was carried out")

    @Test
    fun everyClientSharesOnePoolAndPings() {
        val a = AppNetwork.clientBuilder(OkHttpClient.Builder()).build()
        val b = AppNetwork.clientBuilder(OkHttpClient.Builder()).build()
        assertSame(AppNetwork.pool, a.connectionPool)
        assertSame(a.connectionPool, b.connectionPool)
        // A per-request client React Native derives (newBuilder) keeps both.
        val derived = a.newBuilder().callTimeout(1, TimeUnit.SECONDS).build()
        assertSame(AppNetwork.pool, derived.connectionPool)
        assertEquals(15_000, a.pingIntervalMillis)
        assertEquals(15_000, derived.pingIntervalMillis)
    }

    // A call on a connection gone silent is taken to a new connection once the ping fails, within two intervals.
    @Test
    fun aCallOnAConnectionGoneSilentGoesThroughOnANewOneWithinTwoPings() {
        TaskState.inFront = true
        val server = h2Server(
            MockResponse().setBody("one"), MockResponse().setBody("two"), MockResponse().setBody("three"),
        )
        val relay = FreezingRelay(InetSocketAddress(InetAddress.getLoopbackAddress(), server.port)).also { servers += it }
        val client = h2Client()
        val url = "https://localhost:${relay.port}/"

        client.newCall(Request.Builder().url(url).build()).execute().use {
            assertEquals(Protocol.HTTP_2, it.protocol)
            assertEquals("one", it.body!!.string())
        }
        assertEquals(1, relay.accepted.get())

        relay.freezeOpen()
        val answered = CountDownLatch(1)
        val body = AtomicReference<String>()
        val afterMs = AtomicLong(-1)
        val start = System.nanoTime()
        val second = client.newCall(Request.Builder().url(url).build())
        second.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = answered.countDown()

            override fun onResponse(call: Call, response: Response) {
                response.use { body.set(it.body!!.string()) }
                afterMs.set((System.nanoTime() - start) / 1_000_000)
                answered.countDown()
            }
        })
        try {
            assertTrue("a call on the silent connection never ended", answered.await(6, TimeUnit.SECONDS))
            assertEquals("two", body.get())
            assertTrue("answered after ${afterMs.get()} ms", afterMs.get() <= 3_500)
        } finally {
            second.cancel()
        }
        assertEquals(2, relay.accepted.get())

        // The silent connection left the pool: the next call goes on the new one.
        client.newCall(Request.Builder().url(url).build()).execute().use { assertEquals("three", it.body!!.string()) }
        assertEquals(2, relay.accepted.get())
    }

    // React Native's WebSocket client (WebSocketModule: no read timeout) through AppNetwork, as MainApplication sets
    // it: a live socket answers its pings and stays open past its opening bound; one gone silent fails within two pings,
    // and the screen opens a new one.
    @Test
    fun aWebSocketGoneSilentFailsWithinTwoPingsAndALiveOneStaysOpen() {
        val server = MockWebServer().apply {
            enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {}))
            start(InetAddress.getLoopbackAddress(), 0)
        }
        servers += server
        val relay = FreezingRelay(InetSocketAddress(InetAddress.getLoopbackAddress(), server.port)).also { servers += it }
        val client = AppNetwork.socketBuilder(reactNativeSocketBuilder(), openMs = 1000, pingMs = 1000).build()
        val opened = CountDownLatch(1)
        val failed = CountDownLatch(1)
        val failedAt = AtomicLong(-1)
        val host = checkNotNull(InetAddress.getLoopbackAddress().hostAddress)
        val url = HttpUrl.Builder().scheme("http").host(host).port(relay.port).build()
        val socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = opened.countDown()

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                failedAt.set(System.nanoTime())
                failed.countDown()
            }
        })
        try {
            assertTrue("the socket never opened", opened.await(5, TimeUnit.SECONDS))
            assertFalse("a live socket failed", failed.await(2_500, TimeUnit.MILLISECONDS))
            val frozenAt = System.nanoTime()
            relay.freezeOpen()
            assertTrue("a silent socket never failed", failed.await(5, TimeUnit.SECONDS))
            val afterMs = (failedAt.get() - frozenAt) / 1_000_000
            assertTrue("failed after $afterMs ms", afterMs <= 2_500)
        } finally {
            socket.cancel()
        }
        assertEquals(15_000, AppNetwork.clientBuilder(OkHttpClient.Builder()).build().pingIntervalMillis)
        assertEquals(15_000, AppNetwork.socketBuilder(OkHttpClient.Builder()).build().pingIntervalMillis)
    }

    // A socket whose opening handshake gets no answer (the server reads the upgrade request and never responds) fails
    // within its bound, so the screen opens a new one; with no bound it would stay opening for good.
    @Test
    fun aWebSocketWhoseOpeningGetsNoAnswerFailsWithinItsBound() {
        val server = MockWebServer().apply {
            enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            start(InetAddress.getLoopbackAddress(), 0)
        }
        servers += server
        val client = AppNetwork.socketBuilder(reactNativeSocketBuilder(), openMs = 1000).build()
        val failed = CountDownLatch(1)
        val failedAt = AtomicLong(-1)
        val host = checkNotNull(InetAddress.getLoopbackAddress().hostAddress)
        val url = HttpUrl.Builder().scheme("http").host(host).port(server.port).encodedPath("/ws/subscribe").build()
        val startedAt = System.nanoTime()
        val socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                failedAt.set(System.nanoTime())
                failed.countDown()
            }
        })
        try {
            assertTrue("an opening socket never failed", failed.await(5, TimeUnit.SECONDS))
            val afterMs = (failedAt.get() - startedAt) / 1_000_000
            assertTrue("failed after $afterMs ms", afterMs in 900..3_000)
            assertEquals("/ws/subscribe", server.takeRequest(1, TimeUnit.SECONDS)?.path)
        } finally {
            socket.cancel()
        }
        assertEquals(AppNetwork.SOCKET_OPEN_MS.toInt(), AppNetwork.socketBuilder(OkHttpClient.Builder()).build().callTimeoutMillis)
        assertEquals(0, AppNetwork.clientBuilder(OkHttpClient.Builder()).build().callTimeoutMillis)
    }

    // React Native's WebSocket client builder as WebSocketModule makes it, before MainApplication's builder.
    private fun reactNativeSocketBuilder() = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MINUTES)

    // A server that takes longer than two pings to answer on a live connection answers the pings meanwhile: nothing is
    // cut, and the answer comes on that connection.
    @Test
    fun aSlowAnswerOnALiveConnectionIsNotCut() {
        TaskState.inFront = true
        val slow = MockResponse().setBody("slow").setHeadersDelay(2_500, TimeUnit.MILLISECONDS)
        val server = h2Server(MockResponse().setBody("one"), slow)
        val client = h2Client()
        val url = "https://localhost:${server.port}/"
        client.newCall(Request.Builder().url(url).build()).execute().use { assertEquals("one", it.body!!.string()) }
        val start = System.nanoTime()
        client.newCall(Request.Builder().url(url).build()).execute().use {
            assertEquals(Protocol.HTTP_2, it.protocol)
            assertEquals("slow", it.body!!.string())
        }
        assertTrue((System.nanoTime() - start) / 1_000_000 >= 2_500)
        assertEquals(0, server.takeRequest().sequenceNumber)
        assertEquals(1, server.takeRequest().sequenceNumber)
    }

    // In front an idle connection stays. Out of front a wake's reads of one node a second apart share it, and it closes
    // once QUIET_MS passed with no call.
    @Test
    fun outOfFrontAWakesReadsShareOneConnectionThatClosesAfterTheQuietAndInFrontItStays() {
        val server = MockWebServer().apply { start(InetAddress.getLoopbackAddress(), 0) }
        servers += server
        val client = AppNetwork.clientBuilder(OkHttpClient.Builder()).build()

        TaskState.inFront = true
        get(client, server)
        Thread.sleep(300)
        assertEquals(1, AppNetwork.pool.idleConnectionCount())

        TaskState.inFront = false
        get(client, server)
        Thread.sleep(1_000)
        get(client, server)
        assertEquals(listOf(0, 1, 2), List(3) { server.takeRequest().sequenceNumber })
        Thread.sleep(AppNetwork.QUIET_MS / 2)
        assertEquals(1, AppNetwork.pool.idleConnectionCount())
        assertTrue(
            "an idle connection stayed out of front",
            eventually(AppNetwork.QUIET_MS + 2_000) { AppNetwork.pool.idleConnectionCount() == 0 },
        )
    }

    @Test
    fun leavingAndReturningToTheFrontCloseIdleConnections() {
        val server = MockWebServer().apply { start(InetAddress.getLoopbackAddress(), 0) }
        servers += server
        val client = AppNetwork.clientBuilder(OkHttpClient.Builder()).build()
        TaskState.inFront = true

        get(client, server)
        assertEquals(1, AppNetwork.pool.idleConnectionCount())
        AppNetwork.toBack()
        assertTrue(eventually { AppNetwork.pool.idleConnectionCount() == 0 })

        get(client, server)
        assertEquals(1, AppNetwork.pool.idleConnectionCount())
        AppNetwork.toFront()
        assertTrue(eventually { AppNetwork.pool.idleConnectionCount() == 0 })
    }

    // After a change of network (a VPN turned off) no request goes on a connection made before it, a busy one included
    // (HTTP/2 would carry the next request on it), with no ping involved; the request in flight on it is not cut.
    @Test
    fun aNewNetworkSendsEveryLaterRequestOnANewConnectionAndCutsNothingInFlight() {
        TaskState.inFront = true
        val server = h2Server().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path == "/slow") {
                    MockResponse().setBody("slow").setHeadersDelay(1_500, TimeUnit.MILLISECONDS)
                } else {
                    MockResponse().setBody("ok")
                }
            }
        }
        val relay = FreezingRelay(InetSocketAddress(InetAddress.getLoopbackAddress(), server.port)).also { servers += it }
        val client = h2Client(pingMs = 60_000)
        val base = "https://localhost:${relay.port}"
        assertFalse("the first network retires nothing", AppNetwork.defaultNetwork("wifi"))

        client.newCall(Request.Builder().url("$base/").build()).execute().use { assertEquals("ok", it.body!!.string()) }
        val slow = AtomicReference<String>()
        val slowDone = CountDownLatch(1)
        client.newCall(Request.Builder().url("$base/slow").build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = slowDone.countDown()

            override fun onResponse(call: Call, response: Response) {
                response.use { slow.set(it.body!!.string()) }
                slowDone.countDown()
            }
        })
        assertTrue(eventually { AppNetwork.pool.connectionCount() == 1 && AppNetwork.pool.idleConnectionCount() == 0 })
        assertEquals(1, relay.accepted.get())

        assertTrue(AppNetwork.defaultNetwork("mobile"))
        val line = retired()
        val start = System.nanoTime()
        client.newCall(Request.Builder().url("$base/").build()).execute().use { assertEquals("ok", it.body!!.string()) }
        assertEquals("a request after the change joined the connection made before it", 2, relay.accepted.get())
        assertTrue((System.nanoTime() - start) / 1_000_000 < 1_000)
        assertEquals("[INFO][NET] network_changed connections_retired=1", line)

        assertTrue(slowDone.await(5, TimeUnit.SECONDS))
        assertEquals("slow", slow.get())
        // The retired connection closes once its last request ended; the new one stays for what comes next.
        assertTrue(eventually { AppNetwork.pool.connectionCount() == 1 })
    }

    @Test
    fun losingTheNetworkClosesIdleConnectionsAndTheNextNetworkFindsNoneToClose() {
        val server = MockWebServer().apply { start(InetAddress.getLoopbackAddress(), 0) }
        servers += server
        val client = AppNetwork.clientBuilder(OkHttpClient.Builder()).build()
        TaskState.inFront = true
        assertFalse(AppNetwork.defaultNetwork("wifi"))
        get(client, server)
        assertEquals(1, AppNetwork.pool.idleConnectionCount())
        assertFalse("the same network again changes nothing", AppNetwork.defaultNetwork("wifi"))
        assertEquals(1, AppNetwork.pool.idleConnectionCount())

        assertTrue(AppNetwork.defaultNetwork(null))
        retired()
        assertEquals(0, AppNetwork.pool.idleConnectionCount())
        assertFalse(AppNetwork.defaultNetwork("mobile"))
    }

    // A default network that appears (the first, one after none, another) wakes the JS retries that wait on a back-off
    // for aiqnet.io; the same network again, or its loss, does not.
    @Test
    fun everyNetworkThatAppearsIsToldToJsAndNothingElseIs() {
        val told = AtomicInteger()
        val was = AppNetwork.networkBack
        AppNetwork.networkBack = { told.incrementAndGet() }
        try {
            assertFalse(AppNetwork.defaultNetwork("wifi"))
            assertEquals(1, told.get())
            assertFalse(AppNetwork.defaultNetwork("wifi"))
            assertEquals(1, told.get())
            assertTrue(AppNetwork.defaultNetwork(null))
            retired()
            assertEquals(1, told.get())
            assertFalse(AppNetwork.defaultNetwork("wifi"))
            assertEquals(2, told.get())
            assertTrue(AppNetwork.defaultNetwork("mobile"))
            retired()
            assertEquals(3, told.get())
        } finally {
            AppNetwork.networkBack = was
        }
    }

    // A failure is written at WARN through the pool's one log (prodLog in the app, kept in the release build).
    @Test
    fun aHookThatFailsIsLoggedAtWarnThroughTheLog() {
        val was = AppNetwork.networkBack
        AppNetwork.networkBack = { throw IllegalStateException() }
        try {
            assertFalse(AppNetwork.defaultNetwork("wifi"))
            assertEquals(listOf("[WARN][NET] network_back_not_told error=IllegalStateException"), warned.toList())
            assertTrue(logged.isEmpty())
        } finally {
            AppNetwork.networkBack = was
        }
    }

    @Test
    fun theActivityAndTheNetworkCallbackUseThePool() {
        val activity = File("src/main/java/com/qnetmobile/MainActivity.kt").readText()
        assertTrue(Regex("""override fun onPause\(\) \{[^}]*AppNetwork\.toBack\(\)""").containsMatchIn(activity))
        val application = File("src/main/java/com/qnetmobile/MainApplication.kt").readText()
        // The system's default-network callback, registered once for the process, tells AppNetwork of every change.
        assertTrue(application.contains("AppNetwork.watchNetwork(this)"))
        val network = File("src/main/java/com/qnetmobile/AppNetwork.kt").readText()
        assertTrue(network.contains("registerDefaultNetworkCallback("))
        assertTrue(Regex("""override fun onAvailable\(network: Network\) \{\s*defaultNetwork\(network\)""").containsMatchIn(network))
        assertTrue(Regex("""override fun onLost\(network: Network\) \{\s*defaultNetwork\(null\)""").containsMatchIn(network))
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("""<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />"""))
    }

    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()

    // A local HTTP/2 server over TLS that answers `responses` in turn.
    private fun h2Server(vararg responses: MockResponse) = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        protocols = listOf(Protocol.HTTP_2, Protocol.HTTP_1_1)
        responses.forEach { enqueue(it) }
        start(InetAddress.getLoopbackAddress(), 0)
    }.also { servers += it }

    // React Native's builder (no connect, read or write timeout: OkHttpClientProvider.createClientBuilder) through
    // AppNetwork with a ping every `pingMs` (a second), trusting h2Server's certificate.
    private fun h2Client(pingMs: Long = 1000): OkHttpClient {
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val rn = OkHttpClient.Builder().connectTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(0, TimeUnit.MILLISECONDS)
        return AppNetwork.clientBuilder(rn, pingMs = pingMs)
            .sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
            .dns(object : Dns {
                override fun lookup(hostname: String) = listOf(InetAddress.getLoopbackAddress())
            })
            .build()
    }

    private fun get(client: OkHttpClient, server: MockWebServer) {
        server.enqueue(MockResponse().setBody("ok"))
        client.newCall(Request.Builder().url(server.url("/")).build()).execute().use { assertEquals("ok", it.body!!.string()) }
    }

    private fun eventually(ms: Long = 2000, done: () -> Boolean): Boolean {
        val until = System.nanoTime() + ms * 1_000_000
        while (System.nanoTime() < until) {
            if (done()) return true
            Thread.sleep(20)
        }
        return done()
    }
}

// A TCP relay in front of a server whose open connections can go silent: bytes stop in both directions and nothing is
// closed, as on a network that drops a flow without a word.
private class FreezingRelay(private val target: InetSocketAddress) : Closeable {
    private val listener = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val sockets = CopyOnWriteArrayList<Socket>()
    @Volatile private var silentUpTo = 0
    val accepted = AtomicInteger()
    val port: Int get() = listener.localPort

    init {
        thread(isDaemon = true, name = "relay-accept") {
            while (true) {
                val client = try { listener.accept() } catch (_: IOException) { return@thread }
                val n = accepted.incrementAndGet()
                val upstream = Socket(target.address, target.port)
                sockets += client
                sockets += upstream
                pump(client, upstream, n)
                pump(upstream, client, n)
            }
        }
    }

    // Every connection open now goes silent; later ones flow.
    fun freezeOpen() {
        silentUpTo = accepted.get()
    }

    private fun pump(from: Socket, to: Socket, n: Int) = thread(isDaemon = true) {
        val buf = ByteArray(16 * 1024)
        try {
            while (true) {
                val read = from.getInputStream().read(buf)
                if (n <= silentUpTo) return@thread
                if (read < 0) {
                    to.shutdownOutput()
                    return@thread
                }
                to.getOutputStream().write(buf, 0, read)
                to.getOutputStream().flush()
            }
        } catch (_: IOException) {
        }
    }

    override fun close() {
        listener.close()
        sockets.forEach { runCatching { it.close() } }
    }
}
