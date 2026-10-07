package com.qnetmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

// Which backing holds the device key (pickBacking): StrongBox first, a remotely provisioned chain before the stronger
// chip, and a failed or discarded attempt always cleared.
class KeyBackingTest {
    private class Keystore(private val answers: Map<Boolean, List<Any>>) {
        val made = mutableListOf<Boolean>()
        var drops = 0
        private val next = mutableMapOf(true to 0, false to 0)

        // An answer is `true` (remote chain), `false` (factory chain) or a Throwable.
        fun make(strongBox: Boolean): Pair<String, Boolean> {
            made += strongBox
            val list = answers.getValue(strongBox)
            val answer = list[minOf(next.getValue(strongBox), list.size - 1)]
            next[strongBox] = next.getValue(strongBox) + 1
            if (answer is Throwable) throw answer
            return (if (strongBox) "strongbox" else "tee") to (answer as Boolean)
        }

        fun pick(strongBoxAvailable: Boolean = true) = pickBacking(strongBoxAvailable, this::make) { drops++ }
    }

    @Test
    fun aRemoteStrongBoxChainIsKeptAtOnce() {
        val ks = Keystore(mapOf(true to listOf(true), false to listOf(true)))
        assertEquals("strongbox", ks.pick())
        assertEquals(listOf(true), ks.made)
        assertEquals(0, ks.drops)
    }

    @Test
    fun aFactoryStrongBoxChainGivesWayToARemoteTeeChain() {
        val ks = Keystore(mapOf(true to listOf(false), false to listOf(true)))
        assertEquals("tee", ks.pick())
        assertEquals(listOf(true, false), ks.made)
        assertEquals(1, ks.drops)
    }

    @Test
    fun whenBothChainsAreFactoryTheTeeKeyIsKept() {
        val ks = Keystore(mapOf(true to listOf(false), false to listOf(false)))
        assertEquals("tee", ks.pick())
        assertEquals(listOf(true, false), ks.made)
        assertEquals(1, ks.drops)
    }

    @Test
    fun aTeeFailureAfterAFactoryStrongBoxKeyMakesTheStrongBoxKeyAgain() {
        val ks = Keystore(mapOf(true to listOf(false), false to listOf(IllegalStateException("tee"))))
        assertEquals("strongbox", ks.pick())
        assertEquals(listOf(true, false, true), ks.made)
    }

    @Test
    fun aStrongBoxFailureFallsBackToTheTee() {
        val ks = Keystore(mapOf(true to listOf(IllegalStateException("strongbox")), false to listOf(false)))
        assertEquals("tee", ks.pick())
        assertEquals(listOf(true, false), ks.made)
        assertEquals(0, ks.drops)
    }

    @Test
    fun withoutStrongBoxOnlyTheTeeIsTriedWhateverItsChain() {
        for (remote in listOf(true, false)) {
            val ks = Keystore(mapOf(true to listOf(true), false to listOf(remote)))
            assertEquals("tee", ks.pick(strongBoxAvailable = false))
            assertEquals(listOf(false), ks.made)
        }
    }

    @Test
    fun whenNothingCanMakeAKeyTheLastFailureIsThrown() {
        val ks = Keystore(mapOf(true to listOf(IllegalStateException("strongbox")), false to listOf(IllegalArgumentException("tee"))))
        val e = assertThrows(IllegalArgumentException::class.java) { ks.pick() }
        assertEquals("tee", e.message)
        val none = Keystore(mapOf(true to listOf(true), false to listOf(IllegalStateException("tee only"))))
        assertEquals("tee only", assertThrows(IllegalStateException::class.java) { none.pick(strongBoxAvailable = false) }.message)
    }
}
