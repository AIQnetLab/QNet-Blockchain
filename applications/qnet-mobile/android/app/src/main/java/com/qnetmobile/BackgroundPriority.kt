package com.qnetmobile

import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * QNetBackground for the JS (src/services/BackgroundPriority.js): how much Android lets the app run in the background,
 * read without any permission, and the system page where the user changes it. Nothing asks the user anything, shows a
 * notification or uses the network.
 *
 * state() → { exempt: the user exempted the app from battery optimization, bucket: its app standby bucket (Android 9+),
 * userRestricted: the user restricted its background activity (Android 9+) }; a value the system does not give is left
 * out.
 *
 * openSettings() → true when a page opened: the app's own page in the system settings
 * (ACTION_APPLICATION_DETAILS_SETTINGS), where its battery use is set (Unrestricted exempts it), else the list of
 * battery optimizations. Neither needs a permission; the direct exemption request would need one that store policy
 * keeps for a few kinds of app, and it is not used.
 */
class BackgroundPriorityModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "QNetBackground"

    @ReactMethod
    fun state(promise: Promise) {
        val context = reactContext.applicationContext
        val out = Arguments.createMap()
        runCatching {
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (power != null) out.putBoolean("exempt", power.isIgnoringBatteryOptimizations(context.packageName))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            runCatching {
                val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
                if (usage != null) out.putInt("bucket", usage.appStandbyBucket)
            }
            runCatching {
                val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                if (activity != null) out.putBoolean("userRestricted", activity.isBackgroundRestricted)
            }
        }
        promise.resolve(out)
    }

    @ReactMethod
    fun openSettings(promise: Promise) {
        val context = reactContext.applicationContext
        val pages = listOf(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        )
        val activity = reactContext.currentActivity
        for (page in pages) {
            val opened = runCatching {
                if (activity != null) activity.startActivity(page)
                else context.startActivity(page.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
            if (opened) return promise.resolve(true)
        }
        promise.resolve(false)
    }
}
