import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
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

    return true
  }
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
