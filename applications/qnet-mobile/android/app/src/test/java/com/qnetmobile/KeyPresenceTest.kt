package com.qnetmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

// MA-R2-01: a Keystore read that answers null is a key that is gone only when an answered listing leaves the alias out.
// containsAlias, getCertificate and (below Android 12) getKey answer null for a Keystore that failed too, and a key made
// or deleted on such an answer replaces the one a stored vault depends on.
class KeyPresenceTest {
    // A Keystore whose reads and listings answer from queues: null or an empty list is what a failed call gives.
    private class FakeStore(reads: List<String?>, listings: List<List<String>>, var probeMakes: Boolean = true) {
        private val reads = ArrayDeque(reads)
        private val listings = ArrayDeque(listings)
        val pauses = mutableListOf<Int>()
        var readCount = 0
        var probeMade = false

        fun read(): String? { readCount++; return if (reads.isEmpty()) null else reads.removeFirst() }
        fun list(): List<String> {
            val next = if (listings.isEmpty()) emptyList() else listings.removeFirst()
            return if (probeMade && next.isEmpty()) listOf(PROBE) else next
        }
        fun ensureProbe(): Boolean { if (!probeMakes) throw IllegalStateException("busy"); probeMade = true; return true }
        fun run(alias: String = SEAL) = readKeystoreEntry(3, { pauses += it }, ::read) {
            aliasListing(alias, PROBE, ::list, ::ensureProbe)
        }
    }

    companion object {
        const val SEAL = "qnet_vault_seal_v2"
        const val PROBE = "qnet_keystore_probe_v1"
    }

    @Test
    fun aReadThatFindsTheKeyNeedsNoListing() {
        val ks = FakeStore(listOf("key"), emptyList())
        assertEquals(KeyRead.Found("key"), ks.run())
        assertEquals(emptyList<Int>(), ks.pauses)
    }

    @Test
    fun aNullReadWhileTheListingNamesTheAliasIsReadAgainNotTakenForAbsence() {
        // The finding's case: containsAlias answers false once while the key is there.
        val ks = FakeStore(listOf(null, "key"), listOf(listOf(SEAL, "qnet_vault_bio_v1")))
        assertEquals(KeyRead.Found("key"), ks.run())
        assertEquals(listOf(1), ks.pauses)
    }

    @Test
    fun aKeystoreThatNeverAnswersIsUnansweredNeverAbsent() {
        // Every read null and every listing empty (a failed listing is empty too), and no probe key can be made.
        val ks = FakeStore(emptyList(), emptyList(), probeMakes = false)
        assertSame(KeyRead.Unanswered, ks.run())
        assertEquals(listOf(1, 2), ks.pauses)
    }

    @Test
    fun aListedKeyThatNeverReadsIsUnanswered() {
        val ks = FakeStore(emptyList(), listOf(listOf(SEAL), listOf(SEAL), listOf(SEAL)))
        assertSame(KeyRead.Unanswered, ks.run())
    }

    @Test
    fun anAnsweredListingWithoutTheAliasIsAbsence() {
        val ks = FakeStore(emptyList(), listOf(listOf("qnet_vault_bio_v1")))
        assertSame(KeyRead.Absent, ks.run())
        assertEquals(emptyList<Int>(), ks.pauses)
        assertEquals(false, ks.probeMade)
    }

    @Test
    fun anEmptyListingIsCheckedWithTheProbeKeyBeforeItCountsAsAbsence() {
        // A store with nothing in it (a new install, or a device the app moved to): the probe proves the listing.
        val ks = FakeStore(emptyList(), emptyList())
        assertSame(KeyRead.Absent, ks.run())
        assertEquals(true, ks.probeMade)
    }

    @Test
    fun anEmptyListingThatStillLacksTheProbeIsUnknown() {
        assertEquals(AliasListing.UNKNOWN, aliasListing(SEAL, PROBE, { emptyList() }, { true }))
        assertEquals(AliasListing.UNKNOWN, aliasListing(SEAL, PROBE, { throw IllegalStateException("busy") }, { true }))
    }

    @Test
    fun aListingNamingOtherEntriesSettlesTheAnswer() {
        assertEquals(AliasListing.NOT_LISTED, aliasListing(SEAL, PROBE, { listOf("x") }, { error("not needed") }))
        assertEquals(AliasListing.LISTED, aliasListing(SEAL, PROBE, { listOf("x", SEAL) }, { error("not needed") }))
    }

    @Test
    fun aKeyThatAppearsRightAfterAnAnsweredListingIsFound() {
        val ks = FakeStore(listOf(null, "key"), listOf(listOf("other")))
        assertEquals(KeyRead.Found("key"), ks.run())
    }
}
