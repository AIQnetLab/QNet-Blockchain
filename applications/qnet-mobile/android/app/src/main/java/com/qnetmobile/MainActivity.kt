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
    // A link (QNet Link, a transfer link) is a one-time request: a new one waits in the inbox until the wallet screen is
    // done with it; an activity restored, or relaunched from recents, still carries the intent that first started it,
    // whose link nothing may read again.
    if (!LinkInbox.receive(this, intent, restored = savedInstanceState != null)) {
      intent.data = null
    }
    super.onCreate(savedInstanceState)
    // The recents screen shows no snapshot of the wallet (API 33+); the user's own screenshots and recordings stay free.
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
   * A link for the running activity (singleTask), or for one just remade after its process ended, which React Native
   * drops while its context is not up: it waits in the inbox first, and the activity's intent is the newest one.
   */
  override fun onNewIntent(intent: Intent) {
    LinkInbox.receive(this, intent, restored = false)
    super.onNewIntent(intent)
    setIntent(intent)
  }

  /**
   * Below API 33 the recents screen keeps the snapshot taken as the wallet leaves the screen, and nothing but
   * FLAG_SECURE keeps balances, addresses and payees out of it (MPLAT-R5-03). So the window is secure on its way to the
   * background, and plain again the moment it is in front, where every screen can be captured.
   */
  override fun onPause() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    super.onPause()
    TaskState.left()
    // Out of front no idle HTTP connection is kept, so none is pinged there (AppNetwork).
    AppNetwork.toBack()
  }

  /**
   * The app is open: a light node answers again (TaskState clears every sign of a swipe from the recent apps), and the
   * watch that notices the next swipe starts. First, no idle HTTP connection from the background is reused (AppNetwork).
   */
  override fun onResume() {
    AppNetwork.toFront()
    super.onResume()
    TaskState.opened(this)
    TaskState.watch(this)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
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
