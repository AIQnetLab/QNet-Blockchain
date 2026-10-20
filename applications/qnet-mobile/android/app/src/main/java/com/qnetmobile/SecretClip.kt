package com.qnetmobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock
import android.provider.Settings

/** A secret copy as kept on the device: the clip's timestamp (API 26+), when it was made and is due, and in which boot. */
internal data class SecretCopy(val stamp: Long?, val copiedAt: Long, val dueAt: Long, val boots: Int)

internal enum class ClipAction { NONE, WAIT, FORGET, CLEAR }

/**
 * What a check of the kept copy does now. A copy made in another boot is forgotten: the clipboard does not outlive a
 * restart. One not yet due waits, unless the check is forced (Delete wallet). A later clip (its timestamp readable and
 * different) is the user's own and stays. Anything else is cleared: the copy itself, and a clip that cannot be read,
 * which Android hides from an app in the background. That clear is deliberate: a phrase is never left on the clipboard
 * until the app is next opened, so a clip copied since in another app goes too, as the copy hint says ("the clipboard
 * is cleared in N seconds").
 */
internal fun secretClipAction(copy: SecretCopy?, now: Long, boots: Int, force: Boolean, clipStamp: Long?): ClipAction {
    if (copy == null) return ClipAction.NONE
    if (!sameBoot(copy.boots, copy.copiedAt, boots, now)) return ClipAction.FORGET
    if (!force && now < copy.dueAt) return ClipAction.WAIT
    if (copy.stamp != null && clipStamp != null && clipStamp != copy.stamp) return ClipAction.FORGET
    return ClipAction.CLEAR
}

/** The system's count of device starts (Settings.Global.BOOT_COUNT), -1 where the system keeps none. */
internal fun bootCount(context: Context): Int =
    runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1) }.getOrDefault(-1)

/**
 * Whether boot-clock time `now` (start count `nowBoots`) lies in the boot of `at` (start count `boots`); where either
 * count is unknown, a boot clock below `at` is a new boot.
 */
internal fun sameBoot(boots: Int, at: Long, nowBoots: Int, now: Long): Boolean =
    if (boots >= 0 && nowBoots >= 0) boots == nowBoots else now >= at

/** Empties the clipboard without reading it: no paste notice, and from API 28 no 'Copied' overlay either. */
internal fun ClipboardManager.clearNow() {
    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) clearPrimaryClip()
        else setPrimaryClip(ClipData.newPlainText("", ""))
    } catch (_: Throwable) {
    }
}

/**
 * The recovery phrase or private key the user copied (SecurityModule.copySecret) leaves the clipboard when its time is
 * up, or at once on Delete wallet, if it is still the clip copied. Kept in the app's private storage: the clip's
 * timestamp, the due time and the boot, never the text. So the clear happens after the process ended too (an alarm to
 * SecretClipReceiver, and a check at every resume), and Delete wallet clears a copy an earlier process made.
 */
internal object SecretClip {
    private const val PREFS = "qnet_secret_clip"
    private const val STAMP = "stamp"
    private const val COPIED = "copied"
    private const val DUE = "due"
    private const val BOOTS = "boots"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun clipboard(context: Context) = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context.applicationContext, 0, Intent(context.applicationContext, SecretClipReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun read(p: SharedPreferences): SecretCopy? {
        if (!p.contains(DUE)) return null
        return SecretCopy(
            if (p.contains(STAMP)) p.getLong(STAMP, 0L) else null,
            p.getLong(COPIED, 0L), p.getLong(DUE, 0L), p.getInt(BOOTS, -1),
        )
    }

    // Inexact and non-waking: delivered when the device is next awake, in Doze too. A late clear is still a clear, and it
    // needs no exact-alarm permission.
    private fun schedule(context: Context, dueAt: Long) {
        runCatching {
            context.getSystemService(AlarmManager::class.java)
                ?.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME, dueAt, alarm(context))
        }
    }

    /** The copy is on the clipboard: kept (written at once, so a process that ends next still has it) and scheduled. */
    fun copied(context: Context, stamp: Long?, seconds: Double) {
        val now = SystemClock.elapsedRealtime()
        val due = now + (seconds * 1000).toLong().coerceAtLeast(0L)
        val edit = prefs(context).edit().clear()
            .putLong(COPIED, now).putLong(DUE, due).putInt(BOOTS, bootCount(context))
        if (stamp != null) edit.putLong(STAMP, stamp)
        edit.commit()
        schedule(context, due)
    }

    /** Clears the kept copy when it is due (or now, `force`), by [secretClipAction]. */
    fun check(context: Context, force: Boolean) {
        val copy = read(prefs(context)) ?: return
        val cm = clipboard(context)
        val clipStamp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { cm?.primaryClipDescription?.timestamp }.getOrNull()
        } else null
        when (secretClipAction(copy, SystemClock.elapsedRealtime(), bootCount(context), force, clipStamp)) {
            ClipAction.NONE -> {}
            ClipAction.WAIT -> schedule(context, copy.dueAt)
            ClipAction.FORGET -> forget(context)
            ClipAction.CLEAR -> {
                cm?.clearNow()
                forget(context)
            }
        }
    }

    private fun forget(context: Context) {
        prefs(context).edit().clear().commit()
        runCatching { context.getSystemService(AlarmManager::class.java)?.cancel(alarm(context)) }
    }
}

/** The alarm SecretClip set: the process may have ended since the copy, and this one starts only to clear it. */
class SecretClipReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        SecretClip.check(context, force = false)
    }
}
