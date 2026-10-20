package com.qnetmobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "QNetMobile"

  override fun onCreate(savedInstanceState: Bundle?) {
    // A link (QNet Link, a transfer link) is a one-time request: an activity restored, or relaunched from recents, still
    // carries the intent that first started it, and must not hand that link to the app again.
    if (savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
      intent.data = null
    }
    super.onCreate(savedInstanceState)
    // The recents screen shows no snapshot of the wallet (API 33+); secret screens add FLAG_SECURE on top.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(false)
    // From API 29 the window is edge to edge (MainApplication; set up by super.onCreate), with the bars' look picked from
    // the system's light or dark mode. The app is dark on every screen: light icons on both bars, and no system scrim
    // over the app's own bottom bar. Below API 29 the bars keep the app's own dark colours.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val bars = WindowInsetsControllerCompat(window, window.decorView)
      bars.isAppearanceLightStatusBars = false
      bars.isAppearanceLightNavigationBars = false
      window.isNavigationBarContrastEnforced = false
    }
  }

  /**
   * Below API 33 the recents screen keeps the snapshot taken as the wallet leaves the screen, and nothing but
   * FLAG_SECURE keeps balances, addresses and payees out of it (MPLAT-R5-03). So the window is secure on its way to the
   * background, and plain again when it returns, unless a secret screen holds the flag (SecurityModule).
   */
  override fun onPause() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    super.onPause()
    TaskState.left(this)
  }

  /**
   * The app is open: a light node answers again (TaskState clears every sign of a swipe from the recent apps), and the
   * watch that notices the next swipe starts.
   */
  override fun onResume() {
    super.onResume()
    TaskState.opened(this)
    TaskState.watch(this)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && !SecurityModule.secretScreenOn) {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  // Android 7 to 10 keep no record of a removed task's end: the finishing activity notes it first (TaskState.finished).
  override fun onDestroy() {
    if (isFinishing && !isChangingConfigurations) TaskState.finished(this)
    super.onDestroy()
  }

  /**
   * Every React Native view has an id (its react tag), so the window would save the text of each mounted text
   * field (a password typed on the lock screen, a phrase typed for import) into the Bundle Android hands to
   * system_server after every onStop and keeps while the app is in the background. React Native never restores
   * that view state, so it is dropped here and no typed secret leaves the process (MPLAT-R2-04).
   */
  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.remove(VIEW_HIERARCHY_STATE)
  }

  private companion object {
    // Activity.WINDOW_HIERARCHY_TAG, which the platform does not expose.
    const val VIEW_HIERARCHY_STATE = "android:viewHierarchyState"
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
