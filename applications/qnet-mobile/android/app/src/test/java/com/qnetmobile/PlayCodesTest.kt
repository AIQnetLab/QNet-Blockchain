package com.qnetmobile

import com.google.android.play.core.integrity.model.IntegrityDialogResponseCode
import com.google.android.play.core.integrity.model.IntegrityDialogTypeCode
import com.google.android.play.core.integrity.model.IntegrityErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Google Play's integrity codes as the app names them (DeviceAttestModule.PlayCodes).
class PlayCodesTest {

    @Test
    fun aFailureGooglePlayCanFixIsFixableWhateverItsCode() {
        for (code in listOf(IntegrityErrorCode.PLAY_SERVICES_VERSION_OUTDATED, IntegrityErrorCode.NETWORK_ERROR, -999)) {
            assertEquals("PLAY_FIXABLE", PlayCodes.error(code, true))
        }
    }

    @Test
    fun transientFailuresAreBusy() {
        for (code in listOf(
            IntegrityErrorCode.NETWORK_ERROR, IntegrityErrorCode.TOO_MANY_REQUESTS, IntegrityErrorCode.CANNOT_BIND_TO_SERVICE,
            IntegrityErrorCode.GOOGLE_SERVER_UNAVAILABLE, IntegrityErrorCode.CLIENT_TRANSIENT_ERROR, IntegrityErrorCode.INTERNAL_ERROR,
        )) {
            assertEquals("PLAY_BUSY", PlayCodes.error(code, false))
        }
    }

    @Test
    fun noOrOutdatedGooglePlayIsUnavailable() {
        for (code in listOf(
            IntegrityErrorCode.API_NOT_AVAILABLE, IntegrityErrorCode.PLAY_STORE_NOT_FOUND, IntegrityErrorCode.PLAY_STORE_ACCOUNT_NOT_FOUND,
            IntegrityErrorCode.PLAY_SERVICES_NOT_FOUND, IntegrityErrorCode.PLAY_STORE_VERSION_OUTDATED,
            IntegrityErrorCode.PLAY_SERVICES_VERSION_OUTDATED,
        )) {
            assertEquals("PLAY_UNAVAILABLE", PlayCodes.error(code, false))
        }
    }

    @Test
    fun ourOwnMistakesAndUnknownCodesFail() {
        for (code in listOf(
            IntegrityErrorCode.NONCE_TOO_SHORT, IntegrityErrorCode.NONCE_TOO_LONG, IntegrityErrorCode.NONCE_IS_NOT_BASE64,
            IntegrityErrorCode.APP_NOT_INSTALLED, IntegrityErrorCode.APP_UID_MISMATCH,
            IntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID, -999,
        )) {
            assertEquals("PLAY_FAILED", PlayCodes.error(code, false))
        }
    }

    @Test
    fun twoDialogsAndTheirAnswers() {
        assertEquals(IntegrityDialogTypeCode.GET_LICENSED, PlayCodes.dialogType("licence"))
        assertEquals(IntegrityDialogTypeCode.GET_INTEGRITY, PlayCodes.dialogType("integrity"))
        for (kind in listOf("strong", "GET_LICENSED", "")) assertNull(PlayCodes.dialogType(kind))
        assertEquals("ok", PlayCodes.dialogResult(IntegrityDialogResponseCode.DIALOG_SUCCESSFUL))
        assertEquals("cancelled", PlayCodes.dialogResult(IntegrityDialogResponseCode.DIALOG_CANCELLED))
        assertEquals("unavailable", PlayCodes.dialogResult(IntegrityDialogResponseCode.DIALOG_UNAVAILABLE))
        assertEquals("failed", PlayCodes.dialogResult(IntegrityDialogResponseCode.DIALOG_FAILED))
        assertEquals("failed", PlayCodes.dialogResult(42))
    }
}
