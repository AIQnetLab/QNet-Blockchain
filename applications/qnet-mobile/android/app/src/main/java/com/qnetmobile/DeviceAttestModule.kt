package com.qnetmobile

import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.play.core.integrity.IntegrityDialogRequest
import com.google.android.play.core.integrity.IntegrityManager
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityServiceException
import com.google.android.play.core.integrity.IntegrityTokenRequest
import com.google.android.play.core.integrity.IntegrityTokenResponse
import com.google.android.play.core.integrity.model.IntegrityDialogResponseCode
import com.google.android.play.core.integrity.model.IntegrityDialogTypeCode
import com.google.android.play.core.integrity.model.IntegrityErrorCode
import java.util.concurrent.Executors

/**
 * QNetDeviceAttest on Android (iOS: QNetDeviceAttestModule.m): the light node's device key (NodeDeviceKey), the device
 * report, and Google Play's classic integrity token with Google Play's own dialogs. The app decides nothing from
 * these; the genesis nodes and the device oracle check them. Bytes cross the bridge as standard base64.
 *
 * Stable error codes: INVALID_INPUT, KEY_MISSING, KEYSTORE_BUSY, KEYSTORE for the key; PLAY_FIXABLE (Google Play's
 * GET_INTEGRITY dialog can fix it), PLAY_UNAVAILABLE, PLAY_BUSY, PLAY_FAILED for the token.
 */
class DeviceAttestModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "QNetDeviceAttest"
    }

    private val keys = NodeDeviceKey(reactContext.applicationContext)
    // Making a key can take a second or more in StrongBox: off the bridge's own thread.
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "qnet-device-key").apply { isDaemon = true } }
    private val integrity: IntegrityManager by lazy { IntegrityManagerFactory.create(reactContext.applicationContext) }
    // What Google Play's dialogs need: the last token response, or the last failure Google Play can fix.
    @Volatile private var lastResponse: IntegrityTokenResponse? = null
    @Volatile private var lastFixable: IntegrityServiceException? = null

    override fun getName(): String = NAME

    /** { report: the nine booleans, strongBox }. */
    @ReactMethod
    fun environment(promise: Promise) {
        try {
            val report = Arguments.createMap()
            keys.report().forEach { (name, value) -> report.putBoolean(name, value) }
            promise.resolve(Arguments.createMap().apply {
                putMap("report", report)
                putBoolean("strongBox", keys.hasStrongBox())
            })
        } catch (t: Throwable) {
            promise.reject("FAILED", t.message, t)
        }
    }

    /** A new key attested over a 32-byte challenge: { chain: [DER, the key's certificate first], strongBox, remote }. */
    @ReactMethod
    fun createKey(alias: String, challengeB64: String, promise: Promise) = work(promise) {
        val created = keys.create(alias, decode(challengeB64, 32))
        Arguments.createMap().apply {
            putArray("chain", Arguments.createArray().apply { created.chain.forEach { pushString(encode(it)) } })
            putBoolean("strongBox", created.strongBox)
            putBoolean("remote", created.remote)
        }
    }

    /** The DER ECDSA-SHA256 signature of the bytes. */
    @ReactMethod
    fun sign(alias: String, dataB64: String, promise: Promise) = work(promise) { encode(keys.sign(alias, decode(dataB64))) }

    @ReactMethod
    fun hasKey(alias: String, promise: Promise) = work(promise) { keys.has(alias) }

    @ReactMethod
    fun deleteKey(alias: String, promise: Promise) = work(promise) {
        keys.delete(alias)
        null
    }

    /** A classic integrity token bound to `nonce` (base64url, derived as light-node-messages section 5 says). */
    @ReactMethod
    fun integrityToken(nonce: String, promise: Promise) {
        try {
            integrity.requestIntegrityToken(IntegrityTokenRequest.builder().setNonce(nonce).build())
                .addOnSuccessListener { response ->
                    lastResponse = response
                    lastFixable = null
                    promise.resolve(response.token())
                }
                .addOnFailureListener { e ->
                    val play = e as? IntegrityServiceException
                    lastResponse = null
                    lastFixable = play?.takeIf { it.isRemediable }
                    promise.reject(if (play == null) "PLAY_FAILED" else PlayCodes.error(play.errorCode, play.isRemediable), e.message, e)
                }
        } catch (t: Throwable) {
            promise.reject("PLAY_FAILED", t.message, t)
        }
    }

    /**
     * Google Play's own dialog over the last token answer: 'licence' (GET_LICENSED) or 'integrity' (GET_INTEGRITY,
     * also after a failure Google Play can fix). Answers 'ok', 'cancelled', 'unavailable' or 'failed'; after 'ok' the
     * app asks for a new token.
     */
    @ReactMethod
    fun showPlayDialog(kind: String, promise: Promise) {
        val type = PlayCodes.dialogType(kind) ?: return promise.reject("INVALID_INPUT", "Unknown dialog")
        val activity = reactContext.currentActivity ?: return promise.resolve("unavailable")
        val response = lastResponse?.let { IntegrityDialogRequest.IntegrityResponse.TokenResponse(it) }
            ?: lastFixable?.takeIf { type == IntegrityDialogTypeCode.GET_INTEGRITY }
                ?.let { IntegrityDialogRequest.IntegrityResponse.ExceptionDetails(it) }
            ?: return promise.resolve("unavailable")
        activity.runOnUiThread {
            try {
                val request = IntegrityDialogRequest.builder()
                    .setActivity(activity)
                    .setTypeCode(type)
                    .setIntegrityResponse(response)
                    .build()
                integrity.showDialog(request)
                    .addOnSuccessListener { code -> promise.resolve(PlayCodes.dialogResult(code)) }
                    .addOnFailureListener { promise.resolve("failed") }
            } catch (_: Throwable) {
                promise.resolve("failed")
            }
        }
    }

    private fun work(promise: Promise, block: () -> Any?) {
        worker.execute {
            try {
                promise.resolve(block())
            } catch (t: Throwable) {
                promise.reject(keyError(t), t.message, t)
            }
        }
    }

    private fun decode(b64: String, size: Int = -1): ByteArray {
        val bytes = Base64.decode(b64, Base64.NO_WRAP) // throws IllegalArgumentException on anything but base64
        require(bytes.isNotEmpty() && (size < 0 || bytes.size == size)) { "Wrong input length" }
        return bytes
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun keyError(t: Throwable): String {
        val chain = generateSequence(t) { it.cause }.take(8).toList()
        // A Keystore that did not answer says nothing about the key: busy, never missing (M2).
        if (chain.any { it is NodeDeviceKey.KeystoreUnansweredException }) return "KEYSTORE_BUSY"
        if (chain.any { it is NodeDeviceKey.KeyGoneException }) return "KEY_MISSING"
        if (chain.first() is IllegalArgumentException) return "INVALID_INPUT"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val ks = chain.firstNotNullOfOrNull { it as? android.security.KeyStoreException }
            if (ks != null && ks.isTransientFailure) return "KEYSTORE_BUSY"
            if (ks?.numericErrorCode == android.security.KeyStoreException.ERROR_KEY_DOES_NOT_EXIST) return "KEY_MISSING"
        }
        return "KEYSTORE"
    }
}

/** Google Play's integrity codes under the app's stable names (unit-tested on the JVM: PlayCodesTest). */
internal object PlayCodes {
    private val BUSY = setOf(
        IntegrityErrorCode.NETWORK_ERROR, IntegrityErrorCode.TOO_MANY_REQUESTS, IntegrityErrorCode.CANNOT_BIND_TO_SERVICE,
        IntegrityErrorCode.GOOGLE_SERVER_UNAVAILABLE, IntegrityErrorCode.CLIENT_TRANSIENT_ERROR, IntegrityErrorCode.INTERNAL_ERROR,
    )
    // No Google Play on this device, or one too old to answer: the device cannot run a node until it has one.
    private val UNAVAILABLE = setOf(
        IntegrityErrorCode.API_NOT_AVAILABLE, IntegrityErrorCode.PLAY_STORE_NOT_FOUND,
        IntegrityErrorCode.PLAY_STORE_ACCOUNT_NOT_FOUND, IntegrityErrorCode.PLAY_SERVICES_NOT_FOUND,
        IntegrityErrorCode.PLAY_STORE_VERSION_OUTDATED, IntegrityErrorCode.PLAY_SERVICES_VERSION_OUTDATED,
    )

    fun error(code: Int, remediable: Boolean): String = when {
        remediable -> "PLAY_FIXABLE"
        code in BUSY -> "PLAY_BUSY"
        code in UNAVAILABLE -> "PLAY_UNAVAILABLE"
        else -> "PLAY_FAILED"
    }

    fun dialogType(kind: String): Int? = when (kind) {
        "licence" -> IntegrityDialogTypeCode.GET_LICENSED
        "integrity" -> IntegrityDialogTypeCode.GET_INTEGRITY
        else -> null
    }

    fun dialogResult(code: Int): String = when (code) {
        IntegrityDialogResponseCode.DIALOG_SUCCESSFUL -> "ok"
        IntegrityDialogResponseCode.DIALOG_CANCELLED -> "cancelled"
        IntegrityDialogResponseCode.DIALOG_UNAVAILABLE -> "unavailable"
        else -> "failed"
    }
}
