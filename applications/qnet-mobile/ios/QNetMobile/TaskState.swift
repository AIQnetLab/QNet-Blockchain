import Foundation
import React

// Whether the user closed QNet Wallet from the app switcher since it was last opened, so a background launch answers
// nothing: AppDelegate sets the mark when UIKit reports the closed scene, SceneDelegate clears it on activation.
// The same module name and shape as Android's (TaskState.kt).
@objc(QNetTaskState)
class QNetTaskState: NSObject {
  // In the app's own defaults: it outlives the process, and nothing else reads it.
  private static let closedKey = "qnet_closed_by_user"

  static func markClosed() {
    UserDefaults.standard.set(true, forKey: closedKey)
  }

  static func opened() {
    UserDefaults.standard.set(false, forKey: closedKey)
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  // Exported by QNetTaskState.m.
  @objc(closedByUser:rejecter:)
  func closedByUser(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(UserDefaults.standard.bool(forKey: QNetTaskState.closedKey))
  }
}
