package com.qnetmobile

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The signs of a swipe from the recent apps that TaskState reads; a trim of the list is none.
class TaskStateTest {
    private val user = ApplicationExitInfo.REASON_USER_REQUESTED

    // An exit record as ApplicationExitInfo.toString writes it (Android 11+).
    private fun record(reason: Int, subreason: Int, description: String?) =
        "ApplicationExitInfo(timestamp=10/19/26 9:00 AM pid=4321 realUid=10123 packageUid=10123 definingUid=10123 user=0 " +
            "process=io.aiqnet.wallet reason=$reason (USER REQUESTED) subreason=$subreason (X) status=0 importance=400 " +
            "pss=0.00 rss=0.00 description=$description state=empty trace=null)"

    @Test
    fun theRecordsOwnSubReasonDecidesWhateverTheDescriptionSays() {
        assertTrue(removedTaskExit(user, record(user, 22, "remove task"), "remove task"))
        // A build that rewrote the description but kept the platform's sub-reason.
        assertTrue(removedTaskExit(user, record(user, 22, "swipe clean"), "swipe clean"))
        assertTrue(removedTaskExit(user, record(user, 22, null), null))
    }

    @Test
    fun withoutASubReasonTheDescriptionDecidesInAnySpelling() {
        // Android 11-12 write no sub-reason for a removed task.
        for (d in listOf("remove task", "Remove Task", "removeTask", "remove-task", "remove_task by recents")) {
            assertTrue(d, removedTaskExit(user, record(user, 0, d), d))
        }
        // A record whose text carries no sub-reason at all.
        assertTrue(removedTaskExit(user, "ApplicationExitInfo(reason=10)", "remove task"))
        assertFalse(removedTaskExit(user, "ApplicationExitInfo(reason=10)", null))
    }

    @Test
    fun otherEndsTheUserAskedForAreNoSwipe() {
        // Another app's kill of background apps, an update, a force stop, a stop from the task manager.
        assertFalse(removedTaskExit(user, record(user, 24, "kill background"), "kill background"))
        assertFalse(removedTaskExit(user, record(user, 25, "change io.aiqnet.wallet"), "change io.aiqnet.wallet"))
        assertFalse(removedTaskExit(user, record(user, 21, "from pid 1234"), "from pid 1234"))
        assertFalse(removedTaskExit(user, record(user, 23, "fully stop io.aiqnet.wallet/0 by user request"), "fully stop"))
        // A number that only starts with 22 is not the sub-reason.
        assertFalse(removedTaskExit(user, record(user, 220, "other"), "other"))
    }

    @Test
    fun anEndTheUserDidNotAskForIsNeverASwipe() {
        val low = ApplicationExitInfo.REASON_LOW_MEMORY
        assertFalse(removedTaskExit(low, record(low, 22, "remove task"), "remove task"))
        assertFalse(removedTaskExit(ApplicationExitInfo.REASON_OTHER, record(13, 0, "remove task"), "remove task"))
    }

    @Test
    fun aTaskLeavingTheRecentAppsCountsOnlyWhenItsProcessThenEnds() {
        val dir = java.nio.file.Files.createTempDirectory("marks").toFile()
        try {
            val takeBacks = mutableListOf<Pair<Long, () -> Unit>>()
            val removed = RemovalMarks(dir, 100) { ms, takeBack -> takeBacks += ms to takeBack }
            val next = RemovalMarks(dir, 200) { _, _ -> }
            // A trim: onTaskRemoved, and the process lives on past the settle time and takes its mark back.
            removed.mark()
            assertFalse(removed.leftByEndedProcess())
            assertEquals(listOf(REMOVAL_SETTLE_MS), takeBacks.map { it.first })
            takeBacks.forEach { it.second() }
            assertFalse(next.leftByEndedProcess())
            // A swipe: onTaskRemoved, and the process ends before the take-back runs.
            takeBacks.clear()
            removed.mark()
            assertTrue(next.leftByEndedProcess())
            // Opening the app (or the next process acting on it) clears every mark.
            next.clear()
            assertFalse(next.leftByEndedProcess())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun onAndroid7AWatchOnlyBackgroundAnswersStartedStopsItself() {
        assertTrue(watchStopsItself(24, startedInFront = false))
        assertTrue(watchStopsItself(25, startedInFront = false))
        assertFalse(watchStopsItself(25, startedInFront = true))
        // Android 8+ stops a background service itself.
        assertFalse(watchStopsItself(26, startedInFront = false))
        assertFalse(watchStopsItself(36, startedInFront = false))
    }

    @Test
    fun aTaskMissingFromTheRecentAppsInsideTheKeepWindowIsTakenForTheUsersRemoval() {
        val keep = recentsKeepMs(-1, DEFAULT_KEEP_HOURS)
        val hour = 3_600_000L
        // A swipe of a task whose process had already ended, an hour after the app left the front.
        assertTrue(removedInsideKeepWindow(true, hour, keep) { true })
        assertTrue(removedInsideKeepWindow(true, 0L, keep) { true })
        assertTrue(removedInsideKeepWindow(true, keep - KEEP_WINDOW_MARGIN_MS - 1, keep) { true })
        // The task is still listed: nothing to say.
        assertFalse(removedInsideKeepWindow(true, hour, keep) { false })
    }

    @Test
    fun outsideTheKeepWindowTheMissingTaskSaysNothingAndTheListIsNotRead() {
        val keep = recentsKeepMs(-1, DEFAULT_KEEP_HOURS)
        val read = mutableListOf<Unit>()
        val gone = { read += Unit; true }
        // The system may have trimmed it: inactive past the window (less the margin), or in another boot.
        assertFalse(removedInsideKeepWindow(true, keep - KEEP_WINDOW_MARGIN_MS, keep, gone))
        assertFalse(removedInsideKeepWindow(true, 7 * 3_600_000L, keep, gone))
        assertFalse(removedInsideKeepWindow(false, 3_600_000L, keep, gone))
        assertFalse(removedInsideKeepWindow(true, -1L, keep, gone))
        // A device that keeps recent apps by count alone has no window.
        assertFalse(removedInsideKeepWindow(true, 0L, recentsKeepMs(9, DEFAULT_KEEP_HOURS), gone))
        assertEquals(0, read.size)
    }

    @Test
    fun theKeepWindowIsThePlatformsSessionTimeUnlessACountLimitsTheList() {
        assertEquals(6 * 3_600_000L, recentsKeepMs(-1, 6))
        assertEquals(3_600_000L, recentsKeepMs(-1, 1))
        assertEquals(0L, recentsKeepMs(9, 6))
        assertEquals(0L, recentsKeepMs(0, 6))
        assertEquals(0L, recentsKeepMs(-1, 0))
        assertEquals(0L, recentsKeepMs(-1, -1))
    }

    @Test
    fun aRemovalMarkCountsOnlyWhenAnotherProcessLeftIt() {
        assertTrue(removalByEndedProcess(listOf("task_removed_123"), 456))
        // The process's own mark: it may still be inside its settle time (a trimmed task), so it says nothing.
        assertFalse(removalByEndedProcess(listOf("task_removed_456"), 456))
        assertTrue(removalByEndedProcess(listOf("task_removed_456", "task_removed_123"), 456))
        assertFalse(removalByEndedProcess(emptyList(), 456))
        assertFalse(removalByEndedProcess(listOf("other_file", "task_removed_", "task_removed_x"), 456))
    }
}
