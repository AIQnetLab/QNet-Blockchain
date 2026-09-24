package com.qnetmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/** Which distribution this build is: "site" (the APK from aiqnet.io and GitHub) or "play" (Google Play). */
class StoreModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName() = "QNetStore"
    override fun getConstants(): Map<String, Any> = mapOf("STORE" to BuildConfig.FLAVOR)
}
