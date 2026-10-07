package com.qnetmobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyGenerator

/**
 * The device key of a light node on Android (docs/protocols/light-node-messages.md section 5.1): an EC P-256 key in
 * StrongBox or the TEE (pickBacking), made with an attestation challenge under an alias the app chooses
 * (JS: NodeDeviceKey.js). No user authentication and no unlocked-device requirement, so it signs in a background wake; no
 * device-properties attestation, so the chain names no model. Also the device report: what kind of device this is and
 * whether the app runs in its main user. Nothing here uses the network.
 */
class NodeDeviceKey(private val context: Context) {

    companion object {
        const val ALIAS_PREFIX = "qnet_dev_"
        private const val KEYSTORE = "AndroidKeyStore"
        // ChromeOS runs Android apps with one of these features (Google's documented check).
        private const val ARC = "org.chromium.arc"
        private const val ARC_MANAGED = "org.chromium.arc.device_management"
        // The provisioning-information extension: present in a chain whose attestation key came by remote provisioning.
        const val PROVISIONING_INFO_OID = "1.3.6.1.4.1.11129.2.1.30"
        // The app's Keystore probe (SecurityModule makes the same one): an entry of its own, so an empty listing of the
        // store is known to be an unanswered one. It guards nothing.
        private const val PROBE_ALIAS = "qnet_keystore_probe_v1"
        private const val KEY_READS = 3
        private const val KEY_READ_PAUSE_MS = 150L
    }

    /** `remote`: the chain carries the provisioning-information extension (a remotely provisioned attestation key). */
    class Created(val chain: List<ByteArray>, val strongBox: Boolean, val remote: Boolean)

    /** The alias holds no private key: never made, deleted, or gone with the app's data. */
    class KeyGoneException : Exception("The device key is gone")

    /**
     * The Keystore did not answer for an alias it may hold (a null read that no answered listing confirms: below Android
     * 12 a daemon that did not answer reads as null too). Never a key that is gone, so the key is never deleted for it (M2).
     */
    class KeystoreUnansweredException : Exception("The Keystore did not answer")

    /** The nine booleans of the device report, in the report's key order. */
    fun report(): LinkedHashMap<String, Boolean> {
        val pm = context.packageManager
        val users = context.getSystemService(Context.USER_SERVICE) as UserManager
        return linkedMapOf(
            "arc" to (pm.hasSystemFeature(ARC) || pm.hasSystemFeature(ARC_MANAGED)),
            "automotive" to pm.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE),
            "embedded" to pm.hasSystemFeature(PackageManager.FEATURE_EMBEDDED),
            "feature_pc" to pm.hasSystemFeature(PackageManager.FEATURE_PC),
            "hsum" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && UserManager.isHeadlessSystemUserMode()),
            "leanback" to pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK),
            "system_user" to users.isSystemUser,
            "touchscreen" to pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN),
            "watch" to pm.hasSystemFeature(PackageManager.FEATURE_WATCH),
        )
    }

    fun hasStrongBox(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    fun has(alias: String): Boolean = keyStore().containsAlias(checked(alias))

    fun delete(alias: String) {
        checked(alias)
        runCatching { keyStore().deleteEntry(alias) }
    }

    /**
     * A new key under a free alias with `challenge` as its attestation challenge, and its certificate chain from the
     * key's own certificate to the root. The backing is chosen by pickBacking; a failed attempt leaves nothing under
     * the alias.
     */
    fun create(alias: String, challenge: ByteArray): Created {
        checked(alias)
        require(challenge.size in 1..128) { "The attestation challenge must be 1 to 128 bytes" }
        check(!keyStore().containsAlias(alias)) { "The alias is taken" }
        return pickBacking(
            hasStrongBox(),
            make = { strongBox ->
                try {
                    generate(alias, challenge, strongBox).let { it to it.remote }
                } catch (t: Throwable) {
                    runCatching { keyStore().deleteEntry(alias) }
                    throw t
                }
            },
            drop = { runCatching { keyStore().deleteEntry(alias) } },
        )
    }

    private fun generate(alias: String, challenge: ByteArray, strongBox: Boolean): Created {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAttestationChallenge(challenge)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
            .apply { initialize(spec.build()) }
            .generateKeyPair()
        val certs = keyStore().getCertificateChain(alias)?.toList().orEmpty()
        check(certs.isNotEmpty()) { "The key has no certificate chain" }
        val remote = certs.any { (it as? X509Certificate)?.getExtensionValue(PROVISIONING_INFO_OID) != null }
        return Created(certs.map { it.encoded }, strongBox, remote)
    }

    /**
     * ECDSA-SHA256 over `data` with the key under `alias`, DER-encoded. KeyGoneException only when an answered listing of
     * the store leaves the alias out; KeystoreUnansweredException when the Keystore could not say (KeyPresence).
     */
    fun sign(alias: String, data: ByteArray): ByteArray {
        val key = privateKey(checked(alias))
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
    }

    private fun privateKey(alias: String): PrivateKey {
        val found = readKeystoreEntry(
            KEY_READS,
            { attempt -> SystemClock.sleep(KEY_READ_PAUSE_MS * attempt) },
            { keyStore().getKey(alias, null) as? PrivateKey },
            { aliasListing(alias, PROBE_ALIAS, { keyStore().aliases().toList() }, ::ensureProbeKey) },
        )
        return when (found) {
            is KeyRead.Found -> found.value
            KeyRead.Absent -> throw KeyGoneException()
            KeyRead.Unanswered -> throw KeystoreUnansweredException()
        }
    }

    // The probe exists (made here when a read finds none): true once it does.
    private fun ensureProbeKey(): Boolean {
        if (keyStore().getKey(PROBE_ALIAS, null) != null) return true
        val spec = KeyGenParameterSpec.Builder(PROBE_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(128)
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
        return true
    }

    private fun checked(alias: String): String {
        require(alias.startsWith(ALIAS_PREFIX) && alias.length <= 64) { "Not a device key alias" }
        return alias
    }
}

/**
 * Which backing holds the device key (unit-tested on the JVM: KeyBackingTest). StrongBox first, but a remotely
 * provisioned chain wins over the stronger chip: the network gives a factory-provisioned chain a 1-day lease and
 * tighter limits. `make(strongBox)` makes the key and says whether its chain is remotely provisioned, leaving nothing
 * behind when it throws; `drop()` clears a key that is not kept.
 */
internal fun <T> pickBacking(strongBoxAvailable: Boolean, make: (strongBox: Boolean) -> Pair<T, Boolean>, drop: () -> Unit): T {
    var last: Throwable? = null
    var factoryStrongBox = false
    for (strongBox in if (strongBoxAvailable) listOf(true, false) else listOf(false)) {
        try {
            val (made, remote) = make(strongBox)
            if (remote || !strongBox) return made
            factoryStrongBox = true
            drop()
        } catch (t: Throwable) {
            last = t
        }
    }
    // The TEE could not make one after a factory-provisioned StrongBox key: that key again.
    if (factoryStrongBox) return make(true).first
    throw last ?: IllegalStateException("No device key could be made")
}
