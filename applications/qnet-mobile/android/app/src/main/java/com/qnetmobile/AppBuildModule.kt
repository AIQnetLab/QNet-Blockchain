package com.qnetmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * What kind of build this is, for the JS (src/config/legacy.js): `legacyMove` only in the last update of the old
 * package com.qnetmobile (android/app/build.gradle, -PqnetLegacyMove), which keeps the wallet, runs no node and tells
 * the user to move to io.aiqnet.wallet. Every other build answers false.
 */
class AppBuildModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "QNetAppBuild"

    override fun getConstants(): Map<String, Any> = mapOf("legacyMove" to BuildConfig.QNET_LEGACY_MOVE)
}
