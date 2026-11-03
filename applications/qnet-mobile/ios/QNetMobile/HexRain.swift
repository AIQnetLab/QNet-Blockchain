import Foundation

// The live field's plan, steps, shades and clock, ported from src/components/ui/HexField.js line for line with the
// same integer and correctly rounded operations, so the view (HexField.swift) draws the bits that module draws;
// __tests__/HexFieldNative.test.js pins this file to it.
enum HexRain {
  static let GLYPHS: [UInt16] = Array("0123456789abcdef0123456789abcdefｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂ".utf16)
  static let COLUMNS = 10
  static let MIN_TRAIL = 8
  static let MAX_TRAIL = 14
  static let TICK_MS = 33.0
  static let HEAD_FLICKER_PER_S = 12.0
  static let TRAIL_SWAP_PER_CELL_S = 0.65
  static let MAX_CATCH_UP = 8
  static let FADE_FROM = 0.4
  static let PLAN = 0x7fff0000
  static let FLICKER = (HEAD_FLICKER_PER_S * TICK_MS) / 1000
  static let SWAP = (TRAIL_SWAP_PER_CELL_S * TICK_MS) / 1000

  // One column; glyphs[k] is the glyph k cells above the head, one UTF-16 unit per cell.
  struct Column {
    let i, len, every, phase: Int
    let beat, a: Double
    let from, to: Int
    var head: Int
    var glyphs: [UInt16]
  }

  // Math.imul and >>> on UInt32: wrapping products and logical shifts, b's low 32 bits as ToInt32 takes them.
  static func hash(_ a: Int, _ b: Int) -> Double {
    var h = ((UInt32(truncatingIfNeeded: a) ^ 0x9e3779b9) &* 0x85ebca6b) ^ UInt32(truncatingIfNeeded: b)
    h = (h ^ (h >> 16)) &* 0x85ebca6b
    h = (h ^ (h >> 13)) &* 0xc2b2ae35
    return Double(h ^ (h >> 16)) / 4_294_967_296
  }

  static func glyphAt(_ r: Double) -> UInt16 {
    return GLYPHS[Int((r * Double(GLYPHS.count)).rounded(.down))]
  }

  // A glyph other than `was`, so a swap always shows.
  static func another(_ was: UInt16, _ r: Double) -> UInt16 {
    var n = Int((r * Double(GLYPHS.count)).rounded(.down))
    while GLYPHS[n] == was { n = (n + 1) % GLYPHS.count }
    return GLYPHS[n]
  }

  // Math.floor is rounded(.down); Math.round, only ever of a value of at least 0 here, is rounded().
  static func columns(_ rows: Int) -> [Column] {
    var out: [Column] = []
    for i in 0..<COLUMNS {
      func draw(_ n: Int) -> Double { return hash(i, PLAN + n) }
      let len = MIN_TRAIL + Int((draw(0) * Double(MAX_TRAIL - MIN_TRAIL + 1)).rounded(.down))
      let every = 2 + Int((draw(1) * 4).rounded(.down))
      let from = -1 - Int((draw(2) * Double(rows) * 0.6).rounded(.down))
      let head = max(from, Int((draw(3) * Double(rows) * 0.8).rounded()) - 1)
      let glyphs = (0..<len).map { k in glyphAt(draw(10 + k)) }
      let phase = Int((draw(4) * Double(every)).rounded(.down))
      out.append(Column(i: i, len: len, every: every, phase: phase, beat: draw(6), a: 0.45 + draw(5) * 0.55,
                        from: from, to: rows - 1, head: head, glyphs: glyphs))
    }
    return out
  }

  // The column in place at tick t: true exactly where HexField.js's advance returns a new column.
  static func advance(_ c: inout Column, _ t: Int) -> Bool {
    let i = c.i
    let to = c.to
    func roll(_ n: Int) -> Double { return hash(i + (n << 8), t) }
    func inSight(_ row: Int) -> Bool { return row >= 0 && row < to }
    var changed = false
    let beat = Int((Double(t) * FLICKER + c.beat).rounded(.down))
      > Int((Double(t - 1) * FLICKER + c.beat).rounded(.down))
    if (t + c.phase) % c.every == 0 {
      c.head = c.head >= c.to ? c.from : c.head + 1
      // glyphs counts from the head: each glyph keeps its cell, a place further from the moving head; the last leaves.
      let was = c.glyphs[0]
      var k = c.len - 1
      while k > 0 {
        c.glyphs[k] = c.glyphs[k - 1]
        k -= 1
      }
      c.glyphs[0] = another(was, roll(0))
      changed = true
    } else if beat && inSight(c.head) {
      c.glyphs[0] = another(c.glyphs[0], roll(1))
      changed = true
    }
    let lit = inSight(c.head) ? min(c.len - 1, c.head) : 0
    let swaps = Int((Double(lit) * SWAP + roll(2)).rounded(.down))
    var j = 0
    while j < swaps {
      let k = 1 + Int((roll(3 + 2 * j) * Double(lit)).rounded(.down))
      c.glyphs[k] = another(c.glyphs[k], roll(4 + 2 * j))
      changed = true
      j += 1
    }
    return changed
  }

  // Ticks from + 1 to `to` of every column: true when one of them changed a cell.
  static func advanceTo(_ cols: inout [Column], _ from: Int, _ to: Int) -> Bool {
    var changed = false
    var t = from + 1
    while t <= to {
      for n in cols.indices {
        if advance(&cols[n], t) { changed = true }
      }
      t += 1
    }
    return changed
  }

  // The cell k behind the head: 0 Paper (the head), 1 Signal Pale (the next two), 2 Signal (the trail).
  static func tone(_ k: Int) -> Int {
    return k == 0 ? 0 : k < 3 ? 1 : 2
  }

  static func brightness(_ k: Int, _ len: Int) -> Double {
    if k == 0 { return 1.4 }
    if k < 3 { return 1.05 }
    let x = 1 - Double(k) / Double(len)
    return x * x.squareRoot().squareRoot()
  }

  static func opacity(_ c: Column, _ k: Int) -> Double {
    let fade = min(1, max(0, Double(c.to - c.head) / ((1 - FADE_FROM) * Double(c.to + 1))))
    return (min(1, brightness(k, c.len) * c.a) * fade * 100).rounded() / 100
  }

  // HexField.js's clockZero and clockAt on one field's clock, in milliseconds of the display's frame time.
  struct Clock {
    private(set) var tick = 0
    private(set) var zero = 0.0

    // clockZero: the tick the field stood at falls at `at`.
    mutating func start(_ at: Double) {
      zero = at - Double(tick) * TICK_MS
    }

    // clockAt: the ticks due, MAX_CATCH_UP at most past the tick it stood at and never back; tick 0 set again where
    // those bounds held it.
    mutating func frame(_ at: Double) -> Int {
      let due = Int(((at - zero) / TICK_MS).rounded(.down))
      let to = min(max(due, tick), tick + MAX_CATCH_UP)
      if to != due { zero = at - Double(to) * TICK_MS }
      tick = to
      return to
    }
  }
}
