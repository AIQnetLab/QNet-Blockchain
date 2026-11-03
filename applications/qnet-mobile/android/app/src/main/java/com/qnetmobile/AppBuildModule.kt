package com.qnetmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * What kind of build this is, for the JS: `legacyMove` (src/config/legacy.js) only in the last update of the old
 * package com.qnetmobile (android/app/build.gradle, -PqnetLegacyMove), which keeps the wallet, runs no node and tells
 * the user to move to io.aiqnet.wallet; every other build answers false. `version` and `build`: the app's version and
 * build number, which its requests name (src/utils/clientAgent.js).
 */
class AppBuildModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "QNetAppBuild"

    override fun getConstants(): Map<String, Any> = mapOf(
        "legacyMove" to BuildConfig.QNET_LEGACY_MOVE,
        "version" to BuildConfig.VERSION_NAME,
        "build" to BuildConfig.VERSION_CODE.toString(),
    )
}
