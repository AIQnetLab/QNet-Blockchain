import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
import FirebaseMessaging
import TSBackgroundFetch

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
  var window: UIWindow?

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

    window = UIWindow(frame: UIScreen.main.bounds)
    
    // Set dark background color to match launch screen (#11131f = rgb(17, 19, 31))
    window?.backgroundColor = UIColor(red: 17.0/255.0, green: 19.0/255.0, blue: 31.0/255.0, alpha: 1.0)

    factory.startReactNative(
      withModuleName: "QNetMobile",
      in: window,
      launchOptions: launchOptions
    )
    
    // Set root view background to match launch screen
    if let rootView = window?.rootViewController?.view {
      rootView.backgroundColor = UIColor(red: 17.0/255.0, green: 19.0/255.0, blue: 31.0/255.0, alpha: 1.0)
    }

    // Registers the periodic wake with BGTaskScheduler, which accepts a launch handler only while the app
    // finishes launching; Info.plist permits exactly this task (com.transistorsoft.fetch). Called once.
    TSBackgroundFetch.sharedInstance().didFinishLaunching()

    return true
  }
  
  // A Universal Link (https://link.aiqnet.io/l, verified by iOS against that host's apple-app-site-association) goes
  // to React Native's Linking. The app registers no custom URL scheme, so nothing else arrives this way.
  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard userActivity.activityType == NSUserActivityTypeBrowsingWeb else { return false }
    return RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
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

  // The app-switcher snapshot is taken after resign-active, so an opaque cover goes on first and comes off
  // when the app is active again: no balance, address or recovery phrase is ever in the snapshot.
  private var privacyCover: UIView?

  func applicationWillResignActive(_ application: UIApplication) {
    guard privacyCover == nil, let window = window else { return }
    let cover = UIView(frame: window.bounds)
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cover.backgroundColor = UIColor(red: 17.0/255.0, green: 19.0/255.0, blue: 31.0/255.0, alpha: 1.0)
    window.addSubview(cover)
    privacyCover = cover
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    privacyCover?.removeFromSuperview()
    privacyCover = nil
  }

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
