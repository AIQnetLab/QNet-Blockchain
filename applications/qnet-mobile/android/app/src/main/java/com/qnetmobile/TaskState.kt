package com.qnetmobile

import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Whether the user swiped QNet Wallet away from the recent apps since it was last opened: a process started afterwards
 * in the background (a push, a scheduled wake) answers nothing until the app is opened. The two sure signs, and what
 * neither sees: docs/applications/mobile-wallet.md, "Android".
 */
object TaskState {
    private const val PREFS = "qnet_task_state"
    private const val CLOSED = "closed_by_user"
    private const val OPENED_AT = "opened_at"

    // The activity is in front now: the app runs, whatever an older mark says.
    @Volatile
    var inFront = false

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun marks(context: Context) =
        RemovalMarks(context.applicationContext.noBackupFilesDir, Process.myPid()) { ms, takeBack ->
            Handler(Looper.getMainLooper()).postDelayed(takeBack, ms)
        }

    /** The app came to the front: every sign goes, and only a removal after this moment can set one again. */
    fun opened(context: Context) {
        inFront = true
        prefs(context).edit().putBoolean(CLOSED, false).putLong(OPENED_AT, System.currentTimeMillis()).apply()
        marks(context).clear()
    }

    /** The app left the front (MainActivity.onPause). */
    fun left() {
        inFront = false
    }

    /** Starts the task watch; refused (and nothing else happens) while the system lets no background service start. */
    fun watch(context: Context) {
        runCatching { context.startService(Intent(context, TaskWatchService::class.java)) }
    }

    private fun markClosed(context: Context) {
        prefs(context).edit().putBoolean(CLOSED, true).commit()
    }

    fun closedByUser(context: Context): Boolean {
        if (inFront) return false
        val p = prefs(context)
        if (p.getBoolean(CLOSED, false)) return true
        if (swipedAway({ removalOutlived(context) }, { endedWithRemovedTask(context, p.getLong(OPENED_AT, 0L)) })) {
            markClosed(context)
            return true
        }
        return false
    }

    /** TaskWatchService.onTaskRemoved: the task left the recent apps, swiped or trimmed; a swipe if this process ends. */
    fun removed(context: Context) {
        marks(context).mark()
    }

    /**
     * Android 7 to 10, which keep no exit record: a finishing activity is being destroyed (MainActivity.onDestroy). The
     * mark is made before anything else, since a removed task's process can end within milliseconds; an activity whose
     * task is still in the recent apps (Back) takes it back at once.
     */
    fun finished(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return
        val context = activity.applicationContext
        val mark = marks(context).mark()
        if (!taskGone(context)) mark.delete()
    }

    // The app has no task in the recent apps: swiped, or trimmed by the system.
    private fun taskGone(context: Context): Boolean = runCatching {
        context.getSystemService(ActivityManager::class.java)?.appTasks?.isEmpty() == true
    }.getOrDefault(false)

    private fun removalOutlived(context: Context): Boolean {
        val marks = marks(context)
        if (!marks.leftByEndedProcess()) return false
        marks.clear()
        return true
    }

    // Android 11+: a process of this app that the system ended because its task was removed from the recent apps, after
    // the app was last opened.
    private fun endedWithRemovedTask(context: Context, since: Long): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || since <= 0L) return false
        return exitRecords(context, 8).any {
            it.timestamp > since && removedTaskExit(it.reason, it.toString(), it.description)
        }
    }

    /**
     * Android 11+: why the newest process of this app that ended after `sinceMs` ended ([exitReasonName]) and when; null
     * where the system keeps no record, or none is newer. The node's logs show it with the next answer.
     */
    fun lastExit(context: Context, sinceMs: Long): Pair<String, Long>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val newest = exitRecords(context, 1).firstOrNull()?.takeIf { it.timestamp > sinceMs } ?: return null
        return exitReasonName(newest.reason, newest.toString(), newest.description) to newest.timestamp
    }

    // This app's newest process-exit records, newest first (Android 11+); none where the system cannot answer.
    private fun exitRecords(context: Context, max: Int): List<ApplicationExitInfo> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        return runCatching {
            context.getSystemService(ActivityManager::class.java)?.getHistoricalProcessExitReasons(context.packageName, 0, max)
        }.getOrNull() ?: emptyList()
    }
}

/**
 * A process-exit record's reason in the words the node logs: crash, anr, low_memory, system_killed, user_closed, swiped
 * (the user removed the task from the recent apps, [removedTaskExit]), other or unknown. A reason a later Android adds is
 * other.
 */
internal fun exitReasonName(reason: Int, record: String, description: String?): String = when (reason) {
    ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE,
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "crash"
    ApplicationExitInfo.REASON_ANR -> "anr"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
    ApplicationExitInfo.REASON_SIGNALED, ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
    ApplicationExitInfo.REASON_FREEZER, ApplicationExitInfo.REASON_PERMISSION_CHANGE,
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "system_killed"
    ApplicationExitInfo.REASON_USER_REQUESTED -> if (removedTaskExit(reason, record, description)) "swiped" else "user_closed"
    ApplicationExitInfo.REASON_USER_STOPPED -> "user_closed"
    ApplicationExitInfo.REASON_UNKNOWN -> "unknown"
    else -> "other"
}

// ApplicationExitInfo.SUBREASON_REMOVE_TASK (Android 13+): hidden in the SDK, written by the record's toString.
internal const val EXIT_SUBREASON_REMOVE_TASK = 22
private val EXIT_SUBREASON = Regex("""\bsubreason=(\d+)""")

/**
 * Whether a process-exit record is the end of a task the user removed from the recent apps: requested by the user, and
 * either the record's sub-reason says so, or, where it gives none (Android 11-12, and builds that changed it), the
 * description the platform writes, "remove task", matched without case, spaces or punctuation.
 */
internal fun removedTaskExit(reason: Int, record: String, description: String?): Boolean {
    if (reason != ApplicationExitInfo.REASON_USER_REQUESTED) return false
    if (EXIT_SUBREASON.find(record)?.groupValues?.get(1)?.toIntOrNull() == EXIT_SUBREASON_REMOVE_TASK) return true
    return (description ?: "").lowercase().filter { it.isLetter() }.contains("removetask")
}

// A removal mark: a file named by the process that saw its task leave the recent apps.
internal const val REMOVAL_MARK = "task_removed_"
// A swiped task's process ends within milliseconds of the removal; a trimmed task's process lives on.
internal const val REMOVAL_SETTLE_MS = 1_000L

/** Whether a removal mark among `names` belongs to a process other than `pid`: the app runs one process at a time. */
internal fun removalByEndedProcess(names: List<String>, pid: Int): Boolean = names.any { name ->
    name.startsWith(REMOVAL_MARK) && name.removePrefix(REMOVAL_MARK).toIntOrNull().let { it != null && it != pid }
}

/**
 * The removal marks in `dir` (the app's no-backup files) as process `pid` sees them. A mark is taken back by `later`
 * once the process outlives REMOVAL_SETTLE_MS, so only a process that ended right after the removal leaves one.
 */
internal class RemovalMarks(private val dir: File, private val pid: Int, private val later: (Long, () -> Unit) -> Unit) {
    fun mark(): File {
        val mark = File(dir, REMOVAL_MARK + pid)
        runCatching { mark.createNewFile() }
        later(REMOVAL_SETTLE_MS) { mark.delete() }
        return mark
    }

    fun leftByEndedProcess(): Boolean = removalByEndedProcess(files().map { it.name }, pid)

    fun clear() = files().forEach { it.delete() }

    private fun files(): List<File> = dir.listFiles()?.filter { it.name.startsWith(REMOVAL_MARK) } ?: emptyList()
}

/**
 * Whether an ask's signs say the user swiped the app away: a removal mark left by a process that ended right after its
 * task left the recent apps, or Android's record of a process ended for the removed task, the second read only while the
 * first says nothing. A task missing from the recent apps is no sign: the system trims the list by itself too, and a
 * swipe that cannot be told for sure is answered.
 */
internal fun swipedAway(removalMark: () -> Boolean, removedTaskRecord: () -> Boolean): Boolean =
    removalMark() || removedTaskRecord()

// The minute Android 8+ lets a service run on after the app left the front (its background settle time).
internal const val BACKGROUND_WATCH_MS = 60_000L

/** Android 7 sets no background limit: a watch only background answers started stops itself after that minute. */
internal fun watchStopsItself(sdk: Int, startedInFront: Boolean): Boolean =
    sdk < Build.VERSION_CODES.O && !startedInFront

/**
 * Started wherever the system lets the app start it (TaskState.watch): Android tells it when the app's task leaves the
 * recent apps, and keeps the process until onTaskRemoved returns, so the mark is made before a swipe ends the process.
 */
class TaskWatchService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val stop = Runnable { stopSelf() }
    private var startedInFront = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startedInFront = startedInFront || TaskState.inFront
        main.removeCallbacks(stop)
        if (watchStopsItself(Build.VERSION.SDK_INT, startedInFront)) main.postDelayed(stop, BACKGROUND_WATCH_MS)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        TaskState.removed(this)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(stop)
        super.onDestroy()
    }
}

/** QNetTaskState for the JS: closedByUser() → Boolean; lastExit(sinceMs) → { reason, at, api } or null. */
class TaskStateModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "QNetTaskState"

    // Every answer path asks here, a push in the background too: while the node may answer, the watch starts again.
    @ReactMethod
    fun closedByUser(promise: Promise) {
        try {
            val closed = TaskState.closedByUser(reactApplicationContext)
            if (!closed) TaskState.watch(reactApplicationContext)
            promise.resolve(closed)
        } catch (t: Throwable) {
            promise.resolve(false)
        }
    }

    // TaskState.lastExit with the API level it was read on; null where there is none.
    @ReactMethod
    fun lastExit(sinceMs: Double, promise: Promise) {
        try {
            val exit = TaskState.lastExit(reactApplicationContext, sinceMs.toLong())
            promise.resolve(exit?.let { (reason, at) ->
                Arguments.createMap().apply {
                    putString("reason", reason)
                    putDouble("at", at.toDouble())
                    putInt("api", Build.VERSION.SDK_INT)
                }
            })
        } catch (t: Throwable) {
            promise.resolve(null)
        }
    }
}
