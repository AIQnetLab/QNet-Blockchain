package com.qnetmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Which distribution this build is — "site" (the APK from aiqnet.io and GitHub) or "play" (Google Play) —
 * and which version, so the site APK can tell whether a newer release exists.
 */
class StoreModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "QNetStore"
    override fun getConstants(): Map<String, Any> = mapOf(
        "STORE" to BuildConfig.FLAVOR,
        "VERSION_CODE" to BuildConfig.VERSION_CODE,
        "VERSION_NAME" to BuildConfig.VERSION_NAME,
    )
}
