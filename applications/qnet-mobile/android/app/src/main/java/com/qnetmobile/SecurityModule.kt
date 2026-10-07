package com.qnetmobile

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Base64
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.Toast
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * QNetSecurity: what the wallet needs from the platform to keep its secrets on the device.
 *
 * - Secret screens: FLAG_SECURE, overlay windows hidden (API 31+), non-assistive accessibility services
 *   locked out (API 34+), obscured touches dropped, keyboard personalised learning off in focused fields.
 * - Password and recovery-phrase fields, on every screen and API level: no text, text events or text actions for
 *   accessibility services (MPLAT-R4-01).
 * - Keystore keys for the vault: a device seal (non-exportable, no user authentication, StrongBox when present), a
 *   biometric key (per-use authentication through a CryptoObject-bound BiometricPrompt, strong biometrics only,
 *   invalidated by a new enrolment), and from Android 11 the screen-lock key: an RSA pair whose private half needs a
 *   strong biometric or the device credential for every use, which holds the vault secret of a wallet that opens with
 *   the screen lock (JS: DeviceAuthStore). The seal is not bound to an unlocked device (MVA-R4-01): on Android 12-14
 *   keystore2 super-encrypts such keys with the screen-lock key and deletes them for good when the screen lock is
 *   removed, which would leave the vault unopenable with the right password. The older seal (v1) is still opened, so
 *   a vault it sealed moves to the new one; it is never made again.
 * - Guarded screens drop every touch another app's window obscures, in part too (MPLAT-R5-02).
 * - The recovery phrase's Copy: a clip marked sensitive, cleared after a set time by a native timer if it is still there.
 * - The boot clock for the password lockout, and a local integrity check. Nothing here uses the network.
 * - The names the device's model is built from for a node's binding (JS: DeviceModel).
 * - Deleting or replacing the wallet: the in-app browser's cookies, site storage and HTTP cache (clearWebData).
 */
class SecurityModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    companion object {
        const val NAME = "QNetSecurity"
        private const val KEYSTORE = "AndroidKeyStore"
        // The first device seal, made with setUnlockedDeviceRequired where the device allowed it: opened (and, while
        // the current seal cannot be made, used) for vaults it sealed, never made again, deleted once no vault uses it.
        private const val LEGACY_SEAL_ALIAS = "qnet_vault_seal_v1"
        private const val SEAL_ALIAS = "qnet_vault_seal_v2"
        private const val BIO_ALIAS = "qnet_vault_bio_v1"
        private const val DEV_AUTH_ALIAS = "qnet_vault_devauth_v1"
        // A small key of the app's own that guards nothing: its presence in a listing proves the listing was answered
        // (KeyPresence.aliasListing), so an alias that listing leaves out is known to be absent (MA-R2-01).
        private const val PROBE_ALIAS = "qnet_keystore_probe_v1"
        private const val KEY_READS = 3
        private const val KEY_READ_PAUSE_MS = 150L
        // A screen-lock blob: its version byte, the length of the key id that names the RSA key, one RSA-2048 block.
        private const val DEV_AUTH_BLOB_V2: Byte = 2
        private const val DEV_AUTH_KEY_ID_BYTES = 8
        private const val DEV_AUTH_RSA_BYTES = 256
        private const val GCM = "AES/GCM/NoPadding"
        private const val RSA_OAEP = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"
        // The Keystore's OAEP uses MGF1 with SHA-1; the software side must name the same.
        private val OAEP_SPEC = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        // The recovery-phrase field's nativeID (JS: sensitiveInput.SEED_FIELD_ID).
        private const val SEED_NATIVE_ID = "qnet-seed-input"
        // ClipDescription.EXTRA_IS_SENSITIVE (API 33), which earlier versions' clipboard previews read under this name.
        private const val CLIP_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
        private const val OBSCURED_NOTICE_MS = 3000L

        /** Whether a secret screen holds FLAG_SECURE (MainActivity keeps it on its way to the background). */
        @Volatile @JvmStatic var secretScreenOn = false
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var secureOn = false
    @Volatile private var protectOn = false
    @Volatile private var guardOn = false
    @Volatile private var obscuredText = "Another app is drawing over the wallet. The tap was ignored."
    private var lastObscuredNotice = 0L

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = NAME

    // ── Secret screens ───────────────────────────────────────────────────────────────────────────

    private val focusListener = ViewTreeObserver.OnGlobalFocusChangeListener { _, focused -> noLearning(focused) }

    /** Keyboards must not learn what is typed into a secret field (the flag exists from API 26). */
    private fun noLearning(view: View?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val field = view as? EditText ?: return
        val flag = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        if (field.imeOptions and flag != 0) return
        field.imeOptions = field.imeOptions or flag
        (field.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(field)
    }

    // `secure`: a screen that shows or takes a secret (FLAG_SECURE too). `guard`: any screen whose taps move
    // value or approve a request — the send form, a site's or aiqnet.io's confirmation (MPLAT-R2-01). Both keep
    // overlays out, drop touches that arrive through an obscuring window, and (API 34+) hide the views from an
    // accessibility service that is not an assistive tool, which also drops the actions and gestures it injects.
    private fun applySecure(activity: Activity, secure: Boolean, guard: Boolean) {
        val window = activity.window ?: return
        if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) window.setHideOverlayWindows(guard)
        val decor = window.decorView
        decor.filterTouchesWhenObscured = guard
        guardOn = guard
        if (guard) watchObscuredTouches(activity)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            decor.setAccessibilityDataSensitive(
                if (guard) View.ACCESSIBILITY_DATA_SENSITIVE_YES else View.ACCESSIBILITY_DATA_SENSITIVE_AUTO
            )
        }
        val observer = decor.viewTreeObserver
        if (observer.isAlive) {
            observer.removeOnGlobalFocusChangeListener(focusListener)
            if (guard) {
                observer.addOnGlobalFocusChangeListener(focusListener)
                noLearning(decor.findFocus())
            }
        }
    }

    private fun reapply() {
        val activity = reactContext.currentActivity ?: return
        val secure = secureOn
        val guard = secureOn || protectOn
        activity.runOnUiThread { runCatching { applySecure(activity, secure, guard) } }
    }

    @ReactMethod
    fun setSecureScreen(on: Boolean) {
        secureOn = on
        secretScreenOn = on
        reapply()
    }

    /** The guard of a secret screen without FLAG_SECURE: for screens that move value (MPLAT-R2-01). */
    @ReactMethod
    fun setProtectInteraction(on: Boolean) {
        protectOn = on
        reapply()
    }

    override fun onHostResume() {
        reapply()
        reactContext.currentActivity?.let { activity -> activity.runOnUiThread { runCatching { watchSecretFields(activity) } } }
    }

    /** Texts the native side shows by itself, in the app's language (JS: DeviceSecurity.setNativeTexts). */
    @ReactMethod
    fun setTexts(texts: ReadableMap) {
        if (texts.hasKey("obscuredTouch")) texts.getString("obscuredTouch")?.takeIf { it.isNotBlank() }?.let { obscuredText = it }
    }

    // ── Touches through another app's window (MPLAT-R5-02) ───────────────────────────────────────
    // filterTouchesWhenObscured drops a touch only when another app's window covers the touch point itself. An overlay
    // that covers the recipient or the amount while leaving the button free gives the button's touch only
    // FLAG_WINDOW_IS_PARTIALLY_OBSCURED (API 29+), and below API 31 nothing hides such an overlay. While the guard is on,
    // every gesture that starts or continues with either flag is dropped (one already under way is cancelled, so no
    // press it began completes), and a short notice says why.

    private fun watchObscuredTouches(activity: Activity) {
        val window = activity.window ?: return
        val current = window.callback ?: return
        if (current is ObscuredTouchFilter) return
        window.callback = ObscuredTouchFilter(current)
    }

    private fun obscured(event: MotionEvent): Boolean {
        val flags = event.flags
        if (flags and MotionEvent.FLAG_WINDOW_IS_OBSCURED != 0) return true
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && flags and MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED != 0
    }

    private fun noticeObscured(activity: Activity) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastObscuredNotice < OBSCURED_NOTICE_MS) return
        lastObscuredNotice = now
        runCatching { Toast.makeText(activity, obscuredText, Toast.LENGTH_LONG).show() }
    }

    private inner class ObscuredTouchFilter(private val inner: Window.Callback) : Window.Callback by inner {
        private var dropping = false
        private var delivered = false

        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            val action = event.actionMasked
            val ends = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL
            if (action == MotionEvent.ACTION_DOWN) {
                dropping = false
                delivered = false
            }
            if (!dropping && guardOn && obscured(event)) {
                dropping = true
                if (delivered) {
                    val cancel = MotionEvent.obtain(event)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    try { inner.dispatchTouchEvent(cancel) } finally { cancel.recycle() }
                }
                reactContext.currentActivity?.let { noticeObscured(it) }
            }
            if (dropping) {
                if (ends) dropping = false
                delivered = false
                return true
            }
            delivered = !ends
            return inner.dispatchTouchEvent(event)
        }
    }

    // ── Password fields and accessibility services (MPLAT-R4-01) ─────────────────────────────────
    // A password EditText gives accessibility its transformed text (the node's text, text-changed and selection
    // events): with the system's "Show passwords" on, each character typed shows there in clear for about 1.5 s, so a
    // service rebuilds the password keystroke by keystroke. ACCESSIBILITY_DATA_SENSITIVE (API 34+) hides a screen only
    // from services that do not declare themselves assistive tools. So every password field of the app, and the
    // recovery-phrase field, gets a delegate for as long as it exists, on every screen and API level: its node carries
    // no text, its text events are dropped, and no service can set, paste, copy or cut its text. The system keyboard
    // and the app's own code still type into it as before.

    private val watchedDecors: MutableSet<View> = java.util.Collections.newSetFromMap(java.util.WeakHashMap())

    // Installed once per window: every layout pass wraps a secret field that has no guard yet (a new screen, a field
    // React Native recreated, or one whose delegate React Native set again).
    private fun watchSecretFields(activity: Activity) {
        val decor = activity.window?.decorView ?: return
        if (watchedDecors.add(decor)) {
            decor.viewTreeObserver.addOnGlobalLayoutListener { guardSecretFields(decor) }
        }
        guardSecretFields(decor)
    }

    private fun isSecretField(view: View): Boolean {
        val field = view as? EditText ?: return false
        if (view.getTag(com.facebook.react.R.id.view_tag_native_id) == SEED_NATIVE_ID) return true
        val type = field.inputType
        val variation = type and InputType.TYPE_MASK_VARIATION
        return when (type and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    // The delegate React Native gave the field (its role and click handling), kept inside the guard. Public from API 29;
    // below it the field AndroidX's ViewCompat reads the same way. Unreadable: the guard stands alone.
    private val delegateField by lazy {
        runCatching { View::class.java.getDeclaredField("mAccessibilityDelegate").apply { isAccessible = true } }.getOrNull()
    }

    private fun currentDelegate(view: View): View.AccessibilityDelegate? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) view.accessibilityDelegate
        else runCatching { delegateField?.get(view) as? View.AccessibilityDelegate }.getOrNull()

    private fun guardSecretFields(view: View?) {
        if (view == null) return
        if (isSecretField(view)) {
            val current = currentDelegate(view)
            if (current !is SecretFieldGuard) view.accessibilityDelegate = SecretFieldGuard(current)
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) guardSecretFields(view.getChildAt(i))
        }
    }

    private class SecretFieldGuard(inner: View.AccessibilityDelegate?) : View.AccessibilityDelegate() {
        private val base: View.AccessibilityDelegate = inner ?: View.AccessibilityDelegate()

        companion object {
            private val DROPPED_EVENTS = setOf(
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
                AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
                AccessibilityEvent.TYPE_VIEW_TEXT_TRAVERSED_AT_MOVEMENT_GRANULARITY,
            )
            private val REFUSED_ACTIONS = setOf(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                AccessibilityNodeInfo.ACTION_PASTE,
                AccessibilityNodeInfo.ACTION_COPY,
                AccessibilityNodeInfo.ACTION_CUT,
            )
            private val REFUSED_ACTION_OBJECTS = listOf(
                AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT,
                AccessibilityNodeInfo.AccessibilityAction.ACTION_PASTE,
                AccessibilityNodeInfo.AccessibilityAction.ACTION_COPY,
                AccessibilityNodeInfo.AccessibilityAction.ACTION_CUT,
            )
        }

        private fun scrub(event: AccessibilityEvent) {
            event.text.clear()
            event.beforeText = null
        }

        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
            base.onInitializeAccessibilityNodeInfo(host, info)
            info.text = null
            info.isPassword = true
            for (action in REFUSED_ACTION_OBJECTS) info.removeAction(action)
        }

        override fun addExtraDataToAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo, extraDataKey: String, arguments: Bundle?) {
            // No character positions of the field's text either.
        }

        override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProvider? = null

        override fun dispatchPopulateAccessibilityEvent(host: View, event: AccessibilityEvent): Boolean = false

        override fun onPopulateAccessibilityEvent(host: View, event: AccessibilityEvent) {}

        override fun onInitializeAccessibilityEvent(host: View, event: AccessibilityEvent) {
            base.onInitializeAccessibilityEvent(host, event)
            scrub(event)
        }

        override fun sendAccessibilityEvent(host: View, eventType: Int) {
            if (eventType in DROPPED_EVENTS) return
            base.sendAccessibilityEvent(host, eventType)
        }

        override fun sendAccessibilityEventUnchecked(host: View, event: AccessibilityEvent) {
            if (event.eventType in DROPPED_EVENTS) return
            scrub(event)
            base.sendAccessibilityEventUnchecked(host, event)
        }

        override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
            if (action in REFUSED_ACTIONS) return false
            return base.performAccessibilityAction(host, action, args)
        }
    }

    override fun onHostPause() {}

    override fun onHostDestroy() {}

    private fun clipboard(): ClipboardManager? =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    // ── The recovery-phrase field (MPLAT-R3-01) ──────────────────────────────────────────────────
    // The field whose nativeID is SEED_NATIVE_ID offers Paste and selection only: its floating menus lose Copy, Cut,
    // Share, Translate and every PROCESS_TEXT action, text-assist and Autofill. A Paste from that menu takes the phrase
    // off the clipboard as soon as it lands. Text of the field that reaches the clipboard by a path no menu covers (a
    // keyboard's own copy key, Ctrl+C, an accessibility action) is cleared at once, while the app still has focus.

    private var seedGuardOn = false
    private var seedField: WeakReference<EditText>? = null

    private val seedMenu = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean { keepPasteOnly(menu); return true }
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean { keepPasteOnly(menu); return true }
        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.itemId == android.R.id.paste || item.itemId == android.R.id.pasteAsPlainText) {
                main.post { clearClipboardNow() } // after the paste this click starts has landed
            }
            return false
        }
        override fun onDestroyActionMode(mode: ActionMode) {}
    }

    private fun keepPasteOnly(menu: Menu) {
        for (i in 0 until menu.size()) {
            val item = menu.getItem(i)
            item.isVisible = item.itemId == android.R.id.paste || item.itemId == android.R.id.selectAll
        }
    }

    private val seedClipListener = ClipboardManager.OnPrimaryClipChangedListener { main.post { clearSeedCopy() } }

    private fun clearClipboardNow() {
        val cm = clipboard() ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip()
            else cm.setPrimaryClip(ClipData.newPlainText("", ""))
        } catch (_: Throwable) {
        }
    }

    private fun words(s: String): List<String> = s.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }

    // A clip whose text runs inside the field's (a word, part of one, or several) came from the field: cleared.
    private fun clearSeedCopy() {
        val field = seedField?.get() ?: return
        val cm = clipboard() ?: return
        try {
            val clip = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(reactContext)?.toString() ?: return
            val copied = words(clip).joinToString(" ")
            val held = words(field.text?.toString() ?: "").joinToString(" ")
            if (copied.isEmpty() || held.isEmpty() || !held.contains(copied)) return
            clearClipboardNow()
        } catch (_: Throwable) {
        }
    }

    private fun findByNativeId(view: View?, id: String): View? {
        if (view == null) return null
        if (view.getTag(com.facebook.react.R.id.view_tag_native_id) == id) return view
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) findByNativeId(view.getChildAt(i), id)?.let { return it }
        }
        return null
    }

    @ReactMethod
    fun setSeedFieldGuard(on: Boolean) {
        main.post {
            val cm = clipboard()
            if (on) {
                val field = findByNativeId(reactContext.currentActivity?.window?.decorView, SEED_NATIVE_ID) as? EditText
                if (field != null) {
                    field.customSelectionActionModeCallback = seedMenu
                    field.customInsertionActionModeCallback = seedMenu
                    seedField = WeakReference(field)
                }
                if (!seedGuardOn && cm != null) {
                    cm.addPrimaryClipChangedListener(seedClipListener)
                    seedGuardOn = true
                }
            } else {
                if (seedGuardOn) cm?.removePrimaryClipChangedListener(seedClipListener)
                seedGuardOn = false
                seedField = null
            }
        }
    }

    // ── The recovery phrase's Copy ───────────────────────────────────────────────────────────────
    // An explicit tap puts the phrase on the clipboard, marked sensitive so the system's clipboard preview hides it.
    // After `seconds` it is cleared if it is still the clip copied. The timer is native, so it also runs while the app
    // is in the background, where Android lets an app write the clipboard but not read it: a clipboard it cannot read
    // then is cleared all the same. Delete wallet clears it at once (clearSecretCopy).

    private var secretCopyText: String? = null
    private var secretCopyStamp: Long? = null // the clip's timestamp as the clipboard gave it back (API 26+)
    private val secretCopyExpiry = Runnable { clearSecretCopyNow() }

    @ReactMethod
    fun copySecret(text: String, seconds: Double, promise: Promise) {
        main.post {
            val cm = clipboard()
            if (cm == null) {
                promise.resolve(false)
                return@post
            }
            try {
                val clip = ClipData.newPlainText("", text)
                clip.description.extras = PersistableBundle().apply { putBoolean(CLIP_IS_SENSITIVE, true) }
                cm.setPrimaryClip(clip)
                secretCopyText = text
                secretCopyStamp =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) cm.primaryClipDescription?.timestamp else null
                main.removeCallbacks(secretCopyExpiry)
                main.postDelayed(secretCopyExpiry, (seconds * 1000).toLong().coerceAtLeast(0L))
                promise.resolve(true)
            } catch (_: Throwable) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun clearSecretCopy(promise: Promise) {
        main.post {
            clearSecretCopyNow()
            promise.resolve(null)
        }
    }

    private fun clearSecretCopyNow() {
        main.removeCallbacks(secretCopyExpiry)
        val text = secretCopyText ?: return
        val stamp = secretCopyStamp
        secretCopyText = null
        secretCopyStamp = null
        val cm = clipboard() ?: return
        try {
            // A description or clip that cannot be read (the app is in the background) counts as still the phrase.
            val still = if (stamp != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val description = cm.primaryClipDescription
                description == null || description.timestamp == stamp
            } else {
                val clip = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(reactContext)?.toString()
                clip == null || clip == text
            }
            if (still) clearClipboardNow()
        } catch (_: Throwable) {
            clearClipboardNow()
        }
    }

    // ── Boot clock ───────────────────────────────────────────────────────────────────────────────

    @ReactMethod
    fun bootClock(promise: Promise) {
        val map = Arguments.createMap()
        map.putDouble("mono", SystemClock.elapsedRealtime().toDouble())
        map.putDouble("wall", System.currentTimeMillis().toDouble())
        // The system's count of device starts names this boot exactly, where wall minus mono moves with every time
        // correction (JS: AnswerGate.sameBoot); -1 where the system keeps none.
        val boots = runCatching { Settings.Global.getInt(reactContext.contentResolver, Settings.Global.BOOT_COUNT, -1) }
        map.putDouble("boots", boots.getOrDefault(-1).toDouble())
        promise.resolve(map)
    }

    // ── Device model (JS: DeviceModel.androidModel) ──────────────────────────────────────────────

    /**
     * What the JS builds the device's model from, read with no permission: the maker and the model the system reports.
     * Never the device name of the system settings (the user may have named the phone after themselves), a serial,
     * IMEI or other identifier.
     */
    @ReactMethod
    fun deviceModel(promise: Promise) {
        val map = Arguments.createMap()
        map.putString("manufacturer", Build.MANUFACTURER ?: "")
        map.putString("model", Build.MODEL ?: "")
        promise.resolve(map)
    }

    // ── Device integrity (local checks only) ─────────────────────────────────────────────────────

    @ReactMethod
    fun deviceIntegrity(promise: Promise) {
        val reasons = Arguments.createArray()
        try {
            val suPaths = listOf(
                "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/system/bin/.ext/.su",
                "/system/usr/we-need-root/su", "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su",
                "/su/bin/su", "/system/app/Superuser.apk", "/data/adb/magisk", "/sbin/.magisk",
            )
            if (suPaths.any { File(it).exists() }) reasons.pushString("root")
            if (Build.TAGS?.contains("test-keys") == true) reasons.pushString("test-keys")
            val maps = runCatching { File("/proc/self/maps").readText() }.getOrDefault("")
            if (maps.contains("frida", ignoreCase = true) || maps.contains("gadget", ignoreCase = true)) {
                reasons.pushString("hook")
            }
            val xposed = runCatching { Class.forName("de.robv.android.xposed.XposedBridge"); true }.getOrDefault(false)
            if (xposed) reasons.pushString("xposed")
        } catch (_: Throwable) {
        }
        val map = Arguments.createMap()
        map.putBoolean("compromised", reasons.size() > 0)
        map.putArray("reasons", reasons)
        promise.resolve(map)
    }

    /**
     * Enabled accessibility services that did not come with the system: they can read what a screen shows
     * (overlay malware asks for exactly this). Each is named by its label, which the service chooses itself, with its
     * package next to it (MPLAT-R5-01), for the warnings at unlock, before a recovery phrase and on every confirmation.
     */
    @ReactMethod
    fun screenReaders(promise: Promise) {
        val out = Arguments.createArray()
        try {
            val am = reactContext.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
            val pm = reactContext.packageManager
            am?.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)?.forEach { info ->
                val service = info.resolveInfo?.serviceInfo ?: return@forEach
                val flags = service.applicationInfo?.flags ?: 0
                if (flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0) return@forEach
                val label = runCatching { info.resolveInfo.loadLabel(pm).toString().trim() }.getOrNull()
                out.pushString(if (label.isNullOrBlank() || label == service.packageName) service.packageName else "$label (${service.packageName})")
            }
        } catch (_: Throwable) {
        }
        promise.resolve(out)
    }

    // ── Keystore keys ────────────────────────────────────────────────────────────────────────────

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** The alias holds an entry that is not the kind of key asked for: nothing to open with, and nothing to replace. */
    private class NotAKeyException : Exception("The key alias holds no key of that kind")

    /** The Keystore did not answer for an alias it may hold: never read as a key that is gone (MA-R2-01). */
    private class KeystoreUnansweredException : Exception("The Keystore did not answer")

    /**
     * The entry under `alias`, read on a fresh Keystore instance each try. A null read is a key that is gone only when an
     * answered listing leaves the alias out (KeyPresence.readKeystoreEntry): containsAlias, getCertificate and, below
     * Android 12, getKey answer null for a Keystore that failed as well. KeyGoneException when it is absent,
     * KeystoreUnansweredException when the Keystore could not say; a read that throws passes its own error on.
     */
    private fun <T : Any> entry(alias: String, read: (KeyStore) -> T?): T {
        val found = readKeystoreEntry(
            KEY_READS,
            { attempt -> SystemClock.sleep(KEY_READ_PAUSE_MS * attempt) },
            { read(keyStore()) },
            { aliasListing(alias, PROBE_ALIAS, { keyStore().aliases().toList() }, ::ensureProbeKey) },
        )
        return when (found) {
            is KeyRead.Found -> found.value
            KeyRead.Absent -> throw KeyGoneException()
            KeyRead.Unanswered -> throw KeystoreUnansweredException()
        }
    }

    private fun secretKey(alias: String): SecretKey =
        entry(alias) { it.getKey(alias, null) } as? SecretKey ?: throw NotAKeyException()

    private fun privateKey(alias: String): PrivateKey =
        entry(alias) { it.getKey(alias, null) } as? PrivateKey ?: throw NotAKeyException()

    /** The probe key exists (made here when a read finds none): true once it does. It guards nothing. */
    private fun ensureProbeKey(): Boolean {
        if (keyStore().getKey(PROBE_ALIAS, null) != null) return true
        val spec = KeyGenParameterSpec.Builder(PROBE_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(128)
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
        return true
    }

    private fun deleteKey(alias: String) {
        runCatching { keyStore().deleteEntry(alias) }
    }

    /**
     * A new AES-256-GCM key: StrongBox when the device has one, otherwise the TEE. Non-exportable either way. The seal
     * key carries no user-authentication and no unlocked-device requirement: keystore2 keeps such a key when the screen
     * lock is removed, while it deletes every key bound to the screen lock (MVA-R4-01). The biometric key needs a strong
     * biometric for every use. Called only for an alias known to be empty (an answered listing left it out, or the
     * caller deleted what was there), so a failed attempt deletes what it may have left under it (MA-R2-01).
     */
    private fun generateKey(alias: String, biometric: Boolean): SecretKey {
        val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        val attempts = listOf(true, false).filter { strongBox || !it }
        var last: Throwable? = null
        for (useStrongBox in attempts) {
            try {
                val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                if (biometric) {
                    spec.setUserAuthenticationRequired(true)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    } else {
                        @Suppress("DEPRECATION")
                        spec.setUserAuthenticationValidityDurationSeconds(-1)
                    }
                    spec.setInvalidatedByBiometricEnrollment(true)
                }
                if (useStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
                val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
                generator.init(spec.build())
                return generator.generateKey()
            } catch (t: Throwable) {
                last = t
                deleteKey(alias)
            }
        }
        throw last ?: IllegalStateException("No Keystore key could be made")
    }

    private fun seal(key: SecretKey, data: ByteArray, cipher: Cipher? = null): ByteArray {
        val c = cipher ?: Cipher.getInstance(GCM).apply { init(Cipher.ENCRYPT_MODE, key) }
        val ct = c.doFinal(data)
        return c.iv + ct
    }

    private fun decryptCipher(key: SecretKey, blob: ByteArray): Cipher {
        if (blob.size <= IV_BYTES + TAG_BITS / 8) throw SealedDataException()
        return Cipher.getInstance(GCM).apply {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob.copyOfRange(0, IV_BYTES)))
        }
    }

    /** The seal key does not exist (never made, or deleted by the system). */
    private class KeyGoneException : Exception("The device key is gone")

    /** A sealed blob too short to hold an IV, data and a tag: damage, whatever the key. */
    private class SealedDataException : Exception("Sealed data too short")

    /**
     * What a Keystore failure means for the vault (MVA-R3-02). Permanent: the key is gone (KEY_MISSING), invalidated
     * (KEY_INVALIDATED), corrupted (KEY_CORRUPTED), or not the key that sealed this blob (KEY_MISMATCH: the GCM tag
     * fails, as after the system dropped the key and a new one was made); a blob too short to be one is
     * SEALED_DAMAGED. Anything else can succeed on the next try and is never reported as a lost key: a transient
     * keystore2 or StrongBox failure (KEYSTORE_BUSY, API 33+), a locked device (DEVICE_LOCKED), an unexplained
     * provider error (KEYSTORE).
     */
    private fun errorCode(t: Throwable): String {
        val chain = generateSequence(t) { it.cause }.take(8).toList()
        if (chain.any { it is KeyGoneException }) return "KEY_MISSING"
        if (chain.any { it is KeyPermanentlyInvalidatedException }) return "KEY_INVALIDATED"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val ks = chain.firstNotNullOfOrNull { it as? android.security.KeyStoreException }
            if (ks != null) {
                if (ks.isTransientFailure) return "KEYSTORE_BUSY"
                when (ks.numericErrorCode) {
                    android.security.KeyStoreException.ERROR_KEY_DOES_NOT_EXIST -> return "KEY_MISSING"
                    android.security.KeyStoreException.ERROR_KEY_CORRUPTED -> return "KEY_CORRUPTED"
                }
            }
        }
        if (chain.any { it is AEADBadTagException }) return "KEY_MISMATCH"
        if (chain.any { it is SealedDataException }) return "SEALED_DAMAGED"
        if (chain.any { it.javaClass.simpleName.contains("UserNotAuthenticated") ||
                (it.message ?: "").contains("unlocked", ignoreCase = true) }) return "DEVICE_LOCKED"
        return "KEYSTORE"
    }

    /**
     * Makes the device seal when an answered listing shows there is none, and proves it with a round trip: the only place
     * a seal key is made, for a new or unsealed vault. Only a key made by this call is removed when that fails; an
     * existing key, and one whose presence could not be read, is never replaced or removed here, because a vault may be
     * sealed by it (MVA-R5-01, MA-R2-01). Any failure answers false.
     */
    @ReactMethod
    fun hwAvailable(promise: Promise) {
        var made = false
        try {
            val key = try {
                secretKey(SEAL_ALIAS)
            } catch (_: KeyGoneException) {
                made = true
                generateKey(SEAL_ALIAS, biometric = false)
            }
            val probe = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
            val blob = seal(key, probe)
            val back = decryptCipher(key, blob).doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
            val ok = back.contentEquals(probe)
            if (!ok && made) deleteKey(SEAL_ALIAS)
            promise.resolve(ok)
        } catch (t: Throwable) {
            if (made) deleteKey(SEAL_ALIAS)
            promise.resolve(false)
        }
    }

    /**
     * Seals with the device seal key that exists now and never makes one (MA-R2-01). A caller either had hwAvailable make
     * or find the key just before (a new or unsealed vault), or seals again a vault that key sealed (a data-key or secret
     * rotation): a key made here would replace the one both stored copies still depend on.
     */
    @ReactMethod
    fun hwSeal(dataB64: String, promise: Promise) {
        var data: ByteArray? = null
        try {
            data = Base64.decode(dataB64, Base64.NO_WRAP)
            val key = secretKey(SEAL_ALIAS)
            promise.resolve(Base64.encodeToString(seal(key, data), Base64.NO_WRAP))
        } catch (t: Throwable) {
            promise.reject(errorCode(t), t.message, t)
        } finally {
            data?.fill(0)
        }
    }

    @ReactMethod
    fun hwOpen(blobB64: String, promise: Promise) = openWith(SEAL_ALIAS, blobB64, promise)

    // ── The first device seal (v1), for vaults it sealed: opened, used while the current seal cannot be made, deleted
    // once no vault names it. Never made again (MVA-R4-01).

    @ReactMethod
    fun hwOpenLegacy(blobB64: String, promise: Promise) = openWith(LEGACY_SEAL_ALIAS, blobB64, promise)

    @ReactMethod
    fun hwSealLegacy(dataB64: String, promise: Promise) {
        var data: ByteArray? = null
        try {
            data = Base64.decode(dataB64, Base64.NO_WRAP)
            val key = secretKey(LEGACY_SEAL_ALIAS)
            promise.resolve(Base64.encodeToString(seal(key, data), Base64.NO_WRAP))
        } catch (t: Throwable) {
            promise.reject(errorCode(t), t.message, t)
        } finally {
            data?.fill(0)
        }
    }

    @ReactMethod
    fun hwDeleteLegacy(promise: Promise) {
        deleteKey(LEGACY_SEAL_ALIAS)
        promise.resolve(null)
    }

    private fun openWith(alias: String, blobB64: String, promise: Promise) {
        var out: ByteArray? = null
        try {
            val blob = Base64.decode(blobB64, Base64.NO_WRAP)
            val key = secretKey(alias)
            out = decryptCipher(key, blob).doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
            promise.resolve(Base64.encodeToString(out, Base64.NO_WRAP))
        } catch (t: Throwable) {
            promise.reject(errorCode(t), t.message, t)
        } finally {
            out?.fill(0)
        }
    }

    @ReactMethod
    fun bioAvailable(promise: Promise) {
        val status = BiometricManager.from(reactContext).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        promise.resolve(status == BiometricManager.BIOMETRIC_SUCCESS)
    }

    /** Seals data under a fresh biometric key (any earlier one is replaced); the prompt authorises the use. */
    @ReactMethod
    fun bioSeal(dataB64: String, title: String, subtitle: String, cancel: String, promise: Promise) {
        val activity = reactContext.currentActivity as? FragmentActivity
            ?: return promise.reject("NO_ACTIVITY", "No screen to show the biometric prompt on")
        val data = Base64.decode(dataB64, Base64.NO_WRAP)
        try {
            deleteKey(BIO_ALIAS)
            val key = generateKey(BIO_ALIAS, biometric = true)
            val cipher = Cipher.getInstance(GCM).apply { init(Cipher.ENCRYPT_MODE, key) }
            authenticate(activity, cipher, title, subtitle, cancel, promise, onDone = { data.fill(0) }) { authed ->
                Base64.encodeToString(seal(key, data, authed), Base64.NO_WRAP)
            }
        } catch (t: Throwable) {
            data.fill(0)
            deleteKey(BIO_ALIAS)
            promise.reject(errorCode(t), t.message, t)
        }
    }

    /**
     * Opens data sealed under the biometric key behind the system prompt. `description`: what the prompt approves (the
     * recipient of a send), drawn by the system where no app can change it. `confirm`: the prompt of an approval (a
     * send, a site's request, a burn) needs a deliberate press after a passive face match; unlock does not (MVA-R5-02).
     */
    @ReactMethod
    fun bioOpen(blobB64: String, title: String, subtitle: String, description: String, cancel: String, confirm: Boolean, promise: Promise) {
        val activity = reactContext.currentActivity as? FragmentActivity
            ?: return promise.reject("NO_ACTIVITY", "No screen to show the biometric prompt on")
        try {
            val blob = Base64.decode(blobB64, Base64.NO_WRAP)
            val key = secretKey(BIO_ALIAS)
            val cipher = decryptCipher(key, blob)
            authenticate(activity, cipher, title, subtitle, cancel, promise, description = description, confirm = confirm) { authed ->
                val out = authed.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
                try { Base64.encodeToString(out, Base64.NO_WRAP) } finally { out.fill(0) }
            }
        } catch (t: Throwable) {
            // A new fingerprint or face was enrolled: the key is dead by design; the password takes over.
            if (t is KeyPermanentlyInvalidatedException) deleteKey(BIO_ALIAS)
            promise.reject(errorCode(t), t.message, t)
        }
    }

    private fun authenticate(
        activity: FragmentActivity,
        cipher: Cipher,
        title: String,
        subtitle: String,
        cancel: String,
        promise: Promise,
        onDone: () -> Unit = {},
        description: String = "",
        confirm: Boolean = false,
        use: (Cipher) -> String,
    ) {
        activity.runOnUiThread {
            try {
                val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            try {
                                val authed = result.cryptoObject?.cipher ?: throw IllegalStateException("No cipher")
                                promise.resolve(use(authed))
                            } catch (t: Throwable) {
                                promise.reject(errorCode(t), t.message, t)
                            } finally {
                                onDone()
                            }
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            onDone()
                            val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                                errorCode == BiometricPrompt.ERROR_CANCELED
                            promise.reject(if (cancelled) "BIO_CANCELLED" else "BIO_ERROR", errString.toString())
                        }
                    })
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .apply { if (subtitle.isNotEmpty()) setSubtitle(subtitle) }
                    .apply { if (description.isNotEmpty()) setDescription(description) }
                    // The app's language, passed by JS; English only if the caller had none.
                    .setNegativeButtonText(cancel.ifEmpty { "Use password" })
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(confirm)
                    .build()
                prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            } catch (t: Throwable) {
                onDone()
                promise.reject("BIO_ERROR", t.message, t)
            }
        }
    }

    @ReactMethod
    fun bioDelete(promise: Promise) {
        deleteKey(BIO_ALIAS)
        promise.resolve(null)
    }

    // ── The screen-lock key (Android 11+): the vault secret of a wallet that opens with the screen lock ───────────
    // Per-use authentication with a strong biometric or the device credential needs API 30 for a CryptoObject; below it,
    // and on a device without a secure lock screen, the wallet uses a password instead. New fingerprints or faces do
    // not invalidate the key (the device credential always opens it); removing the screen lock deletes or invalidates it,
    // and every secret it sealed goes with it.
    // A sealed secret is hybrid: a random AES-256-GCM key seals the secret in software and only that key goes through
    // RSA-OAEP, so a secret of any length fits (an RSA-2048 block alone takes 190 bytes at most). Its header names the RSA
    // key by the first bytes of SHA-256 of its public half: a key made after the one that sealed it went (a screen lock
    // removed and set again) is told apart without a prompt, and the secret reads as gone.

    private fun deviceSecure(): Boolean =
        (reactContext.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isDeviceSecure == true

    private fun devAuthSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && deviceSecure()

    /** The screen-lock device key's public half as a plain key, so sealing runs in software and asks nothing. Made first
     *  when an answered listing shows there is none, and made again when the one there was invalidated: a screen lock
     *  removed and set again leaves the dead alias on some releases (Android 11), and sealing to it would give secrets no
     *  prompt can ever open. What that key sealed is lost already, so replacing it loses nothing. A key the Keystore only
     *  failed to read is neither deleted nor replaced: the call fails instead (MA-R2-01). */
    private fun devAuthPublicKey(): PublicKey {
        val now = try { existingDevAuthPublicKey() } catch (_: KeyGoneException) { null }
        if (now != null && !devAuthKeyInvalidated()) return now
        if (now != null) deleteKey(DEV_AUTH_ALIAS)
        generateDevAuthKey()
        return existingDevAuthPublicKey()
    }

    /** Whether the screen-lock key there now is permanently invalidated. Initialising its cipher asks nothing (the per-use
     *  authentication is for the operation), and only an invalidated key refuses it; any other failure (a busy
     *  Keystore) answers false, so a working key is never replaced. */
    private fun devAuthKeyInvalidated(): Boolean {
        return try {
            val key = keyStore().getKey(DEV_AUTH_ALIAS, null) as? PrivateKey ?: return false
            Cipher.getInstance(RSA_OAEP).init(Cipher.DECRYPT_MODE, key, OAEP_SPEC)
            false
        } catch (t: Throwable) {
            generateSequence(t) { it.cause }.take(8).any { it is KeyPermanentlyInvalidatedException }
        }
    }

    /** The public half of the screen-lock key that exists now; never makes one. KeyGoneException when an answered
     *  listing shows there is none, KeystoreUnansweredException when the Keystore could not say. */
    private fun existingDevAuthPublicKey(): PublicKey {
        val cert = entry(DEV_AUTH_ALIAS) { it.getCertificate(DEV_AUTH_ALIAS) }
        return KeyFactory.getInstance(cert.publicKey.algorithm).generatePublic(X509EncodedKeySpec(cert.publicKey.encoded))
    }

    private fun devAuthKeyId(key: PublicKey): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(key.encoded).copyOfRange(0, DEV_AUTH_KEY_ID_BYTES)

    // In the TEE: StrongBox does not offer the MGF1-SHA-1 digest the Keystore's OAEP uses.
    private fun generateDevAuthKey() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw IllegalStateException("Needs Android 11")
        try {
            val spec = KeyGenParameterSpec.Builder(DEV_AUTH_ALIAS, KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                .setInvalidatedByBiometricEnrollment(false)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE).apply { initialize(spec) }.generateKeyPair()
        } catch (t: Throwable) {
            deleteKey(DEV_AUTH_ALIAS)
            throw t
        }
    }

    /**
     * A blob devAuthSeal made: `wrapped` goes through the RSA key; `sealed` is IV || AES-GCM of the secret under the key
     * `wrapped` holds. An earlier build's blob is one RSA block of the secret itself (no key id, no `sealed`).
     */
    private class DevAuthBlob(val keyId: ByteArray?, val wrapped: ByteArray, val sealed: ByteArray?)

    // v2: 0x02 || key id (8) || length of `wrapped` (2, big-endian) || wrapped || IV || AES-GCM. One RSA-2048 block (256
    // bytes) is an earlier build's blob; a v2 blob is always longer.
    private fun parseDevAuthBlob(blob: ByteArray): DevAuthBlob {
        if (blob.size == DEV_AUTH_RSA_BYTES) return DevAuthBlob(null, blob, null)
        val head = 1 + DEV_AUTH_KEY_ID_BYTES + 2
        if (blob.size < head || blob[0] != DEV_AUTH_BLOB_V2) throw SealedDataException()
        val len = ((blob[head - 2].toInt() and 0xff) shl 8) or (blob[head - 1].toInt() and 0xff)
        if (len <= 0 || blob.size < head + len + IV_BYTES + TAG_BITS / 8) throw SealedDataException()
        return DevAuthBlob(blob.copyOfRange(1, 1 + DEV_AUTH_KEY_ID_BYTES), blob.copyOfRange(head, head + len),
            blob.copyOfRange(head + len, blob.size))
    }

    /**
     * The RSA cipher that opens `blob`, made before any prompt: KeyGoneException when the screen-lock key is gone (an
     * answered listing leaves it out) or is not the key that sealed it (a newer one), KeyPermanentlyInvalidatedException
     * when the screen lock that guarded it was removed. Either way the secret can never be opened again. A Keystore that
     * did not answer throws KeystoreUnansweredException, which says nothing about the secret (MA-R2-01).
     */
    private fun devAuthDecryptCipher(blob: DevAuthBlob): Cipher {
        val pub = existingDevAuthPublicKey()
        if (blob.keyId != null && !devAuthKeyId(pub).contentEquals(blob.keyId)) throw KeyGoneException()
        val key = privateKey(DEV_AUTH_ALIAS)
        return Cipher.getInstance(RSA_OAEP).apply { init(Cipher.DECRYPT_MODE, key, OAEP_SPEC) }
    }

    // The secret of `blob`, with the cipher the prompt authorised.
    private fun openDevAuthBlob(authed: Cipher, blob: DevAuthBlob): ByteArray {
        val inner = authed.doFinal(blob.wrapped)
        val sealed = blob.sealed ?: return inner
        try {
            val gcm = Cipher.getInstance(GCM)
            gcm.init(Cipher.DECRYPT_MODE, SecretKeySpec(inner, "AES"), GCMParameterSpec(TAG_BITS, sealed.copyOfRange(0, IV_BYTES)))
            return gcm.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
        } finally {
            inner.fill(0)
        }
    }

    /**
     * Whether a vault secret can be held behind the screen lock now: Android 11+, a secure lock screen, and the key. A
     * Keystore that did not answer, or answered that it is busy, rejects instead of answering no (MA-R2-04): a no sends
     * a new wallet to a password.
     */
    @ReactMethod
    fun devAuthAvailable(promise: Promise) {
        if (!devAuthSupported()) return promise.resolve(false)
        try {
            devAuthPublicKey()
            promise.resolve(true)
        } catch (t: Throwable) {
            val code = errorCode(t)
            if (t is KeystoreUnansweredException || code == "KEYSTORE_BUSY") promise.reject(code, t.message, t)
            else promise.resolve(false)
        }
    }

    @ReactMethod
    fun devAuthSeal(dataB64: String, promise: Promise) {
        var data: ByteArray? = null
        var aes: ByteArray? = null
        try {
            if (!devAuthSupported()) return promise.reject("NOT_SET", "The device has no secure screen lock")
            val input = Base64.decode(dataB64, Base64.NO_WRAP)
            data = input
            val pub = devAuthPublicKey()
            val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
            aes = key
            val gcm = Cipher.getInstance(GCM).apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }
            val body = gcm.iv + gcm.doFinal(input)
            val wrapped = Cipher.getInstance(RSA_OAEP).apply { init(Cipher.ENCRYPT_MODE, pub, OAEP_SPEC) }.doFinal(key)
            val out = ByteArrayOutputStream()
            out.write(DEV_AUTH_BLOB_V2.toInt())
            out.write(devAuthKeyId(pub))
            out.write(wrapped.size shr 8)
            out.write(wrapped.size and 0xff)
            out.write(wrapped)
            out.write(body)
            promise.resolve(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
        } catch (t: Throwable) {
            promise.reject(errorCode(t), t.message, t)
        } finally {
            data?.fill(0)
            aes?.fill(0)
        }
    }

    /**
     * Opens a blob devAuthSeal made, behind the system prompt bound to the key's private half. A failure before the prompt
     * (the cipher, a busy or restarting Keystore) answers PRE_PROMPT, never a code that says the device took the secret
     * and cannot give it back: only a failure after the prompt passed can say that (WalletManager._readBackVerdict). A
     * key that is gone keeps its own code, since that item can never open.
     */
    @ReactMethod
    fun devAuthOpen(blobB64: String, title: String, subtitle: String, description: String, confirm: Boolean, promise: Promise) {
        val activity = reactContext.currentActivity as? FragmentActivity
            ?: return promise.reject("NO_ACTIVITY", "No screen to show the prompt on")
        try {
            if (!devAuthSupported()) return promise.reject("NOT_SET", "The device has no secure screen lock")
            val blob = parseDevAuthBlob(Base64.decode(blobB64, Base64.NO_WRAP))
            val cipher = devAuthDecryptCipher(blob)
            authenticateDevice(activity, BiometricPrompt.CryptoObject(cipher), title, subtitle, description, confirm,
                onError = { code, message -> promise.reject(code, message) }) { authed ->
                val out = openDevAuthBlob(authed!!, blob)
                try { promise.resolve(Base64.encodeToString(out, Base64.NO_WRAP)) } finally { out.fill(0) }
            }
        } catch (t: Throwable) {
            val code = errorCode(t)
            promise.reject(if (code in DEV_AUTH_GONE_CODES) code else "PRE_PROMPT", t.message, t)
        }
    }

    /**
     * Whether a blob devAuthSeal made can still be opened, asking nothing: "ok"; "gone" when it never can (no secure lock
     * screen, the key gone, invalidated or another one, the blob damaged); "unknown" when the Keystore did not answer.
     */
    @ReactMethod
    fun devAuthUsable(blobB64: String, promise: Promise) {
        try {
            if (!devAuthSupported()) return promise.resolve("gone")
            devAuthDecryptCipher(parseDevAuthBlob(Base64.decode(blobB64, Base64.NO_WRAP)))
            promise.resolve("ok")
        } catch (t: Throwable) {
            promise.resolve(if (errorCode(t) in DEV_AUTH_GONE_CODES) "gone" else "unknown")
        }
    }

    // The codes that say a screen-lock blob can never be opened again: no key, an invalidated or corrupted one, or a
    // damaged blob.
    private val DEV_AUTH_GONE_CODES = setOf("KEY_MISSING", "KEY_INVALIDATED", "KEY_CORRUPTED", "SEALED_DAMAGED")

    /**
     * A fresh check of whoever holds the device, as iOS's LAContext check: { ok, code }. Only a wallet under the screen lock
     * asks it (a password wallet confirms with its password): the prompt is bound to the screen-lock key and a random probe
     * must come back through its private half. Without that key (an answered listing leaves it out), or with one the
     * removed screen lock invalidated, the secret it sealed is gone and the answer is 'not_set': no plain prompt stands in
     * for it. 'not_set' also without a secure lock screen. A Keystore that did not answer is 'failed', never 'not_set'
     * (MA-R2-01): Delete and Erase take 'not_set' without a prompt.
     */
    @ReactMethod
    fun authenticate(reason: String, promise: Promise) = authenticateWith(reason, "", "", promise)

    /**
     * As authenticate, with the prompt's own subtitle and description: the system draws the title on one line, so what
     * is approved (a send's recipient) goes into the description, which it shows in full, and the apps that can read the
     * screen into the subtitle, as the password wallet's biometric prompt shows them (MPLAT-R5-01).
     */
    @ReactMethod
    fun authenticateWith(reason: String, subtitle: String, description: String, promise: Promise) {
        val answer = { ok: Boolean, code: String ->
            promise.resolve(Arguments.createMap().apply { putBoolean("ok", ok); putString("code", code) })
        }
        if (!deviceSecure()) return answer(false, "not_set")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return answer(false, "unavailable")
        val activity = reactContext.currentActivity as? FragmentActivity ?: return answer(false, "failed")
        val refused = { code: String, _: String ->
            answer(false, when (code) { "BIO_CANCELLED" -> "cancelled"; "NOT_SET" -> "not_set"; else -> "failed" })
        }
        try {
            val pub = existingDevAuthPublicKey()
            val key = privateKey(DEV_AUTH_ALIAS)
            val probe = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val sealed = Cipher.getInstance(RSA_OAEP).apply { init(Cipher.ENCRYPT_MODE, pub, OAEP_SPEC) }.doFinal(probe)
            val cipher = Cipher.getInstance(RSA_OAEP).apply { init(Cipher.DECRYPT_MODE, key, OAEP_SPEC) }
            authenticateDevice(activity, BiometricPrompt.CryptoObject(cipher), reason, subtitle, description, true, refused) { authed ->
                val same = authed!!.doFinal(sealed).contentEquals(probe)
                answer(same, if (same) "ok" else "failed")
            }
        } catch (t: Throwable) {
            val code = errorCode(t)
            answer(false, if (code == "KEY_INVALIDATED" || code == "KEY_MISSING") "not_set" else "failed")
        }
    }

    // The system prompt for the screen-lock key: a strong biometric or the device credential. No negative button (the
    // system offers the credential instead); an approval needs a deliberate press after a passive face match. `use`
    // gets the authorised cipher (a plain prompt, with no CryptoObject, gets a null one and must not touch it).
    private fun authenticateDevice(
        activity: FragmentActivity,
        crypto: BiometricPrompt.CryptoObject?,
        title: String,
        subtitle: String,
        description: String,
        confirm: Boolean,
        onError: (String, String) -> Unit,
        use: (Cipher?) -> Unit,
    ) {
        activity.runOnUiThread {
            try {
                val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            try {
                                val authed = result.cryptoObject?.cipher
                                if (crypto != null && authed == null) throw IllegalStateException("No cipher")
                                use(authed)
                            } catch (t: Throwable) {
                                onError(errorCode(t), t.message ?: "")
                            }
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            val code = when (errorCode) {
                                BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED -> "BIO_CANCELLED"
                                BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "NOT_SET"
                                else -> "BIO_ERROR"
                            }
                            onError(code, errString.toString())
                        }
                    })
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title.ifEmpty { "QNet Wallet" })
                    .apply { if (subtitle.isNotEmpty()) setSubtitle(subtitle) }
                    .apply { if (description.isNotEmpty()) setDescription(description) }
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .setConfirmationRequired(confirm)
                    .build()
                if (crypto != null) prompt.authenticate(info, crypto) else prompt.authenticate(info)
            } catch (t: Throwable) {
                onError("BIO_ERROR", t.message ?: "")
            }
        }
    }

    @ReactMethod
    fun deleteKeys(promise: Promise) {
        deleteKey(SEAL_ALIAS)
        deleteKey(LEGACY_SEAL_ALIAS)
        deleteKey(BIO_ALIAS)
        deleteKey(DEV_AUTH_ALIAS)
        deleteKey(PROBE_ALIAS)
        promise.resolve(null)
    }

    /**
     * Part of deleting or replacing the wallet (L-6): what the in-app browser left in the app's private storage goes now,
     * not when the next page opens: every cookie, every site's storage (localStorage, IndexedDB, service workers), the
     * web view HTTP cache and saved form data, as a web view created with `incognito` wipes them. iOS does the same
     * (QNetSecurityModule.m clearWebData). Best effort: resolves false when the system has no web view to ask.
     */
    @ReactMethod
    fun clearWebData(promise: Promise) {
        main.post {
            try {
                val cookies = android.webkit.CookieManager.getInstance()
                cookies.removeAllCookies(null)
                cookies.flush()
                android.webkit.WebStorage.getInstance().deleteAllData()
                android.webkit.WebView(reactContext).apply {
                    clearCache(true)
                    clearFormData()
                    destroy()
                }
                android.webkit.WebViewDatabase.getInstance(reactContext).clearHttpAuthUsernamePassword()
                promise.resolve(true)
            } catch (_: Throwable) {
                promise.resolve(false)
            }
        }
    }
}
