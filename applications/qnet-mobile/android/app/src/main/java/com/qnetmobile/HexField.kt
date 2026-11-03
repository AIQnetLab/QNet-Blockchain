package com.qnetmobile

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.view.Choreographer
import android.view.View
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.ceil

/**
 * The live field of the welcome and lock screens (src/components/ui/HexField.js) on this view's Canvas: each frame of
 * the display takes the ticks due on the field's clock (HexRain) and draws again only when one of them changed a cell,
 * so nothing of the field crosses to JS while it runs. A cell is drawn as React Native's Text draws it there.
 */
class HexFieldView(context: Context) : View(context), Choreographer.FrameCallback {
    private var rows = 0
    private var cols: Array<HexRain.Column> = emptyArray()
    private var clock = HexRain.Clock()
    // The first frame after a start sets tick 0 so that the tick the field stood at falls then.
    private var anchor = true
    private var shown = false
    private var running = false
    private val tones = IntArray(3)
    private var cellPx = 0f
    private var baseline = 0f
    private val trail = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    private val lead = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }

    var live = false
        set(value) {
            field = value
            run()
        }

    // Column 0 at the right edge, where the module's row of columns puts it right to left.
    var rtl = false
        set(value) {
            field = value
            invalidate()
        }

    var glowColor = Color.TRANSPARENT
        set(value) {
            field = value
            glow()
        }

    var glowRadius = 0f
        set(value) {
            field = value
            glow()
        }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun plan(rows: Int) {
        if (rows == this.rows) return
        this.rows = rows
        cols = if (rows > 1) HexRain.columns(rows) else emptyArray()
        clock = HexRain.Clock()
        anchor = true
        invalidate()
        run()
    }

    fun setTone(at: Int, color: Int) {
        tones[at] = color
        invalidate()
    }

    fun setFace(face: Typeface) {
        trail.typeface = face
        lead.typeface = face
        metrics()
    }

    // Whole pixels, rounded up, as Text sets its size.
    fun setGlyphPx(px: Float) {
        trail.textSize = ceil(px)
        lead.textSize = ceil(px)
        metrics()
    }

    fun setCellPx(px: Float) {
        cellPx = px
        metrics()
    }

    // Text's shadow: the radius in raw pixels, and an opaque colour that takes the paint's alpha.
    private fun glow() {
        lead.setShadowLayer(glowRadius, 0f, 0f, glowColor)
        invalidate()
    }

    // The baseline in a cell where Text's line height puts it: half the leading over the face's ascent, rounded up.
    private fun metrics() {
        val fm = trail.fontMetricsInt
        val leading = ceil(cellPx).toInt() - (-fm.ascent + fm.descent)
        baseline = (-fm.ascent + ceil(leading / 2.0).toInt()).toFloat()
        invalidate()
    }

    // The one rule for the clock: it runs while the field is live, shown and planned.
    private fun run() {
        val want = live && shown && cols.isNotEmpty()
        if (want == running) return
        running = want
        if (want) {
            anchor = true
            Choreographer.getInstance().postFrameCallback(this)
        } else {
            Choreographer.getInstance().removeFrameCallback(this)
        }
    }

    // Attached, visible with its ancestors, and in a window on screen (not one gone to the background).
    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        shown = isVisible
        run()
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        val at = frameTimeNanos / 1_000_000.0
        if (anchor) {
            clock.start(at)
            anchor = false
        } else {
            val from = clock.tick
            if (HexRain.advanceTo(cols, from, clock.frame(at))) invalidate()
        }
        Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onDraw(canvas: Canvas) {
        val colW = width / HexRain.COLUMNS.toFloat()
        for (c in cols) {
            val x = ((if (rtl) HexRain.COLUMNS - 1 - c.i else c.i) + 0.5f) * colW
            for (k in 0 until c.len) {
                val row = c.head - k
                if (row < 0 || row * cellPx >= height) continue
                val o = HexRain.opacity(c, k)
                if (o <= 0) continue
                val p = if (k == 0) lead else trail
                val tone = tones[HexRain.tone(k)]
                p.color = tone
                p.alpha = Math.round(o * Color.alpha(tone)).toInt()
                canvas.drawText(c.glyphs, k, 1, x, Math.round(row * cellPx) + baseline, p)
            }
        }
    }
}

/** QNetHexField: the live field's view, with the props HexField.js passes (colours as colours, sizes in dp). */
class HexFieldManager : SimpleViewManager<HexFieldView>() {
    override fun getName(): String = "QNetHexField"

    override fun createViewInstance(reactContext: ThemedReactContext): HexFieldView = HexFieldView(reactContext)

    @ReactProp(name = "rows")
    fun setRows(view: HexFieldView, rows: Int) = view.plan(rows)

    @ReactProp(name = "live")
    fun setLive(view: HexFieldView, live: Boolean) {
        view.live = live
    }

    @ReactProp(name = "rtl")
    fun setRtl(view: HexFieldView, rtl: Boolean) {
        view.rtl = rtl
    }

    @ReactProp(name = "paper", customType = "Color")
    fun setPaper(view: HexFieldView, color: Int?) = view.setTone(0, color ?: Color.TRANSPARENT)

    @ReactProp(name = "signalPale", customType = "Color")
    fun setSignalPale(view: HexFieldView, color: Int?) = view.setTone(1, color ?: Color.TRANSPARENT)

    @ReactProp(name = "signal", customType = "Color")
    fun setSignal(view: HexFieldView, color: Int?) = view.setTone(2, color ?: Color.TRANSPARENT)

    @ReactProp(name = "glowColor", customType = "Color")
    fun setGlowColor(view: HexFieldView, color: Int?) {
        view.glowColor = color ?: Color.TRANSPARENT
    }

    @ReactProp(name = "glowRadius")
    fun setGlowRadius(view: HexFieldView, radius: Float) {
        view.glowRadius = radius
    }

    @ReactProp(name = "cellSize")
    fun setCellSize(view: HexFieldView, dp: Float) = view.setCellPx(PixelUtil.toPixelFromDIP(dp))

    @ReactProp(name = "glyphSize")
    fun setGlyphSize(view: HexFieldView, dp: Float) = view.setGlyphPx(PixelUtil.toPixelFromDIP(dp))

    // The face every Text of that name draws with, read once from the app's fonts folder.
    @ReactProp(name = "fontName")
    fun setFontName(view: HexFieldView, name: String?) = view.setFace(
        if (name == null) Typeface.DEFAULT
        else ReactFontManager.getInstance().getTypeface(name, Typeface.NORMAL, view.context.assets),
    )
}
