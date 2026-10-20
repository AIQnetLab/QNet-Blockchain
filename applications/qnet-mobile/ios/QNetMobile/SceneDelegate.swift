import UIKit
import React

// The app's one scene (Info.plist UIApplicationSceneManifest): it shows React Native's window, covers the app-switcher
// snapshot, hands the links that open the app to React Native's Linking and marks an open (TaskState.swift).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate else { return }
    if let running = app.window {
      // React Native already runs (a background launch, or this scene connecting again): the scene takes its window,
      // and the link it connected with reaches Linking as one does while the app runs.
      running.windowScene = windowScene
      running.frame = windowScene.coordinateSpace.bounds
      running.makeKeyAndVisible()
      self.window = running
      connectionOptions.userActivities.forEach { continueLink($0) }
      return
    }
    let created = UIWindow(windowScene: windowScene)
    self.window = created
    app.runReactNative(in: created, launchOptions: SceneDelegate.launchOptions(connectionOptions))
  }

  // Linking reads the link that launched the app from the launch options (getInitialURL); under a scene it comes in
  // the connection options, so it is put where Linking reads it.
  private static func launchOptions(_ options: UIScene.ConnectionOptions) -> [UIApplication.LaunchOptionsKey: Any]? {
    guard let activity = options.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) else {
      return nil
    }
    let entry: [String: Any] = [
      UIApplication.LaunchOptionsKey.userActivityType.rawValue: NSUserActivityTypeBrowsingWeb,
      "UIApplicationLaunchOptionsUserActivityKey": activity,
    ]
    return [.userActivityDictionary: entry]
  }

  // A Universal Link (https://link.aiqnet.io/l or /send, verified by iOS against that host's
  // apple-app-site-association). The app registers no custom URL scheme, so nothing else arrives this way.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueLink(userActivity)
  }

  private func continueLink(_ activity: NSUserActivity) {
    guard activity.activityType == NSUserActivityTypeBrowsingWeb else { return }
    _ = RCTLinkingManager.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }

  // The app-switcher snapshot is taken after resign-active, so an opaque cover goes on first and comes off
  // when the app is active again: no balance, address or recovery phrase is ever in the snapshot. The cover is the
  // process's, as the window is: a scene that disconnects while covered leaves it to the next one to take off.
  private static var privacyCover: UIView?

  func sceneWillResignActive(_ scene: UIScene) {
    guard SceneDelegate.privacyCover == nil, let window = window else { return }
    let cover = UIView(frame: window.bounds)
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cover.backgroundColor = AppDelegate.launchColor
    window.addSubview(cover)
    SceneDelegate.privacyCover = cover
  }

  // Active in front is the user's open: a close from the app switcher no longer holds the node (TaskState.swift).
  func sceneDidBecomeActive(_ scene: UIScene) {
    SceneDelegate.privacyCover?.removeFromSuperview()
    SceneDelegate.privacyCover = nil
    QNetTaskState.opened()
  }
}
