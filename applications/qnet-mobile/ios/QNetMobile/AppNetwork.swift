import Foundation
import Network
import React

// The JS event `qnetNetworkBack` each time a usable network path appears: the first, one after none, or one on other
// interfaces (Wi-Fi to cellular and back): the JS retries that wait on a back-off for aiqnet.io try again at once
// (src/services/NetworkWake.js). The same module name and event as Android's (AppNetwork.kt).
@objc(QNetNetwork)
class QNetNetwork: RCTEventEmitter {
  static let networkBack = "qnetNetworkBack"
  private static let kinds: [NWInterface.InterfaceType] = [.wifi, .cellular, .wiredEthernet, .loopback, .other]
  // The path's updates and the state below, on one queue.
  private let queue = DispatchQueue(label: "io.aiqnet.wallet.network")
  private var monitor: NWPathMonitor?
  // The interfaces of the usable path seen last: nil before the first and while there is none.
  private var current: [NWInterface.InterfaceType]?
  private var listening = false

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return [QNetNetwork.networkBack]
  }

  // RCTEventEmitter: the first JS listener starts the watch, the last one gone ends it.
  override func startObserving() {
    let watch = NWPathMonitor()
    watch.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
    queue.async { self.listening = true }
    monitor = watch
    watch.start(queue: queue)
  }

  override func stopObserving() {
    monitor?.cancel()
    monitor = nil
    queue.async {
      self.listening = false
      self.current = nil
    }
  }

  private func pathChanged(_ path: NWPath) {
    guard path.status == .satisfied else {
      current = nil
      return
    }
    let now = QNetNetwork.kinds.filter { path.usesInterfaceType($0) }
    if now == current { return }
    current = now
    guard listening else { return }
    NSLog("[INFO][NET] network_back interfaces=%ld", now.count)
    sendEvent(withName: QNetNetwork.networkBack, body: nil)
  }
}
