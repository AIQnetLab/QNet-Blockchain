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
 * Secret key size: 4032 bytes (stored as hex, never leaves device)
 *
 * Seed management: secret key is re-derived from the activation-code seed on every use.
 */
class DilithiumModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "DilithiumModule"
        const val PUBLIC_KEY_SIZE  = 1952
        const val SECRET_KEY_SIZE  = 4032
        const val SIGNATURE_SIZE   = 3309   // pqclean / pqcrypto-dilithium 0.5

        init {
            System.loadLibrary("dilithium_native")
        }
    }

    // ---- Native declarations ----

    /** Returns pk (1952 bytes) || sk (4032 bytes) = 5984 bytes */
    private external fun nativeGenerateKeypair(seedStr: String): ByteArray?

    /** Returns 3309-byte detached signature */
    private external fun nativeSign(skBytes: ByteArray, msgBytes: ByteArray): ByteArray?

    /** Returns true if signature is valid */
    private external fun nativeVerify(pkBytes: ByteArray, sigBytes: ByteArray, msgBytes: ByteArray): Boolean

    /** Runs self-test, logs results to logcat and returns status string */
    private external fun nativeCompatTest(): String?

    override fun getName(): String = NAME

    // Run the native compat test on init — verifies the pqclean C code is working
    init {
        Thread {
            try {
                val result = nativeCompatTest()
                Log.e("DILITHIUM_COMPAT", "=== PQCLEAN NATIVE COMPAT TEST ===")
                Log.e("DILITHIUM_COMPAT", "Result: $result")
                Log.e("DILITHIUM_COMPAT", "SIG_SIZE=$SIGNATURE_SIZE (pqcrypto-dilithium 0.5 compatible)")
            } catch (e: Exception) {
                Log.e("DILITHIUM_COMPAT", "ERROR: ${e.message}")
            }
        }.start()
    }

    /**
     * Generate Dilithium3 keypair from deterministic seed.
     * Returns { publicKey: hex, secretKey: hex, publicKeySize, secretKeySize }
     * secretKey is the raw sk bytes in hex — re-derived from seed when needed.
     */
    @ReactMethod
    fun generateKeypairFromSeed(seed: String, promise: Promise) {
        try {
            val combined = nativeGenerateKeypair(seed)
                ?: throw RuntimeException("nativeGenerateKeypair returned null")

            if (combined.size != PUBLIC_KEY_SIZE + SECRET_KEY_SIZE) {
                throw RuntimeException("Unexpected keypair size: ${combined.size}")
            }

            val pk = combined.copyOfRange(0, PUBLIC_KEY_SIZE)
            val sk = combined.copyOfRange(PUBLIC_KEY_SIZE, PUBLIC_KEY_SIZE + SECRET_KEY_SIZE)

            val result = Arguments.createMap()
            result.putString("publicKey", bytesToHex(pk))
            // Store sk as hex — it can always be re-derived from seed
            // but storing it avoids re-running keygen on every sign call
            result.putString("secretKey", bytesToHex(sk))
            result.putInt("publicKeySize", pk.size)
            result.putInt("secretKeySize", sk.size)
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("DILITHIUM_KEYGEN_ERROR", "Failed to generate Dilithium3 keypair: ${e.message}", e)
        }
    }

    /**
     * Sign a message with Dilithium3.
     * secretKeySeed: hex-encoded 4032-byte secret key (from generateKeypairFromSeed).
     *   If it looks like a raw seed string (not hex / wrong length), re-derive the keypair.
     * Returns signature in backend-compatible format:
     *   "dilithium_sig_{nodeId}_{base64}"
     * where base64 encodes:
     *   [signed_msg_len(4 LE)] [signature || message] [pk_len(4 LE)] [public_key]
     */
    @ReactMethod
    fun sign(
        message: String,
        secretKeySeed: String,
        publicKeyHex: String,
        nodeId: String,
        promise: Promise
    ) {
        try {
            val messageBytes = message.toByteArray(Charsets.UTF_8)

            // Resolve sk bytes: if hex of correct length use directly, else re-derive
            val skBytes: ByteArray = resolveSecretKey(secretKeySeed)
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
        } catch (e: Exception) {
            promise.reject("DILITHIUM_SIGN_ERROR", "Failed to sign with Dilithium3: ${e.message}", e)
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
        try {
            val pkBytes  = hexToBytes(publicKeyHex)
            val sigBytes = hexToBytes(signatureHex)
            val msgBytes = message.toByteArray(Charsets.UTF_8)
            val valid = nativeVerify(pkBytes, sigBytes, msgBytes)
            promise.resolve(valid)
        } catch (e: Exception) {
            promise.reject("DILITHIUM_VERIFY_ERROR", "Failed to verify: ${e.message}", e)
        }
    }

    /**
     * Run pqclean compatibility test (native).
     * Generates keypair, signs, verifies. Logs PK/SIG hex for cross-check with Rust.
     */
    @ReactMethod
    fun compatibilityTest(promise: Promise) {
        try {
            val result = nativeCompatTest()
                ?: throw RuntimeException("nativeCompatTest returned null")
            Log.e("DILITHIUM_COMPAT", "compatibilityTest result: $result")
            val map = Arguments.createMap()
            map.putString("result", result)
            map.putString("sigSize", SIGNATURE_SIZE.toString())
            map.putBoolean("isPqclean", true)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("COMPAT_TEST_ERROR", e.message, e)
        }
    }

    // ---- Private helpers ----

    /**
     * Resolve secret key bytes.
     * If secretKeySeed is hex of length 2*SECRET_KEY_SIZE (8064 chars) — decode directly.
     * Otherwise treat as a seed string and re-derive keypair.
     */
    private fun resolveSecretKey(secretKeySeed: String): ByteArray {
        if (secretKeySeed.length == SECRET_KEY_SIZE * 2 && secretKeySeed.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            return hexToBytes(secretKeySeed)
        }
        // Legacy path: re-derive from seed string
        val combined = nativeGenerateKeypair(secretKeySeed)
            ?: throw RuntimeException("Failed to re-derive keypair from seed")
        return combined.copyOfRange(PUBLIC_KEY_SIZE, PUBLIC_KEY_SIZE + SECRET_KEY_SIZE)
    }

    private fun putU32LE(buf: ByteArray, offset: Int, value: Int) {
        buf[offset]   = (value and 0xFF).toByte()
        buf[offset+1] = ((value shr 8)  and 0xFF).toByte()
        buf[offset+2] = ((value shr 16) and 0xFF).toByte()
        buf[offset+3] = ((value shr 24) and 0xFF).toByte()
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        require(len % 2 == 0) { "Odd hex length: $len" }
        val data = ByteArray(len / 2)
        for (i in 0 until len step 2) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) +
                            Character.digit(hex[i + 1], 16)).toByte()
        }
        return data
    }
}
