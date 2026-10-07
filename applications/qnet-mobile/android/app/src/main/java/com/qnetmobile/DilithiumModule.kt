package com.qnetmobile

import com.facebook.react.bridge.*
import android.util.Base64
import android.util.Log

/**
 * QNet Dilithium3 Native Module for React Native
 *
 * Uses the pqclean reference C implementation (same as server's pqcrypto-dilithium 0.5).
 * Provides byte-perfect compatibility with the server-side Dilithium3 verification.
 *
 * Signature size : 3309 bytes (FIPS 204 / pqclean dilithium3)
 * Public key size: 1952 bytes
 * Secret key size: 4032 bytes (hex over the bridge, never leaves the device)
 *
 * The native side serializes keygen and signing under one lock, PQClean wipes its secret locals and the stack
 * it used (dilithium_jni.c). Here the byte arrays and char buffers that held a seed or a secret key are zeroed
 * as soon as the call is done. What this module cannot zero: the seed string and the secret key's hex String
 * as they arrive from and go to JavaScript (immutable on both sides of the bridge). The determinism check at
 * wallet creation asks publicKeyFromSeed, so no second secret key is handed out. No self-test runs in a
 * release build.
 */
class DilithiumModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "DilithiumModule"
        const val PUBLIC_KEY_SIZE  = 1952
        const val SECRET_KEY_SIZE  = 4032
        const val SIGNATURE_SIZE   = 3309   // pqclean / pqcrypto-dilithium 0.5

        /** True once libdilithium_native.so has loaded. Load is fail-soft: on a device whose ABI we
         *  somehow lack, the app must NOT crash at launch (the old arm64-only build did) — the
         *  @ReactMethod calls below reject cleanly instead, so the UI still opens. */
        @Volatile @JvmStatic
        var nativeAvailable: Boolean = false
            private set

        init {
            nativeAvailable = try {
                System.loadLibrary("dilithium_native")
                true
            } catch (t: Throwable) {
                Log.e("DILITHIUM", "native lib load failed (unsupported ABI?): ${t.message}")
                false
            }
        }
    }

    // ---- Native declarations ----

    /** seedBytes = UTF-8 of the seed string. Returns pk (1952 bytes) || sk (4032 bytes) = 5984 bytes */
    private external fun nativeGenerateKeypair(seedBytes: ByteArray): ByteArray?

    /** Returns 3309-byte detached signature */
    private external fun nativeSign(skBytes: ByteArray, msgBytes: ByteArray): ByteArray?

    /** Returns true if signature is valid */
    private external fun nativeVerify(pkBytes: ByteArray, sigBytes: ByteArray, msgBytes: ByteArray): Boolean

    /** Fixed-seed keygen/sign/verify; debug builds only */
    private external fun nativeCompatTest(): String?

    override fun getName(): String = NAME

    /**
     * Generate Dilithium3 keypair from deterministic seed.
     * Returns { publicKey: hex, secretKey: hex, publicKeySize, secretKeySize }
     */
    @ReactMethod
    fun generateKeypairFromSeed(seed: String, promise: Promise) {
        if (!nativeAvailable) {
            promise.reject("DILITHIUM_NATIVE_UNAVAILABLE", "Post-quantum crypto is unavailable on this device build.")
            return
        }
        val seedBytes = seed.toByteArray(Charsets.UTF_8)
        var combined: ByteArray? = null
        var sk: ByteArray? = null
        try {
            combined = nativeGenerateKeypair(seedBytes)
                ?: throw RuntimeException("nativeGenerateKeypair returned null")

            if (combined.size != PUBLIC_KEY_SIZE + SECRET_KEY_SIZE) {
                throw RuntimeException("Unexpected keypair size: ${combined.size}")
            }

            val pk = combined.copyOfRange(0, PUBLIC_KEY_SIZE)
            sk = combined.copyOfRange(PUBLIC_KEY_SIZE, PUBLIC_KEY_SIZE + SECRET_KEY_SIZE)

            val result = Arguments.createMap()
            result.putString("publicKey", bytesToHex(pk))
            result.putString("secretKey", bytesToHex(sk))
            result.putInt("publicKeySize", pk.size)
            result.putInt("secretKeySize", sk.size)
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("DILITHIUM_KEYGEN_ERROR", "Failed to generate Dilithium3 keypair: ${e.message}", e)
        } finally {
            seedBytes.fill(0)
            combined?.fill(0)
            sk?.fill(0)
        }
    }

    /**
     * The public key alone for a seed: the wallet's determinism check derives the key a second time, and the
     * secret half of that second keypair never leaves native code (MPLAT-R2-05).
     */
    @ReactMethod
    fun publicKeyFromSeed(seed: String, promise: Promise) {
        if (!nativeAvailable) {
            promise.reject("DILITHIUM_NATIVE_UNAVAILABLE", "Post-quantum crypto is unavailable on this device build.")
            return
        }
        val seedBytes = seed.toByteArray(Charsets.UTF_8)
        var combined: ByteArray? = null
        try {
            combined = nativeGenerateKeypair(seedBytes)
                ?: throw RuntimeException("nativeGenerateKeypair returned null")
            if (combined.size != PUBLIC_KEY_SIZE + SECRET_KEY_SIZE) {
                throw RuntimeException("Unexpected keypair size: ${combined.size}")
            }
            val result = Arguments.createMap()
            result.putString("publicKey", bytesToHex(combined.copyOfRange(0, PUBLIC_KEY_SIZE)))
            result.putInt("publicKeySize", PUBLIC_KEY_SIZE)
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("DILITHIUM_KEYGEN_ERROR", "Failed to derive the public key: ${e.message}", e)
        } finally {
            seedBytes.fill(0)
            combined?.fill(0)
        }
    }

    /**
     * Sign a message with Dilithium3.
     * secretKeyHex: hex-encoded 4032-byte secret key (from generateKeypairFromSeed).
     * Returns signature in backend-compatible format:
     *   "dilithium_sig_{nodeId}_{base64}"
     * where base64 encodes:
     *   [signed_msg_len(4 LE)] [signature || message] [pk_len(4 LE)] [public_key]
     */
    @ReactMethod
    fun sign(
        message: String,
        secretKeyHex: String,
        publicKeyHex: String,
        nodeId: String,
        promise: Promise
    ) {
        if (!nativeAvailable) {
            promise.reject("DILITHIUM_NATIVE_UNAVAILABLE", "Post-quantum crypto is unavailable on this device build.")
            return
        }
        var skBytes: ByteArray? = null
        try {
            val messageBytes = message.toByteArray(Charsets.UTF_8)
            skBytes = secretKeyBytes(secretKeyHex)
            val pkBytes: ByteArray = hexToBytes(publicKeyHex)

            val sigBytes = nativeSign(skBytes, messageBytes)
                ?: throw RuntimeException("nativeSign returned null")

            if (sigBytes.size != SIGNATURE_SIZE) {
                throw RuntimeException("Unexpected sig size: ${sigBytes.size} (expected $SIGNATURE_SIZE)")
            }

            // Build binary payload: [4 LE len(sig||msg)] [sig||msg] [4 LE len(pk)] [pk]
            val signedMessage = sigBytes + messageBytes
            val binaryData = ByteArray(4 + signedMessage.size + 4 + pkBytes.size)
            var offset = 0
            putU32LE(binaryData, offset, signedMessage.size); offset += 4
            System.arraycopy(signedMessage, 0, binaryData, offset, signedMessage.size); offset += signedMessage.size
            putU32LE(binaryData, offset, pkBytes.size); offset += 4
            System.arraycopy(pkBytes, 0, binaryData, offset, pkBytes.size)

            val base64Sig = Base64.encodeToString(binaryData, Base64.NO_WRAP)
            val formattedSignature = "dilithium_sig_${nodeId}_${base64Sig}"

            val result = Arguments.createMap()
            result.putString("signature", formattedSignature)
            result.putInt("signatureSize", sigBytes.size)
            result.putInt("totalBinarySize", binaryData.size)
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("DILITHIUM_SIGN_ERROR", "Failed to sign with Dilithium3: ${e.message}", e)
        } finally {
            skBytes?.fill(0)
        }
    }

    /**
     * FIX-5: sign a message and return ONLY the RAW detached ML-DSA-65 signature (3309 bytes) as hex —
     * no "dilithium_sig_" envelope, no base64, no embedded message, no pubkey trailer. This is what the
     * node's raw-detached value-TX verifier expects. nativeSign already produces the detached signature.
     */
    @ReactMethod
    fun signDetached(
        message: String,
        secretKeyHex: String,
        promise: Promise
    ) {
        if (!nativeAvailable) {
            promise.reject("DILITHIUM_NATIVE_UNAVAILABLE", "Post-quantum crypto is unavailable on this device build.")
            return
        }
        var skBytes: ByteArray? = null
        try {
            val messageBytes = message.toByteArray(Charsets.UTF_8)
            skBytes = secretKeyBytes(secretKeyHex)
            val sigBytes = nativeSign(skBytes, messageBytes)
                ?: throw RuntimeException("nativeSign returned null")
            if (sigBytes.size != SIGNATURE_SIZE) {
                throw RuntimeException("Unexpected sig size: ${sigBytes.size} (expected $SIGNATURE_SIZE)")
            }
            val result = Arguments.createMap()
            result.putString("signature", bytesToHex(sigBytes)) // hex of the raw 3309-byte detached sig
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("DILITHIUM_SIGN_ERROR", "Failed to sign (detached) with Dilithium3: ${e.message}", e)
        } finally {
            skBytes?.fill(0)
        }
    }

    /**
     * Verify a Dilithium3 signature (local verification / testing).
     */
    @ReactMethod
    fun verify(
        message: String,
        signatureHex: String,
        publicKeyHex: String,
        promise: Promise
    ) {
        if (!nativeAvailable) {
            promise.reject("DILITHIUM_NATIVE_UNAVAILABLE", "Post-quantum crypto is unavailable on this device build.")
            return
        }
        try {
            val pkBytes  = hexToBytes(publicKeyHex)
            val sigBytes = hexToBytes(signatureHex)
            val msgBytes = message.toByteArray(Charsets.UTF_8)
            val valid = nativeVerify(pkBytes, sigBytes, msgBytes)
            promise.resolve(valid)
        } catch (e: Throwable) {
            promise.reject("DILITHIUM_VERIFY_ERROR", "Failed to verify: ${e.message}", e)
        }
    }

    /**
     * Fixed-seed keygen/sign/verify self-test. Debug builds only: a release build answers "skipped" and
     * touches no key material.
     */
    @ReactMethod
    fun compatibilityTest(promise: Promise) {
        try {
            val map = Arguments.createMap()
            map.putString("sigSize", SIGNATURE_SIZE.toString())
            map.putBoolean("isPqclean", true)
            if (!BuildConfig.DEBUG || !nativeAvailable) {
                map.putString("result", "skipped")
            } else {
                map.putString("result", nativeCompatTest() ?: throw RuntimeException("nativeCompatTest returned null"))
            }
            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("COMPAT_TEST_ERROR", e.message, e)
        }
    }

    // ---- Private helpers ----

    /** The 4032-byte secret key from its hex; anything else is refused (no re-derivation from a string). */
    private fun secretKeyBytes(secretKeyHex: String): ByteArray {
        require(secretKeyHex.length == SECRET_KEY_SIZE * 2 &&
            secretKeyHex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            "Secret key must be $SECRET_KEY_SIZE bytes of hex"
        }
        return hexToBytes(secretKeyHex)
    }

    private fun putU32LE(buf: ByteArray, offset: Int, value: Int) {
        buf[offset]   = (value and 0xFF).toByte()
        buf[offset+1] = ((value shr 8)  and 0xFF).toByte()
        buf[offset+2] = ((value shr 16) and 0xFF).toByte()
        buf[offset+3] = ((value shr 24) and 0xFF).toByte()
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val hex = "0123456789abcdef"
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            out[2 * i] = hex[v ushr 4]
            out[2 * i + 1] = hex[v and 0x0F]
        }
        val text = String(out)
        out.fill('0') // the String is a copy; the buffer that also held the key's hex is wiped
        return text
    }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        require(len % 2 == 0) { "Odd hex length: $len" }
        val data = ByteArray(len / 2)
        for (i in 0 until len step 2) {
            val hi = Character.digit(hex[i], 16)
            val lo = Character.digit(hex[i + 1], 16)
            require(hi >= 0 && lo >= 0) { "Invalid hex" }
            data[i / 2] = ((hi shl 4) + lo).toByte()
        }
        return data
    }
}
