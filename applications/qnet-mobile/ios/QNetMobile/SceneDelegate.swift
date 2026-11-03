import UIKit
import React

// The app's one scene (Info.plist UIApplicationSceneManifest): it shows React Native's window, covers the app-switcher
// snapshot, puts the links that open the app in the link inbox (LinkInbox.swift) and marks an open (TaskState.swift).
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
      // and the link it connected with goes to the inbox as one does while the app runs.
      running.windowScene = windowScene
      running.frame = windowScene.coordinateSpace.bounds
      running.makeKeyAndVisible()
      self.window = running
      connectionOptions.userActivities.forEach { continueLink($0) }
      return
    }
    // The link that launched the app waits in the inbox for the wallet screen, which reads it once it is up.
    connectionOptions.userActivities.forEach { continueLink($0) }
    let created = UIWindow(windowScene: windowScene)
    self.window = created
    app.runReactNative(in: created)
  }

  // A Universal Link (https://link.aiqnet.io/l or /send, verified by iOS against that host's
  // apple-app-site-association). The app registers no custom URL scheme, so nothing else arrives this way.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueLink(userActivity)
  }

  // The link waits in the inbox first; Linking's event only tells a wallet screen that is up to look there.
  private func continueLink(_ activity: NSUserActivity) {
    guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL else { return }
    QNetLinkInbox.offer(url.absoluteString)
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
