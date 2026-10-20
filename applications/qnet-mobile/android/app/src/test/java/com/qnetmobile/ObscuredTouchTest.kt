package com.qnetmobile

import android.view.MotionEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Which touches on a guarded screen came through another app's window (MPLAT-R5-02).
class ObscuredTouchTest {
    private val full = MotionEvent.FLAG_WINDOW_IS_OBSCURED
    private val partial = MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED

    @Test
    fun aWindowOverTheTouchPointItselfAlwaysCounts() {
        for (sdk in listOf(26, 29, 30, 31, 36)) {
            assertTrue(obscuredByOtherApp(sdk, full, ownWindowShown = false))
            assertTrue(obscuredByOtherApp(sdk, full or partial, ownWindowShown = true))
        }
    }

    @Test
    fun onAndroid10And11ThePartialMarkCountsOnlyWhileNoWindowOfTheAppsOwnIsShown() {
        for (sdk in listOf(29, 30)) {
            assertTrue(obscuredByOtherApp(sdk, partial, ownWindowShown = false))
            // A text handle or the paste toolbar of the app itself marks the touch too.
            assertFalse(obscuredByOtherApp(sdk, partial, ownWindowShown = true))
        }
    }

    @Test
    fun fromAndroid12ThePartialMarkAlwaysCounts() {
        assertTrue(obscuredByOtherApp(31, partial, ownWindowShown = true))
        assertTrue(obscuredByOtherApp(36, partial, ownWindowShown = false))
    }

    @Test
    fun anUncoveredTouchAndAPartialMarkBeforeApi29AreNoCover() {
        assertFalse(obscuredByOtherApp(36, 0, ownWindowShown = false))
        assertFalse(obscuredByOtherApp(28, partial, ownWindowShown = false))
    }
}
