package com.qnetmobile

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Whether the user swiped QNet Wallet away from the recent apps since it was last opened (owner rule, 04.10: a light
 * node is counted only while the wallet runs on its device; JS: src/services/TaskState.android.js). Android removes the
 * app's task and, with no foreground service, ends its process; a data push or a scheduled wake may still start a new
 * process in the background, which must answer nothing until the app is opened again. Two signs, either one enough:
 * TaskWatchService's onTaskRemoved while the process lives, and (Android 11+) the system's record that the last process
 * ended for the removed task, read by the next process. MainActivity.onResume clears the mark. Nothing here uses the
 * network, and nothing names the device.
 *
 * What Android cannot see (L-7), so the node answers then, by the owner's rule that it answers when the app cannot
 * tell: a swipe on Android 8 to 10 (API 26-29) more than about a minute after the app left the front, unless the user
 * granted the battery exemption (the system has stopped TaskWatchService by then and keeps no exit record below
 * Android 11); and on any version a swipe after the system had already ended the app's process (no process to tell, no
 * "remove task" record). An empty list of the app's tasks is not a sign either: the system trims recent apps without
 * any swipe (beyond the most recent few after some hours, fewer on low-memory devices), so reading it would stop honest
 * nodes. Only a foreground service could see these swipes, and the app runs none.
 */
object TaskState {
    private const val PREFS = "qnet_task_state"
    private const val CLOSED = "closed_by_user"
    private const val OPENED_AT = "opened_at"

    // The activity is in front now: the app runs, whatever an older mark says.
    @Volatile
    var inFront = false

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The app came to the front: the mark goes, and only a process end after this moment can set it again. */
    fun opened(context: Context) {
        inFront = true
        prefs(context).edit().putBoolean(CLOSED, false).putLong(OPENED_AT, System.currentTimeMillis()).apply()
    }

    fun left() {
        inFront = false
    }

    fun markClosed(context: Context) {
        prefs(context).edit().putBoolean(CLOSED, true).commit()
    }

    fun closedByUser(context: Context): Boolean {
        if (inFront) return false
        val p = prefs(context)
        if (p.getBoolean(CLOSED, false)) return true
        if (endedWithRemovedTask(context, p.getLong(OPENED_AT, 0L))) {
            markClosed(context)
            return true
        }
        return false
    }

    // Android 11+: a process of this app that the system ended because its task was removed from the recent apps, after
    // the app was last opened. The system records such an end as requested by the user, described "remove task".
    private fun endedWithRemovedTask(context: Context, since: Long): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || since <= 0L) return false
        return runCatching {
            val am = context.getSystemService(ActivityManager::class.java) ?: return false
            am.getHistoricalProcessExitReasons(context.packageName, 0, 8).any {
                it.timestamp > since && it.reason == ApplicationExitInfo.REASON_USER_REQUESTED &&
                    (it.description ?: "").contains("remove task", ignoreCase = true)
            }
        }.getOrDefault(false)
    }
}

/**
 * Started while the app is in front (MainActivity.onResume): Android tells it when the user removes the app's task, and
 * it keeps the mark before the process ends. The system stops it a while after the app went to the background; on
 * Android 11+ the record of the process's end covers a swipe after that (TaskState).
 */
class TaskWatchService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onTaskRemoved(rootIntent: Intent?) {
        TaskState.markClosed(this)
        stopSelf()
    }
}

/** QNetTaskState for the JS: closedByUser() → Boolean. */
class TaskStateModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "QNetTaskState"

    @ReactMethod
    fun closedByUser(promise: Promise) {
        try {
            promise.resolve(TaskState.closedByUser(reactApplicationContext))
        } catch (t: Throwable) {
            promise.resolve(false)
        }
    }
}
