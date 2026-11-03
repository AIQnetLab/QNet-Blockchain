import Foundation
import React

// The links the system hands to the app, in the order they came, each kept until the wallet screen is done with it
// (JS services/LinkInbox): a link waits here whether or not the app's JS was up to hear it, a launch included. The same
// link twice while it waits is one. Every change is kept in UserDefaults, which only a new process reads: a link the app
// ended on comes back within `life` of its arrival, a done one never. The same module name and shape as Android's
// (LinkInbox.kt).
@objc(QNetLinkInbox)
class QNetLinkInbox: NSObject {
  // More links than the user can have tapped while the wallet screen was not taking them; one past it is refused and
  // logged, never one already waiting (the screen may be showing it).
  private static let limit = 8
  // How long after its arrival a kept link comes back in a new process: a QNet Link session lives 600 s.
  private static let life: Double = 600_000
  private static let storeKey = "qnet_link_inbox"
  private static let lock = NSLock()
  private static var next = 1
  // Read from the device on first use, so once per process.
  private static var links: [(id: Int, url: String, at: Double)] = restore()

  private static func nowMs() -> Double {
    return Date().timeIntervalSince1970 * 1000
  }

  private static func restore() -> [(id: Int, url: String, at: Double)] {
    let kept = UserDefaults.standard.array(forKey: storeKey) as? [[String: Any]] ?? []
    let now = nowMs()
    var out: [(id: Int, url: String, at: Double)] = []
    for entry in kept {
      guard let url = entry["url"] as? String, let at = entry["at"] as? Double, at.isFinite else { continue }
      let age = now - at
      if age < 0 || age > life {
        NSLog("[INFO][LINK] link_dropped reason=stale age_s=%lld", Int64(max(-1e15, min(1e15, age / 1000))))
      } else if out.count < limit && !out.contains(where: { $0.url == url }) {
        out.append((id: next, url: url, at: at))
        next += 1
      }
    }
    if out.count != kept.count { save(out) }
    return out
  }

  private static func save(_ waiting: [(id: Int, url: String, at: Double)]) {
    UserDefaults.standard.set(waiting.map { ["url": $0.url, "at": $0.at] as [String: Any] }, forKey: storeKey)
  }

  // SceneDelegate: a Universal Link that opened the app or came while it runs.
  static func offer(_ url: String) {
    lock.lock()
    defer { lock.unlock() }
    if links.contains(where: { $0.url == url }) { return }
    if links.count >= limit {
      NSLog("[WARN][LINK] link_dropped reason=full waiting=%ld", links.count)
      return
    }
    links.append((id: next, url: url, at: nowMs()))
    next += 1
    save(links)
    NSLog("[INFO][LINK] link_received waiting=%ld", links.count)
  }

  // The lines of the link path the JS asks for (services/LinkInbox noteLink), each with its own keys; the one at WARN.
  // The same as Android's (LinkInbox.kt NOTE_KEYS).
  private static let noteKeys: [String: [String]] = [
    "request_shown": ["intent", "offer"],
    "answer_delivered": ["intent", "status", "ms"],
    "answer_not_delivered": ["intent", "outcome", "status", "ms"],
    "transfer_form_opened": ["token"],
  ]
  private static let noteWarn = "answer_not_delivered"

  // The line for `event`, or nil for one not in noteKeys: only its keys, each value a code of at most 16 letters,
  // digits or underscores or a whole number below a billion, so no session, key, address or link can reach the log.
  static func noteLine(_ event: String, _ fields: [String: Any]) -> String? {
    guard let keys = noteKeys[event] else { return nil }
    var parts = ["[\(event == noteWarn ? "WARN" : "INFO")][LINK] \(event)"]
    for key in keys {
      if let value = noteValue(fields[key]) { parts.append("\(key)=\(value)") }
    }
    return parts.joined(separator: " ")
  }

  private static func noteValue(_ value: Any?) -> String? {
    if let text = value as? String {
      return text.range(of: "^[A-Za-z0-9_]{1,16}$", options: .regularExpression) != nil ? text : nil
    }
    if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
      let d = number.doubleValue
      return d.isFinite && d >= 0 && d < 1e9 && d == d.rounded(.down) ? String(Int64(d)) : nil
    }
    return nil
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  // Exported by QNetLinkInbox.m: [{ id, url }], oldest first.
  @objc(pending:rejecter:)
  func pending(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    QNetLinkInbox.lock.lock()
    let waiting = QNetLinkInbox.links.map { ["id": $0.id, "url": $0.url] as [String: Any] }
    QNetLinkInbox.lock.unlock()
    resolve(waiting)
  }

  // Exported by QNetLinkInbox.m: the screen is done with that link.
  @objc(done:)
  func done(_ entry: NSNumber) {
    QNetLinkInbox.lock.lock()
    defer { QNetLinkInbox.lock.unlock() }
    let before = QNetLinkInbox.links.count
    QNetLinkInbox.links.removeAll { $0.id == entry.intValue }
    if QNetLinkInbox.links.count != before { QNetLinkInbox.save(QNetLinkInbox.links) }
  }

  // Exported by QNetLinkInbox.m: a line of the link path (noteLine) in the log, whatever the JS build.
  @objc(note:fields:)
  func note(_ event: String, fields: NSDictionary) {
    guard let line = QNetLinkInbox.noteLine(event, fields as? [String: Any] ?? [:]) else { return }
    NSLog("%@", line)
  }
}
