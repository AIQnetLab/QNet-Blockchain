import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
import FirebaseMessaging
import TSBackgroundFetch

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
  // The one window React Native runs in for the life of the process; the scene shows it (SceneDelegate.swift).
  var window: UIWindow?

  // The launch screen's colour (#11131f = rgb(17, 19, 31)): behind React Native's root and on the app-switcher cover.
  static let launchColor = UIColor(red: 17.0/255.0, green: 19.0/255.0, blue: 31.0/255.0, alpha: 1.0)

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Initialize Firebase
    FirebaseApp.configure()
    
    // Silent data pushes only: no notification permission is asked for, and registering for remote notifications
    // asks the user nothing.
    UNUserNotificationCenter.current().delegate = self
    Messaging.messaging().delegate = self
    application.registerForRemoteNotifications()
    
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // The scene starts React Native. A launch the system makes in the background (a push, the periodic wake) may
    // connect no scene: React Native then starts in a window no scene shows yet, so the JS still runs.
    DispatchQueue.main.async {
      guard self.window == nil, application.connectedScenes.isEmpty else { return }
      self.runReactNative(in: UIWindow(), launchOptions: nil)
    }

    // Registers the periodic wake with BGTaskScheduler, which accepts a launch handler only while the app
    // finishes launching; Info.plist permits exactly this task (com.transistorsoft.fetch). Called once.
    TSBackgroundFetch.sharedInstance().didFinishLaunching()

    return true
  }

  // React Native's one root, started once per process in `window`; `launchOptions` carries the link that opened the
  // app, where Linking reads it (getInitialURL).
  func runReactNative(in window: UIWindow, launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
    window.backgroundColor = AppDelegate.launchColor
    self.window = window
    reactNativeFactory?.startReactNative(withModuleName: "QNetMobile", in: window, launchOptions: launchOptions)
    window.rootViewController?.view.backgroundColor = AppDelegate.launchColor
  }

  // The user closed the app's scene from the app switcher; UIKit reports it at the next launch when the app was not
  // running, a background launch included. The node answers nothing until the app is opened again (TaskState.swift).
  func application(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>) {
    guard application.applicationState != .active else { return }
    QNetTaskState.markClosed()
  }

  // No third-party keyboard ever receives what is typed in the wallet (MPLAT-R2-02). iOS forces the system
  // keyboard only in secure text fields, and the recovery-phrase field cannot be one; a custom keyboard (with Full
  // Access it may sync or cloud-check text) would get all twelve words. The wallet has no text that needs one.
  func application(
    _ application: UIApplication,
    shouldAllowExtensionPointIdentifier extensionPointIdentifier: UIApplication.ExtensionPointIdentifier
  ) -> Bool {
    return extensionPointIdentifier != .keyboard
  }

  // The token is handled by React Native Firebase; it is never logged.
  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {}

  // Handle APNs device token — required for FCM to work on iOS
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Messaging.messaging().apnsToken = deviceToken
  }

  // No background-push method here: React Native Firebase runs the JS handler and completes the push itself;
  // one here would complete it at once, and with the delegate proxy off it would take the push from RNFB.
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
