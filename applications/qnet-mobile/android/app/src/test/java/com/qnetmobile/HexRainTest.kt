package com.qnetmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

// HexRain against the vectors written from src/components/ui/HexField.js (__tests__/HexFieldNative.test.js): the same
// constants, draws, plan, 400 ticks of two field heights, shades and clock, bit for bit.
class HexRainTest {
    private companion object {
        val vectors = Json(File("../../__tests__/fixtures/hex_field_vectors.json").readText()).read() as Map<*, *>
        val TONES = listOf("paper", "signalPale", "signal")
    }

    private fun list(v: Any?) = v as List<*>
    private fun map(v: Any?) = v as Map<*, *>
    private fun num(v: Any?) = v as Double
    private fun int(v: Any?) = (v as Double).toInt()
    private fun str(v: Any?) = v as String
    private fun fields() = list(vectors["fields"]).map { map(it) }

    // Equal to the last bit (a zero's sign aside, which JSON does not keep).
    private fun same(what: String, want: Double, got: Double) = assertEquals(what, want, got, 0.0)

    @Test
    fun theConstantsAreTheJsModulesOwn() {
        val c = map(vectors["constants"])
        assertEquals(str(c["GLYPHS"]), HexRain.GLYPHS)
        assertEquals(
            listOf(c["COLUMNS"], c["MIN_TRAIL"], c["MAX_TRAIL"], c["MAX_CATCH_UP"], c["PLAN"]).map { int(it) },
            listOf(HexRain.COLUMNS, HexRain.MIN_TRAIL, HexRain.MAX_TRAIL, HexRain.MAX_CATCH_UP.toInt(), HexRain.PLAN),
        )
        same("TICK_MS", num(c["TICK_MS"]), HexRain.TICK_MS)
        same("HEAD_FLICKER_PER_S", num(c["HEAD_FLICKER_PER_S"]), HexRain.HEAD_FLICKER_PER_S)
        same("TRAIL_SWAP_PER_CELL_S", num(c["TRAIL_SWAP_PER_CELL_S"]), HexRain.TRAIL_SWAP_PER_CELL_S)
        same("FADE_FROM", num(c["FADE_FROM"]), HexRain.FADE_FROM)
    }

    @Test
    fun theHashAndTheGlyphDrawsAreTheJsOnesBitForBit() {
        for (v in list(vectors["hash"])) {
            val (a, b, r) = list(v)
            // An operand past int32 keeps its low 32 bits, as JS takes an operand of ^.
            same("hash($a, $b)", num(r), HexRain.hash(int(a), num(b).toLong().toInt()))
        }
        for (v in list(vectors["glyphAt"])) {
            val (r, g) = list(v)
            assertEquals("glyphAt($r)", str(g)[0], HexRain.glyphAt(num(r)))
        }
        for (v in list(vectors["another"])) {
            val (was, r, g) = list(v)
            assertEquals("another($was, $r)", str(g)[0], HexRain.another(str(was)[0], num(r)))
        }
        for (v in list(vectors["brightness"])) {
            val (len, k, b) = list(v)
            same("brightness($k, $len)", num(b), HexRain.brightness(int(k), int(len)))
        }
    }

    @Test
    fun bothFieldHeightsPlanEveryColumnAsTheJsDoes() {
        for (field in fields()) {
            val rows = int(field["rows"])
            val want = list(field["columns"]).map { map(it) }
            val cols = HexRain.columns(rows)
            assertEquals(want.size, cols.size)
            for ((i, w) in want.withIndex()) {
                val c = cols[i]
                val at = "rows $rows column $i"
                assertEquals(
                    at,
                    listOf(w["i"], w["len"], w["every"], w["phase"], w["from"], w["to"], w["head"]).map { int(it) },
                    listOf(c.i, c.len, c.every, c.phase, c.from, c.to, c.head),
                )
                same("$at beat", num(w["beat"]), c.beat)
                same("$at a", num(w["a"]), c.a)
                assertEquals("$at glyphs", str(w["glyphs"]), String(c.glyphs))
            }
        }
    }

    @Test
    fun fourHundredTicksStepFlickerAndSwapAsTheJsDoesAndSayWhatChanged() {
        for (field in fields()) {
            val rows = int(field["rows"])
            val after = list(field["after"]).map { map(it) }
            val cols = HexRain.columns(rows)
            for ((n, want) in after.withIndex()) {
                val t = n + 1L
                var changed = 0
                for (c in cols) if (HexRain.advance(c, t)) changed = changed or (1 shl c.i)
                assertEquals("rows $rows tick $t changed", int(want["changed"]), changed)
                assertEquals("rows $rows tick $t heads", list(want["head"]).map { int(it) }, cols.map { it.head })
                assertEquals("rows $rows tick $t glyphs", list(want["glyphs"]), cols.map { String(it.glyphs) })
            }
            // The same ticks, MAX_CATCH_UP at a time, as a late frame takes them.
            val late = HexRain.columns(rows)
            var from = 0L
            while (from < after.size) {
                val to = minOf(from + HexRain.MAX_CATCH_UP, after.size.toLong())
                val at = "rows $rows ticks ${from + 1}..$to"
                val changed = (from until to).any { int(after[it.toInt()]["changed"]) != 0 }
                assertEquals(at, changed, HexRain.advanceTo(late, from, to))
                val last = after[(to - 1).toInt()]
                assertEquals("$at heads", list(last["head"]).map { int(it) }, late.map { it.head })
                assertEquals("$at glyphs", list(last["glyphs"]), late.map { String(it.glyphs) })
                from = to
            }
        }
    }

    @Test
    fun everyCellIsShadedAsTheJsShadesIt() {
        for (field in fields()) {
            val rows = int(field["rows"])
            val plan = HexRain.columns(rows)
            for (s in list(field["shade"]).map { map(it) }) {
                val c = plan[int(s["column"])]
                c.head = int(s["head"])
                val cells = list(s["cells"])
                assertEquals(c.len, cells.size)
                for ((k, cell) in cells.withIndex()) {
                    val (tone, opacity) = list(cell)
                    val at = "rows $rows column ${c.i} head ${c.head} k $k"
                    assertEquals(at, tone, TONES[HexRain.tone(k)])
                    same(at, num(opacity), HexRain.opacity(c, k))
                }
            }
        }
    }

    @Test
    fun theClockTakesTheTicksTheJsClockTakes() {
        for ((n, s) in list(vectors["clock"]).map { map(it) }.withIndex()) {
            val clock = HexRain.Clock()
            val after = list(s["after"])
            for ((j, e) in list(s["events"]).withIndex()) {
                val (kind, at) = list(e)
                if (kind == "start") clock.start(num(at)) else assertEquals(clock.frame(num(at)), clock.tick)
                val (tick, zero) = list(after[j])
                assertEquals("sequence $n event $j", int(tick).toLong(), clock.tick)
                same("sequence $n event $j", num(zero), clock.zero)
            }
        }
    }
}

// A reader for the vectors file: org.json is a stub in local unit tests, and the test needs no library of its own.
private class Json(private val s: String) {
    private var at = 0

    fun read(): Any? {
        val v = value()
        space()
        check(at == s.length) { "text after the value at $at" }
        return v
    }

    private fun space() {
        while (at < s.length && s[at].isWhitespace()) at++
    }

    private fun value(): Any? {
        space()
        return when (val ch = s[at]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", null)
            else -> if (ch == '-' || ch.isDigit()) num() else error("unexpected '$ch' at $at")
        }
    }

    private fun word(w: String, v: Any?): Any? {
        check(s.startsWith(w, at)) { "expected $w at $at" }
        at += w.length
        return v
    }

    private fun obj(): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        at++
        space()
        if (s[at] == '}') {
            at++
            return out
        }
        while (true) {
            space()
            val key = str()
            space()
            check(s[at++] == ':') { "expected : at ${at - 1}" }
            out[key] = value()
            space()
            when (s[at++]) {
                ',' -> continue
                '}' -> return out
                else -> error("expected , or } at ${at - 1}")
            }
        }
    }

    private fun arr(): List<Any?> {
        val out = ArrayList<Any?>()
        at++
        space()
        if (s[at] == ']') {
            at++
            return out
        }
        while (true) {
            out.add(value())
            space()
            when (s[at++]) {
                ',' -> continue
                ']' -> return out
                else -> error("expected , or ] at ${at - 1}")
            }
        }
    }

    private fun str(): String {
        check(s[at++] == '"') { "expected a string at ${at - 1}" }
        val out = StringBuilder()
        while (true) {
            when (val ch = s[at++]) {
                '"' -> return out.toString()
                '\\' -> when (val e = s[at++]) {
                    '"', '\\', '/' -> out.append(e)
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000c')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(Char(s.substring(at, at + 4).toInt(16)))
                        at += 4
                    }
                    else -> error("bad escape \\$e at ${at - 1}")
                }
                else -> out.append(ch)
            }
        }
    }

    private fun num(): Double {
        val start = at
        while (at < s.length && (s[at].isDigit() || s[at] in "+-.eE")) at++
        return s.substring(start, at).toDouble()
    }
}
