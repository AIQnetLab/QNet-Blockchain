package com.qnetmobile

import com.facebook.react.bridge.*
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumKeyGenerationParameters
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumKeyPairGenerator
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumParameters
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumPrivateKeyParameters
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumPublicKeyParameters
import org.bouncycastle.pqc.crypto.crystals.dilithium.DilithiumSigner
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

/**
 * QNet Dilithium3 (ML-DSA-65) Native Module for React Native
 *
 * Uses Bouncy Castle low-level (lightweight) API for CRYSTALS-Dilithium3.
 * NIST FIPS 204 compliant.
 *
 * Architecture:
 *   - Keypair deterministically derived from seed (activation code)
 *   - Signs registration/ping messages
 *   - Output format matches backend's verify_dilithium_signature() expectations
 *   - Seed-based re-derivation avoids key serialization issues
 */
class DilithiumModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "DilithiumModule"

        // Dilithium3 / ML-DSA-65 sizes (NIST FIPS 204)
        const val PUBLIC_KEY_SIZE = 1952
        const val SIGNATURE_SIZE = 3293
    }

    override fun getName(): String = NAME

    /**
     * Generate Dilithium3 keypair from deterministic seed.
     * Uses FixedSecureRandom with HMAC-SHA256 expanded seed for TRUE determinism.
     * Same seed always produces the same keypair.
     * Returns { publicKey: hex, secretKey: seed_string, publicKeySize, secretKeySize }
     */
    @ReactMethod
    fun generateKeypairFromSeed(seed: String, promise: Promise) {
        try {
            val keyPair = generateKeyPairFromSeed(seed)
            val pubKey = keyPair.public as DilithiumPublicKeyParameters
            val publicKeyBytes = pubKey.encoded

            val result = Arguments.createMap()
            result.putString("publicKey", bytesToHex(publicKeyBytes))
            // Store original seed — re-derive for signing (deterministic with FixedSecureRandom)
            result.putString("secretKey", seed)
            result.putInt("publicKeySize", publicKeyBytes.size)
            result.putInt("secretKeySize", seed.length)
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject(
                "DILITHIUM_KEYGEN_ERROR",
                "Failed to generate Dilithium3 keypair: ${e.message}",
                e
            )
        }
    }

    /**
     * Sign a message with Dilithium3.
     * secretKeySeed is the original seed string (from generateKeypairFromSeed).
     * Re-derives the keypair deterministically (FixedSecureRandom ensures same keys).
     * Returns signature in backend-compatible format:
     *   "dilithium_sig_{nodeId}_{base64}"
     * where base64 encodes:
     *   [signed_msg_len(4 LE)] [signed_message] [pk_len(4 LE)] [public_key]
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

            // Re-derive keypair from seed (deterministic — FixedSecureRandom guarantees same keypair)
            val keyPair = generateKeyPairFromSeed(secretKeySeed)
            val privKey = keyPair.private as DilithiumPrivateKeyParameters
            val pubKey = keyPair.public as DilithiumPublicKeyParameters

            // Sign the message
            val signer = DilithiumSigner()
            signer.init(true, privKey)
            val signatureBytes = signer.generateSignature(messageBytes)

            // Build combined binary format matching backend's Rust pqcrypto format:
            // [signed_msg_len as u32 LE] [signed_message = signature || message] [pk_len as u32 LE] [raw_public_key]
            val signedMessage = signatureBytes + messageBytes
            val rawPk = pubKey.encoded // Low-level API returns raw 1952 bytes

            val binaryData = ByteArray(4 + signedMessage.size + 4 + rawPk.size)
            var offset = 0

            // signed_msg_len (LE u32)
            putU32LE(binaryData, offset, signedMessage.size)
            offset += 4

            // signed message (signature || message)
            System.arraycopy(signedMessage, 0, binaryData, offset, signedMessage.size)
            offset += signedMessage.size

            // pk_len (LE u32)
            putU32LE(binaryData, offset, rawPk.size)
            offset += 4

            // raw public key
            System.arraycopy(rawPk, 0, binaryData, offset, rawPk.size)

            // Base64 encode
            val base64Sig = Base64.encodeToString(binaryData, Base64.NO_WRAP)

            // Format: dilithium_sig_{nodeId}_{base64}
            val formattedSignature = "dilithium_sig_${nodeId}_${base64Sig}"

            val result = Arguments.createMap()
            result.putString("signature", formattedSignature)
            result.putInt("signatureSize", signatureBytes.size)
            result.putInt("totalBinarySize", binaryData.size)
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject(
                "DILITHIUM_SIGN_ERROR",
                "Failed to sign with Dilithium3: ${e.message}",
                e
            )
        }
    }

    /**
     * Verify a Dilithium3 signature (for local verification / testing).
     * publicKeyHex = hex-encoded raw 1952-byte public key.
     */
    @ReactMethod
    fun verify(
        message: String,
        signatureHex: String,
        publicKeyHex: String,
        promise: Promise
    ) {
        try {
            val publicKeyBytes = hexToBytes(publicKeyHex)
            val signatureBytes = hexToBytes(signatureHex)
            val messageBytes = message.toByteArray(Charsets.UTF_8)

            val pubKey = DilithiumPublicKeyParameters(
                DilithiumParameters.dilithium3,
                publicKeyBytes
            )

            val signer = DilithiumSigner()
            signer.init(false, pubKey)
            val isValid = signer.verifySignature(messageBytes, signatureBytes)

            promise.resolve(isValid)
        } catch (e: Exception) {
            promise.reject(
                "DILITHIUM_VERIFY_ERROR",
                "Failed to verify Dilithium3 signature: ${e.message}",
                e
            )
        }
    }

    // ---- Internal helpers ----

    /**
     * Generate a deterministic Dilithium3 keypair from a string seed.
     * Uses SHAKE-256 (from SHA3 family) to expand seed into enough deterministic randomness.
     * FixedSecureRandom ensures identical keypair for identical seed every time.
     */
    private fun generateKeyPairFromSeed(seed: String): org.bouncycastle.crypto.AsymmetricCipherKeyPair {
        // Use SHA-256 to get 32-byte seed
        val md = MessageDigest.getInstance("SHA-256")
        val seedHash = md.digest(seed.toByteArray(Charsets.UTF_8))
        
        // Expand seed into enough deterministic random bytes using HMAC-DRBG pattern
        // Dilithium3 keygen needs ~4KB of randomness
        val expandedSeed = expandSeedDeterministic(seedHash, 8192)
        
        val fixedRandom = org.bouncycastle.crypto.prng.FixedSecureRandom(expandedSeed)

        val kpg = DilithiumKeyPairGenerator()
        kpg.init(
            DilithiumKeyGenerationParameters(
                fixedRandom,
                DilithiumParameters.dilithium3
            )
        )
        return kpg.generateKeyPair()
    }
    
    /**
     * Deterministically expand a 32-byte seed into N bytes using HMAC-SHA256 in counter mode.
     */
    private fun expandSeedDeterministic(seed: ByteArray, outputLen: Int): ByteArray {
        val result = ByteArray(outputLen)
        var offset = 0
        var counter = 0
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        val keySpec = javax.crypto.spec.SecretKeySpec(seed, "HmacSHA256")
        mac.init(keySpec)
        
        while (offset < outputLen) {
            mac.reset()
            mac.update(ByteArray(4) { i -> ((counter shr (i * 8)) and 0xFF).toByte() })
            val block = mac.doFinal()
            val toCopy = minOf(block.size, outputLen - offset)
            System.arraycopy(block, 0, result, offset, toCopy)
            offset += toCopy
            counter++
        }
        return result
    }

    private fun putU32LE(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = (value and 0xFF).toByte()
        buf[offset + 1] = ((value shr 8) and 0xFF).toByte()
        buf[offset + 2] = ((value shr 16) and 0xFF).toByte()
        buf[offset + 3] = ((value shr 24) and 0xFF).toByte()
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        for (i in 0 until len step 2) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) +
                    Character.digit(hex[i + 1], 16)).toByte()
        }
        return data
    }
}
