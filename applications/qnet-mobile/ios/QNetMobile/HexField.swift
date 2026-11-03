import CoreText
import React
import UIKit

// The live field of the welcome and lock screens, drawn on the UI thread from the display's frame clock: HexField.js's
// steps (ported in HexRain.swift) run here, so nothing of the field crosses to JS while it runs.
final class QNetHexFieldView: UIView {
  @objc var rows: Int = 0 {
    didSet { if rows != oldValue { plan() } }
  }
  @objc var live: Bool = false {
    didSet { run() }
  }
  @objc var rtl: Bool = false {
    didSet { setNeedsDisplay() }
  }
  @objc var paper: UIColor? {
    didSet { setNeedsDisplay() }
  }
  @objc var signalPale: UIColor? {
    didSet { setNeedsDisplay() }
  }
  @objc var signal: UIColor? {
    didSet { setNeedsDisplay() }
  }
  @objc var glowColor: UIColor? {
    didSet { setNeedsDisplay() }
  }
  // In points: the blur React Native Text gives its text shadow.
  @objc var glowRadius: CGFloat = 0 {
    didSet { setNeedsDisplay() }
  }
  @objc var cellSize: CGFloat = 0 {
    didSet { setNeedsDisplay() }
  }
  @objc var glyphSize: CGFloat = 0 {
    didSet { if glyphSize != oldValue { retype() } }
  }
  @objc var fontName: String? {
    didSet { if fontName != oldValue { retype() } }
  }
  override var isHidden: Bool {
    didSet { run() }
  }

  private struct Line {
    let line: CTLine
    let width: CGFloat
  }

  private static var warned = Set<String>()
  private var cols: [HexRain.Column] = []
  private var clock = HexRain.Clock()
  // The first frame after a start sets tick 0 again, so the field goes on from where it stood.
  private var anchor = true
  private var front = true
  private var link: CADisplayLink?
  private var face: UIFont?
  // One line per glyph: the context's fill colour and alpha give it every tone and shade.
  private var lines: [UInt16: Line] = [:]

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    contentMode = .redraw
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    front = UIApplication.shared.applicationState != .background
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(movedBack), name: UIApplication.didEnterBackgroundNotification,
                       object: nil)
    center.addObserver(self, selector: #selector(movedFront), name: UIApplication.willEnterForegroundNotification,
                       object: nil)
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    run()
  }

  @objc private func movedBack() {
    front = false
    run()
  }

  @objc private func movedFront() {
    front = true
    run()
  }

  private func plan() {
    cols = rows > 1 ? HexRain.columns(rows) : []
    clock = HexRain.Clock()
    anchor = true
    setNeedsDisplay()
    run()
  }

  // One rule for the clock: it runs only while the field is live, in a window, shown and the app in front.
  private func run() {
    let want = live && window != nil && !isHidden && front && !cols.isEmpty
    if want == (link != nil) { return }
    if want {
      anchor = true
      let made = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.frame(_:)))
      made.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 30)
      // The common modes: the field keeps running while the screen under it scrolls.
      made.add(to: .main, forMode: .common)
      link = made
    } else {
      link?.invalidate()
      link = nil
    }
  }

  fileprivate func onFrame(_ link: CADisplayLink) {
    let at = link.timestamp * 1000
    if anchor {
      clock.start(at)
      anchor = false
      return
    }
    let from = clock.tick
    if HexRain.advanceTo(&cols, from, clock.frame(at)) { setNeedsDisplay() }
  }

  private func retype() {
    face = nil
    lines.removeAll()
    setNeedsDisplay()
  }

  // The cell's face by its PostScript name; where it is missing, the system face React Native Text falls back to.
  private func typeface() -> UIFont {
    if let made = face { return made }
    let name = fontName ?? ""
    let made = UIFont(name: name, size: glyphSize) ?? missing(name)
    face = made
    return made
  }

  private func missing(_ name: String) -> UIFont {
    if QNetHexFieldView.warned.insert(name).inserted {
      NSLog("[WARN][FIELD] font_missing name=%@", name)
    }
    return UIFont.systemFont(ofSize: glyphSize)
  }

  private func toneColor(_ tone: Int) -> UIColor? {
    switch tone {
    case 0: return paper
    case 1: return signalPale
    default: return signal
    }
  }

  private func glyphLine(_ glyph: UInt16, _ font: UIFont) -> Line {
    if let made = lines[glyph] { return made }
    let text = NSAttributedString(string: String(decoding: [glyph], as: UTF16.self), attributes: [
      .font: font,
      NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
    ])
    let line = CTLineCreateWithAttributedString(text as CFAttributedString)
    let made = Line(line: line, width: CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
    lines[glyph] = made
    return made
  }

  override func draw(_ rect: CGRect) {
    guard !cols.isEmpty, cellSize > 0, glyphSize > 0, let ctx = UIGraphicsGetCurrentContext() else { return }
    let font = typeface()
    // React Native Text's line box on iOS: the font's own line centred in the cell.
    let baseline = (cellSize - font.lineHeight) / 2 + font.ascender
    let colW = bounds.width / CGFloat(HexRain.COLUMNS)
    let flip = CGAffineTransform(scaleX: 1, y: -1)
    for c in cols {
      // Column 0 at the left edge, or at the right one in a right-to-left layout, where the JS field's row puts it.
      let x = (CGFloat(rtl ? HexRain.COLUMNS - 1 - c.i : c.i) + 0.5) * colW
      for k in 0..<c.len {
        let row = c.head - k
        if row < 0 || CGFloat(row) * cellSize >= bounds.height { continue }
        let o = HexRain.opacity(c, k)
        guard o > 0, let fill = toneColor(HexRain.tone(k)) else { continue }
        let line = glyphLine(c.glyphs[k], font)
        ctx.saveGState()
        ctx.setAlpha(CGFloat(o))
        ctx.setFillColor(fill.cgColor)
        if k == 0, let glow = glowColor {
          ctx.setShadow(offset: .zero, blur: glowRadius, color: glow.cgColor)
        }
        ctx.textMatrix = flip
        ctx.textPosition = CGPoint(x: x - line.width / 2, y: CGFloat(row) * cellSize + baseline)
        CTLineDraw(line.line, ctx)
        ctx.restoreGState()
      }
    }
  }
}

// The display link holds its target strongly; this one holds the view weakly, and a view gone ends its link.
@MainActor
private final class FrameTarget: NSObject {
  private weak var view: QNetHexFieldView?

  init(_ view: QNetHexFieldView) {
    self.view = view
    super.init()
  }

  @objc func frame(_ link: CADisplayLink) {
    guard let view = view else {
      link.invalidate()
      return
    }
    view.onFrame(link)
  }
}

// React Native names the view by this class without "Manager": QNetHexField (QNetHexField.m exports its props).
@objc(QNetHexFieldManager)
final class QNetHexFieldManager: RCTViewManager {
  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func view() -> UIView! {
    return QNetHexFieldView()
  }
}
