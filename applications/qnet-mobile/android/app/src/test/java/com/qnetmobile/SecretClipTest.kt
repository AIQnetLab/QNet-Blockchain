package com.qnetmobile

import org.junit.Assert.assertEquals
import org.junit.Test

// A copied recovery phrase or private key leaves the clipboard when due, also after the process that copied it ended.
class SecretClipTest {
    private val copy = SecretCopy(stamp = 777L, copiedAt = 10_000L, dueAt = 70_000L, boots = 5)

    @Test
    fun nothingKeptDoesNothing() {
        assertEquals(ClipAction.NONE, secretClipAction(null, 80_000L, 5, force = true, clipStamp = null))
    }

    @Test
    fun aCopyWaitsUntilDueUnlessDeleteWalletForcesIt() {
        assertEquals(ClipAction.WAIT, secretClipAction(copy, 30_000L, 5, force = false, clipStamp = 777L))
        assertEquals(ClipAction.CLEAR, secretClipAction(copy, 30_000L, 5, force = true, clipStamp = 777L))
    }

    @Test
    fun aDueCopyIsClearedWhileItIsStillTheClipOrCannotBeRead() {
        assertEquals(ClipAction.CLEAR, secretClipAction(copy, 70_000L, 5, force = false, clipStamp = 777L))
        // In the background Android hides the clipboard from the app: it is cleared all the same, a clip copied since in
        // another app too, as the copy hint says, so a phrase never waits on the clipboard for the app's next open.
        assertEquals(ClipAction.CLEAR, secretClipAction(copy, 90_000L, 5, force = false, clipStamp = null))
        // Below API 26 a clip has no timestamp to compare: cleared when due.
        assertEquals(ClipAction.CLEAR, secretClipAction(copy.copy(stamp = null), 70_000L, 5, force = false, clipStamp = null))
    }

    @Test
    fun aLaterClipIsTheUsersOwnAndStays() {
        assertEquals(ClipAction.FORGET, secretClipAction(copy, 90_000L, 5, force = false, clipStamp = 999L))
        assertEquals(ClipAction.FORGET, secretClipAction(copy, 30_000L, 5, force = true, clipStamp = 999L))
    }

    @Test
    fun aCopyFromAnotherBootIsForgottenTheClipboardDidNotSurviveTheRestart() {
        assertEquals(ClipAction.FORGET, secretClipAction(copy, 90_000L, 6, force = true, clipStamp = null))
        // Without a boot count, a boot clock below the copy's is a new boot.
        val unknown = copy.copy(boots = -1)
        assertEquals(ClipAction.FORGET, secretClipAction(unknown, 5_000L, -1, force = true, clipStamp = null))
        assertEquals(ClipAction.CLEAR, secretClipAction(unknown, 80_000L, -1, force = false, clipStamp = null))
    }
}
