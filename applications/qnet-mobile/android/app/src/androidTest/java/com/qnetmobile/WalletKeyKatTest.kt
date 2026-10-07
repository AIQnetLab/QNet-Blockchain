package com.qnetmobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// The wallet key the native ML-DSA-65 module derives on the device, against the two phrases of
// docs/protocols/light-node.vectors.json (the known answers every client pins): the seed string gives the key whose
// EON address the vectors name. __tests__/NativeKat.test.js keeps these constants equal to the vectors.
@RunWith(AndroidJUnit4::class)
class WalletKeyKatTest {
    private val vectors = listOf(
        "QNET_WALLET_MLDSA65_v1:5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
            to "d9fa370374e24333242eon847d1d354dcd87fe873823e",
        "QNET_WALLET_MLDSA65_v1:17e4b5661796eeff8904550f8572289317ece7c1cc1316469f8f4c986c1ffd7b9f4c3aeac3e1713ffc21fa33707d09d57a2ece358d72111ef7c7658e7b33f2d5"
            to "60b4f3e026e24dcc7d8eonfda2b095a258ab95c1db2c0",
    )

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    // The module's own native keygen, as the JS calls reach it (pk || sk).
    private fun keypair(seed: String): ByteArray {
        val module = DilithiumModule(BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext))
        val keygen = DilithiumModule::class.java.getDeclaredMethod("nativeGenerateKeypair", ByteArray::class.java)
        keygen.isAccessible = true
        return keygen.invoke(module, seed.toByteArray(Charsets.UTF_8)) as ByteArray
    }

    @Test
    fun theSeedStringsGiveTheWalletKeysOfTheVectors() {
        assertTrue(DilithiumModule.nativeAvailable)
        for ((seed, address) in vectors) {
            val pair = keypair(seed)
            assertEquals(DilithiumModule.PUBLIC_KEY_SIZE + DilithiumModule.SECRET_KEY_SIZE, pair.size)
            val pk = pair.copyOfRange(0, DilithiumModule.PUBLIC_KEY_SIZE)
            // The address is SHA-512(pk) as hex: 19 characters, "eon", the next 15, and a checksum.
            val digest = hex(MessageDigest.getInstance("SHA-512").digest(pk))
            assertEquals(address.substring(0, 37), "${digest.substring(0, 19)}eon${digest.substring(19, 34)}")
            assertEquals(hex(pk), hex(keypair(seed).copyOfRange(0, DilithiumModule.PUBLIC_KEY_SIZE)))
        }
    }
}
