package com.qnetmobile

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The live field's steps (src/components/ui/HexField.js) ported operation for operation: its hash, plan, steps, shades
 * and clock give the same bits here as there, which HexRainTest proves against the vectors written from the module
 * (__tests__/fixtures/hex_field_vectors.json). Only integer and correctly rounded floating-point operations.
 */
internal object HexRain {
    const val GLYPHS = "0123456789abcdef0123456789abcdefｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂ"
    const val COLUMNS = 10
    const val MIN_TRAIL = 8
    const val MAX_TRAIL = 14
    const val TICK_MS = 33.0
    const val HEAD_FLICKER_PER_S = 12.0
    const val TRAIL_SWAP_PER_CELL_S = 0.65
    const val MAX_CATCH_UP = 8L
    const val FADE_FROM = 0.4
    const val PLAN = 0x7fff0000
    private const val FLICKER = (HEAD_FLICKER_PER_S * TICK_MS) / 1000
    private const val SWAP = (TRAIL_SWAP_PER_CELL_S * TICK_MS) / 1000

    /** A column: its plan, and its head row and glyphs as they stand (`glyphs[k]`, the glyph k cells above the head). */
    class Column(
        val i: Int,
        val len: Int,
        val every: Int,
        val phase: Int,
        val beat: Double,
        val a: Double,
        val from: Int,
        val to: Int,
        var head: Int,
        val glyphs: CharArray,
    )

    // Int products wrap as Math.imul does, and ushr is >>>.
    fun hash(a: Int, b: Int): Double {
        var h = ((a xor 0x9e3779b9.toInt()) * 0x85ebca6b.toInt()) xor b
        h = (h xor (h ushr 16)) * 0x85ebca6b.toInt()
        h = (h xor (h ushr 13)) * 0xc2b2ae35.toInt()
        return ((h xor (h ushr 16)).toLong() and 0xffffffffL) / 4294967296.0
    }

    fun glyphAt(r: Double): Char = GLYPHS[floor(r * GLYPHS.length).toInt()]

    fun another(was: Char, r: Double): Char {
        var n = floor(r * GLYPHS.length).toInt()
        while (GLYPHS[n] == was) n = (n + 1) % GLYPHS.length
        return GLYPHS[n]
    }

    // Math.round rounds ties up as the module's does (kotlin.math.round would round them to even).
    fun columns(rows: Int): Array<Column> = Array(COLUMNS) { i ->
        val draw = { n: Int -> hash(i, PLAN + n) }
        val len = MIN_TRAIL + floor(draw(0) * (MAX_TRAIL - MIN_TRAIL + 1)).toInt()
        val every = 2 + floor(draw(1) * 4).toInt()
        val from = -1 - floor(draw(2) * rows * 0.6).toInt()
        val head = max(from, Math.round(draw(3) * rows * 0.8).toInt() - 1)
        val glyphs = CharArray(len) { k -> glyphAt(draw(10 + k)) }
        val phase = floor(draw(4) * every).toInt()
        Column(i, len, every, phase, draw(6), 0.45 + draw(5) * 0.55, from, rows - 1, head, glyphs)
    }

    private fun inSight(c: Column, row: Int) = row >= 0 && row < c.to

    // The draw n of column c at tick t, which the module's hash takes as an int32.
    private fun roll(c: Column, n: Int, t: Int) = hash(c.i + (n shl 8), t)

    /** Column `c` at tick `t`, changed in place: true exactly where the module's advance returns a new column. */
    fun advance(c: Column, t: Long): Boolean {
        val tick = t.toInt()
        val g = c.glyphs
        val beat = floor(t * FLICKER + c.beat) > floor((t - 1) * FLICKER + c.beat)
        var changed = false
        if ((t + c.phase) % c.every == 0L) {
            c.head = if (c.head >= c.to) c.from else c.head + 1
            val was = g[0]
            System.arraycopy(g, 0, g, 1, c.len - 1)
            g[0] = another(was, roll(c, 0, tick))
            changed = true
        } else if (beat && inSight(c, c.head)) {
            g[0] = another(g[0], roll(c, 1, tick))
            changed = true
        }
        val lit = if (inSight(c, c.head)) min(c.len - 1, c.head) else 0
        val swaps = floor(lit * SWAP + roll(c, 2, tick)).toInt()
        for (j in 0 until swaps) {
            val k = 1 + floor(roll(c, 3 + 2 * j, tick) * lit).toInt()
            g[k] = another(g[k], roll(c, 4 + 2 * j, tick))
        }
        return changed || swaps > 0
    }

    /** Ticks `from + 1` to `to` of every column: true when any of them changed a column. */
    fun advanceTo(cols: Array<Column>, from: Long, to: Long): Boolean {
        var changed = false
        for (t in from + 1..to) {
            for (c in cols) {
                if (advance(c, t)) changed = true
            }
        }
        return changed
    }

    /** The cell k behind the head: 0 Paper, 1 Signal Pale, 2 Signal. */
    fun tone(k: Int): Int = if (k == 0) 0 else if (k < 3) 1 else 2

    fun brightness(k: Int, len: Int): Double {
        if (k == 0) return 1.4
        if (k < 3) return 1.05
        val x = 1 - k.toDouble() / len
        return x * Math.sqrt(Math.sqrt(x))
    }

    fun opacity(c: Column, k: Int): Double {
        val fade = min(1.0, max(0.0, (c.to - c.head) / ((1 - FADE_FROM) * (c.to + 1))))
        return Math.round(min(1.0, brightness(k, c.len) * c.a) * fade * 100) / 100.0
    }

    /** The field's clock on a frame's time in ms: the module's clockZero (start) and clockAt (frame). */
    class Clock {
        var tick = 0L
            private set
        var zero = 0.0
            private set

        fun start(at: Double) {
            zero = at - tick * TICK_MS
        }

        fun frame(at: Double): Long {
            val due = floor((at - zero) / TICK_MS).toLong()
            val to = min(max(due, tick), tick + MAX_CATCH_UP)
            if (to != due) zero = at - to * TICK_MS
            tick = to
            return to
        }
    }
}
