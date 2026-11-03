package com.qnetmobile

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The inbox MainActivity puts every link in: kept in order until the wallet screen is done with it, never applied twice,
// and kept on the device so a new process has the links its predecessor ended on.
class LinkInboxTest {
    private val sol = "https://link.aiqnet.io/send#to=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&amount=0.001"
    private val link = "https://link.aiqnet.io/l#v1.x"

    // The device's storage as the next process finds it.
    private class Disk : LinkStore {
        var text: String? = null
        override fun read(): String? = text
        override fun write(value: String) {
            text = value
        }
    }

    private var clock = 1_793_031_451_000L
    private val logged = mutableListOf<String>()
    private fun process(disk: Disk, max: Int = INBOX_MAX) = Inbox(max, disk, { clock }, { _, line -> logged += line })

    @Test
    fun aLinkWaitsUntilTheScreenIsDoneWithItWhateverIsReadMeanwhile() {
        val inbox = Inbox()
        inbox.offer(sol)
        // Read by a screen that went (an activity finished by Back, the JS started again) and by the next one alike.
        assertEquals(listOf(sol), inbox.pending().map { it.url })
        assertEquals(listOf(sol), inbox.pending().map { it.url })
        inbox.done(inbox.pending().single().id)
        assertEquals(emptyList<String>(), inbox.pending().map { it.url })
    }

    @Test
    fun twoLinksInARowWaitInTheirOrderAndTheSameLinkTwiceIsOne() {
        val inbox = Inbox()
        inbox.offer(sol)
        inbox.offer(link)
        inbox.offer(sol)
        val waiting = inbox.pending()
        assertEquals(listOf(sol, link), waiting.map { it.url })
        // Done with the first: the second still waits, under its own id; a done id is never taken for another link.
        inbox.done(waiting[0].id)
        inbox.done(waiting[0].id)
        assertEquals(listOf(link), inbox.pending().map { it.url })
        // The same link again once it was done is a new request.
        inbox.offer(sol)
        assertEquals(listOf(link, sol), inbox.pending().map { it.url })
        assertEquals(true, inbox.pending()[1].id > waiting[1].id)
    }

    @Test
    fun aFullInboxRefusesTheNewestAndSaysSoNeverDroppingOneThatWaits() {
        val inbox = process(Disk(), max = 2)
        for (i in 1..3) inbox.offer("$link$i")
        assertEquals(listOf("${link}1", "${link}2"), inbox.pending().map { it.url })
        assertEquals(
            listOf(
                "[INFO][LINK] link_received waiting=1", "[INFO][LINK] link_received waiting=2",
                "[WARN][LINK] link_dropped reason=full waiting=2",
            ),
            logged,
        )
    }

    // Each link that comes is said with how many wait, never the link itself; the same link again is not a new one.
    @Test
    fun eachLinkThatComesIsSaidWithHowManyWaitAndNothingOfIt() {
        val inbox = process(Disk())
        inbox.offer(sol)
        inbox.offer(sol)
        inbox.offer(link)
        inbox.done(inbox.pending()[0].id)
        inbox.offer("${link}2")
        assertEquals(
            listOf(
                "[INFO][LINK] link_received waiting=1", "[INFO][LINK] link_received waiting=2",
                "[INFO][LINK] link_received waiting=2",
            ),
            logged,
        )
    }

    // The lines the JS asks for: each event's own keys in a fixed order, a value only when it is a short code or a
    // whole number, at WARN only for an answer that did not arrive; any other event writes nothing.
    @Test
    fun aNoteWritesOnlyItsEventsKeysAndOnlyCodesAndWholeNumbers() {
        assertEquals("[INFO][LINK] request_shown intent=connect offer=NO_WALLET",
            noteLine("request_shown", mapOf("offer" to "NO_WALLET", "intent" to "connect", "token" to "SOL")))
        assertEquals("[INFO][LINK] answer_delivered intent=link status=201 ms=842",
            noteLine("answer_delivered", mapOf("intent" to "link", "status" to 201.0, "ms" to 842.0, "outcome" to "delivered")))
        assertEquals("[WARN][LINK] answer_not_delivered intent=claim outcome=expired status=none ms=30000",
            noteLine("answer_not_delivered", mapOf("intent" to "claim", "outcome" to "expired", "status" to "none", "ms" to 30_000)))
        assertEquals("[INFO][LINK] transfer_form_opened token=1DEV", noteLine("transfer_form_opened", mapOf("token" to "1DEV")))
        // A session id, an address, a link, a key, a fraction, a negative or a clock reading: left out.
        val data = listOf(
            "0123456789abcdef0123456789abcdef", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", sol, "a-b", "", 1.5, -1.0,
            1_793_031_451_000.0, Double.NaN, true, null,
        )
        for (value in data) {
            assertEquals("$value", "[INFO][LINK] request_shown", noteLine("request_shown", mapOf("intent" to value, "offer" to value)))
        }
        assertNull(noteLine("link_received", mapOf("intent" to "connect")))
        assertNull(noteLine("anything", emptyMap()))
    }

    @Test
    fun aNewProcessHasTheLinksTheLastOneEndedOnInTheirOrderWithTheirArrival() {
        val disk = Disk()
        val first = process(disk)
        first.offer(sol)
        clock += 1_000
        first.offer(link)
        val arrived = first.pending().map { it.at }
        // The process ends; the next one starts with what the device kept.
        clock += 60_000
        val next = process(disk)
        assertEquals(listOf(sol, link), next.pending().map { it.url })
        assertEquals(arrived, next.pending().map { it.at })
        // A link that comes now joins them after, and the same link again is still one.
        next.offer("${link}2")
        next.offer(sol)
        assertEquals(listOf(sol, link, "${link}2"), next.pending().map { it.url })
        // Only the arrivals are said: nothing of what the device kept is dropped.
        assertEquals(
            listOf(
                "[INFO][LINK] link_received waiting=1", "[INFO][LINK] link_received waiting=2",
                "[INFO][LINK] link_received waiting=3",
            ),
            logged,
        )
    }

    @Test
    fun aLinkTheScreenIsDoneWithNeverComesBackInANewProcess() {
        val disk = Disk()
        val first = process(disk)
        first.offer(sol)
        first.offer(link)
        first.done(first.pending()[0].id)
        assertEquals(listOf(link), process(disk).pending().map { it.url })
        val second = process(disk)
        second.done(second.pending().single().id)
        assertEquals(emptyList<String>(), process(disk).pending().map { it.url })
    }

    @Test
    fun aLinkKeptLongerThanItsLifeOrDatedAheadOfTheClockIsDroppedAndSaid() {
        val disk = Disk()
        val first = process(disk)
        first.offer(sol)
        clock += 30_000
        first.offer(link)
        // The first one's life ends; the second one's is still on.
        clock += LINK_LIFE_MS - 29_000
        logged.clear()
        val next = process(disk)
        assertEquals(listOf(link), next.pending().map { it.url })
        assertEquals(listOf("[INFO][LINK] link_dropped reason=stale age_s=601"), logged)
        // What was dropped is gone from the device too.
        assertEquals(listOf(link), decodeLinks(disk.text).map { it.first })
        // A clock set back past the arrival: no age can be told, so it is dropped.
        logged.clear()
        clock -= 3_600_000
        assertEquals(emptyList<String>(), process(disk).pending().map { it.url })
        assertEquals(listOf("[INFO][LINK] link_dropped reason=stale age_s=-3029"), logged)
    }

    @Test
    fun theKeptFormReadsBackAnyUrlAndNothingFromAStringItDidNotWrite() {
        val odd = listOf("https://link.aiqnet.io/l#a:b:c" to 1L, "x\n12:3:y" to 2L, "é" to 3L)
        assertEquals(odd, decodeLinks(encodeLinks(odd)))
        assertEquals(emptyList<Pair<String, Long>>(), decodeLinks(encodeLinks(emptyList())))
        for (bad in listOf("1:5:abc", "x:3:abc", "1:x:abc", "1:0:", "1:3", "1:3:abc2", "1:-1:a", "1:99999999999:a")) {
            assertEquals(bad, emptyList<Pair<String, Long>>(), decodeLinks(bad))
        }
        // A store a newer or older build left unreadable starts the inbox empty, and the next change writes it anew.
        val disk = Disk().apply { text = "garbage" }
        val inbox = process(disk)
        assertEquals(emptyList<String>(), inbox.pending().map { it.url })
        inbox.offer(sol)
        assertEquals(listOf(sol), process(disk).pending().map { it.url })
    }

    @Test
    fun onlyAFreshViewIntentBringsALink() {
        assertEquals(sol, deliveredLink(Intent.ACTION_VIEW, sol, 0, restored = false))
        // Restored after the process ended, or relaunched from the recent apps: the old intent's link stays unread.
        assertNull(deliveredLink(Intent.ACTION_VIEW, sol, 0, restored = true))
        assertNull(deliveredLink(Intent.ACTION_VIEW, sol, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY, restored = false))
        // A launcher start, or a VIEW with no data.
        assertNull(deliveredLink(Intent.ACTION_MAIN, null, 0, restored = false))
        assertNull(deliveredLink(Intent.ACTION_VIEW, "", 0, restored = false))
        assertNull(deliveredLink(Intent.ACTION_VIEW, null, 0, restored = false))
    }
}
