package com.qnetmobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// The device key on a real Keystore (NodeDeviceKey): made with the challenge in its attestation, signing verifiably,
// deleted for good; and the device report. On an emulator the chain is a software one, which the network refuses.
@RunWith(AndroidJUnit4::class)
class NodeDeviceKeyTest {
    private val keys = NodeDeviceKey(InstrumentationRegistry.getInstrumentation().targetContext)
    private val alias = "${NodeDeviceKey.ALIAS_PREFIX}test_${System.nanoTime()}"
    private val challenge = MessageDigest.getInstance("SHA-256").digest("qnet_dev_enrol:v1|1337|test".toByteArray())

    @After
    fun cleanUp() = keys.delete(alias)

    private fun leafOf(created: NodeDeviceKey.Created): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(created.chain[0].inputStream()) as X509Certificate

    private fun contains(haystack: ByteArray, needle: ByteArray): Boolean =
        (0..haystack.size - needle.size).any { i -> needle.indices.all { haystack[i + it] == needle[it] } }

    @Test
    fun aNewKeyCarriesTheChallengeAndSignsVerifiably() {
        val created = keys.create(alias, challenge)
        assertTrue(created.chain.size >= 2)
        val leaf = leafOf(created)
        val pub = leaf.publicKey as ECPublicKey
        assertEquals(256, pub.params.order.bitLength())
        val attestation = leaf.getExtensionValue("1.3.6.1.4.1.11129.2.1.17")
        assertNotNull(attestation)
        assertTrue(contains(attestation, challenge))
        // Each certificate is signed by the next one; `remote` says whether the chain was remotely provisioned.
        val certs = created.chain.map { CertificateFactory.getInstance("X.509").generateCertificate(it.inputStream()) as X509Certificate }
        for (i in 0 until certs.size - 1) certs[i].verify(certs[i + 1].publicKey)
        assertEquals(certs.any { it.getExtensionValue(NodeDeviceKey.PROVISIONING_INFO_OID) != null }, created.remote)

        val data = "qnet_hwping:v2|1337|light_mobile_0123456789abcdef|1|14400".toByteArray()
        val sig = keys.sign(alias, data)
        val ok = Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(data)
            verify(sig)
        }
        assertTrue(ok)
        assertTrue(keys.has(alias))
    }

    @Test
    fun aDeletedKeyIsGoneAndItsAliasIsFree() {
        val first = leafOf(keys.create(alias, challenge)).publicKey.encoded
        keys.delete(alias)
        assertFalse(keys.has(alias))
        assertThrows(NodeDeviceKey.KeyGoneException::class.java) { keys.sign(alias, byteArrayOf(1)) }
        val second = leafOf(keys.create(alias, challenge)).publicKey.encoded
        assertFalse(first.contentEquals(second))
    }

    @Test
    fun anAliasIsNeverReusedAndInputIsChecked() {
        keys.create(alias, challenge)
        assertThrows(IllegalStateException::class.java) { keys.create(alias, challenge) }
        assertThrows(IllegalArgumentException::class.java) { keys.create("other_alias", challenge) }
        assertThrows(IllegalArgumentException::class.java) { keys.create("${alias}x", ByteArray(129)) }
        assertThrows(IllegalArgumentException::class.java) { keys.create("${alias}y", ByteArray(0)) }
        assertFalse(keys.has("${alias}x"))
    }

    @Test
    fun theReportHasItsNineBooleansInOrderAndThisDeviceIsAPhoneOrTablet() {
        val report = keys.report()
        assertEquals(
            listOf("arc", "automotive", "embedded", "feature_pc", "hsum", "leanback", "system_user", "touchscreen", "watch"),
            report.keys.toList(),
        )
        assertEquals(true, report["touchscreen"])
        assertEquals(true, report["system_user"])
        for (name in listOf("arc", "automotive", "embedded", "feature_pc", "hsum", "leanback", "watch")) {
            assertEquals(name, false, report[name])
        }
    }
}
