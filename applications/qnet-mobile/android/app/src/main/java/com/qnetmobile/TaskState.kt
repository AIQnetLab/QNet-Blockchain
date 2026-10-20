package com.qnetmobile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.Resources
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Whether the user swiped QNet Wallet away from the recent apps since it was last opened: a process started afterwards
 * in the background (a push, a scheduled wake) answers nothing until the app is opened. The signs, the system trims
 * the third one takes for a swipe, and what none of them sees: docs/applications/mobile-wallet.md, "Android".
 */
object TaskState {
    private const val PREFS = "qnet_task_state"
    private const val CLOSED = "closed_by_user"
    private const val OPENED_AT = "opened_at"
    private const val LEFT_AT = "left_at"
    private const val LEFT_BOOTS = "left_boots"

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

    /** The app left the front: the system counts its task inactive from this moment (on the boot clock, as it does). */
    fun left(context: Context) {
        inFront = false
        prefs(context).edit()
            .putLong(LEFT_AT, SystemClock.elapsedRealtime()).putInt(LEFT_BOOTS, bootCount(context)).apply()
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
        val swiped = removalOutlived(context) || endedWithRemovedTask(context, p.getLong(OPENED_AT, 0L)) ||
            goneInsideKeepWindow(context, p)
        if (swiped) {
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

    // The task left the recent apps while the system's time limit would keep it there ([removedInsideKeepWindow]).
    private fun goneInsideKeepWindow(context: Context, p: SharedPreferences): Boolean {
        if (!p.contains(LEFT_AT)) return false
        val now = SystemClock.elapsedRealtime()
        val leftAt = p.getLong(LEFT_AT, 0L)
        val sameBoot = sameBoot(p.getInt(LEFT_BOOTS, -1), leftAt, bootCount(context), now)
        return removedInsideKeepWindow(sameBoot, now - leftAt, keepWindow(context)) { taskGone(context) }
    }

    // The platform's own recent-tasks settings (as RecentTasks reads them); a low-memory device keeps tasks by count.
    private fun keepWindow(context: Context): Long {
        if (context.getSystemService(ActivityManager::class.java)?.isLowRamDevice != false) return 0L
        val maxVisible = platformInteger("config_maxNumVisibleRecentTasks") ?: -1
        return recentsKeepMs(maxVisible, platformInteger("config_activeTaskDurationHours") ?: DEFAULT_KEEP_HOURS)
    }

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
        return runCatching {
            val am = context.getSystemService(ActivityManager::class.java) ?: return false
            am.getHistoricalProcessExitReasons(context.packageName, 0, 8).any {
                it.timestamp > since && removedTaskExit(it.reason, it.toString(), it.description)
            }
        }.getOrDefault(false)
    }
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

// config_activeTaskDurationHours in Android's own configuration, for a build that names none.
internal const val DEFAULT_KEEP_HOURS = 6
// The system counts a task inactive from when its activity starts pausing, a moment before onPause notes the time.
internal const val KEEP_WINDOW_MARGIN_MS = 60_000L

/**
 * How long the system's time limit keeps an inactive task in the recent apps (RecentTasks): beyond the most recent few,
 * a task stays only while inactive for at most `activeHours`; where a visible-task maximum is set (`maxVisible` >= 0)
 * the count alone decides, so no time keeps it (0). A list past 48 tasks loses its oldest sooner, whatever the time.
 */
internal fun recentsKeepMs(maxVisible: Int, activeHours: Int): Long =
    if (maxVisible >= 0 || activeHours <= 0) 0L else activeHours * 3_600_000L

/**
 * Whether the app's task missing from the recent apps is taken for the user's removal: it is missing within the keep
 * window since the app left the front, in the same boot (inside it, the system trims a task only from a list past 48
 * tasks). The task list is read last, and only inside the window.
 */
internal fun removedInsideKeepWindow(
    sameBoot: Boolean, sinceLeftMs: Long, keepMs: Long, taskGone: () -> Boolean,
): Boolean = sameBoot && sinceLeftMs >= 0 && sinceLeftMs < keepMs - KEEP_WINDOW_MARGIN_MS && taskGone()

// An integer of the platform's own configuration by its resource name; null where this build names none.
@SuppressLint("DiscouragedApi")
private fun platformInteger(name: String): Int? = runCatching {
    val res = Resources.getSystem()
    res.getIdentifier(name, "integer", "android").takeIf { it != 0 }?.let { res.getInteger(it) }
}.getOrNull()

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

/** QNetTaskState for the JS: closedByUser() → Boolean. */
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
}
