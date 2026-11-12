package com.openbone.android

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Shader
import android.graphics.Typeface
import com.openbone.runtime.DrawItem
import com.openbone.runtime.data.FontAsset
import com.openbone.runtime.data.OpenBoneDocument
import java.io.File
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Draws an OpenBone draw list on an Android [Canvas]: textured triangles (`drawVertices`), the two-colour tint as a
 * per-item colour matrix (`dark + (light − dark) × texture`), blend modes, clipping masks (`clipPath`), particles
 * (per-vertex colours), shape strokes and text.
 *
 * Text walks its CSS family list ("Brand Sans, Georgia, serif"): a family the document carries (`doc.fonts`, read
 * through [fonts]; of several, the one whose weight is closest) wins, then an installed family, then the default
 * typeface. Document fonts are written to temporary files in [fontDir] (default: the system temp folder) once, as
 * `Typeface.createFromFile` needs a file.
 */
class CanvasRenderer(
  private val doc: OpenBoneDocument,
  private val images: ImageSource,
  private val fonts: FontSource = FontSource.embedded,
  private val fontDir: File? = null,
) {
  private val docTypefaces = HashMap<String, Typeface?>()
  private val fontFiles = ArrayList<File>()
  private val familyTypefaces = HashMap<String, Typeface>()
  private val bitmaps = HashMap<String, Bitmap?>()
  private val shaders = HashMap<String, BitmapShader>()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
  private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val colorMatrix = ColorMatrix()
  private var verts = FloatArray(0)
  private var texs = FloatArray(0)
  private var colors = IntArray(0)
  private var idx = ShortArray(0)

  private val dot: Bitmap by lazy {
    val n = DrawItem.PARTICLE_DOT_SIZE
    val px = IntArray(n * n)
    for (y in 0 until n) for (x in 0 until n) {
      val dx = (x + 0.5) / n * 2 - 1
      val dy = (y + 0.5) / n * 2 - 1
      val a = (DrawItem.particleDotAlpha(sqrt(dx * dx + dy * dy)) * 255).roundToInt()
      px[y * n + x] = Color.argb(a, 255, 255, 255)
    }
    Bitmap.createBitmap(px, n, n, Bitmap.Config.ARGB_8888)
  }

  private fun premultipliedPage(id: String): Boolean =
    doc.atlas?.let { a -> a.premultipliedAlpha && a.pages.any { it.id == id } } ?: false

  /** The bitmap for a texture id (cached), or null if it cannot be loaded. */
  fun bitmap(ref: DrawItem.TextureRef?): Bitmap? {
    ref ?: return null
    if (ref.id == DrawItem.PARTICLE_DOT_TEXTURE) return dot
    return bitmaps.getOrPut(ref.id) {
      val src = doc.images.firstOrNull { it.id == ref.id }?.src ?: doc.atlas?.pages?.firstOrNull { it.id == ref.id }?.src
      val bmp = src?.let { runCatching { images.load(it) }.getOrNull() }
      if (bmp != null && premultipliedPage(ref.id)) unpremultiply(bmp) else bmp
    }
  }

  /** Atlas pages packed with premultiplied alpha: Android bitmaps premultiply on their own, so undo it once. */
  private fun unpremultiply(b: Bitmap): Bitmap {
    val w = b.width
    val h = b.height
    val px = IntArray(w * h)
    b.getPixels(px, 0, w, 0, 0, w, h)
    for (i in px.indices) {
      val c = px[i]
      val a = c ushr 24
      if (a in 1..254) {
        val r = minOf(255, Color.red(c) * 255 / a)
        val g = minOf(255, Color.green(c) * 255 / a)
        val bl = minOf(255, Color.blue(c) * 255 / a)
        px[i] = Color.argb(a, r, g, bl)
      }
    }
    return Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
  }

  private fun shader(ref: DrawItem.TextureRef, bmp: Bitmap): BitmapShader =
    shaders.getOrPut(ref.id) { BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }

  private fun xfer(blend: String) = when (blend) {
    "additive" -> PorterDuffXfermode(PorterDuff.Mode.ADD)
    "multiply" -> PorterDuffXfermode(PorterDuff.Mode.MULTIPLY)
    "screen" -> PorterDuffXfermode(PorterDuff.Mode.SCREEN)
    else -> null
  }

  /** Draw [items] with [toView] mapping skeleton space (y up) to canvas pixels. */
  fun draw(canvas: Canvas, items: List<DrawItem>, toView: Matrix) {
    canvas.save()
    canvas.concat(toView)
    var clip: DrawItem.ClipRegion? = null
    var clipSave = -1
    for (it in items) {
      if (it.clip !== clip) {
        if (clipSave >= 0) canvas.restoreToCount(clipSave)
        clipSave = -1
        clip = it.clip
        clip?.let { c ->
          clipSave = canvas.save()
          polygon(c.polygon)
          canvas.clipPath(path)
        }
      }
      when {
        it.text != null -> drawText(canvas, it)
        else -> drawGeometry(canvas, it)
      }
      it.stroke?.let { s ->
        if (s.color[3] > 0) {
          polygon(s.outline)
          strokePaint.color = argb(s.color)
          strokePaint.strokeWidth = s.width.toFloat()
          strokePaint.xfermode = xfer(it.blend)
          canvas.drawPath(path, strokePaint)
        }
      }
    }
    if (clipSave >= 0) canvas.restoreToCount(clipSave)
    canvas.restore()
  }

  private fun polygon(p: DoubleArray) {
    path.reset()
    var i = 0
    while (i + 1 < p.size) {
      if (i == 0) path.moveTo(p[0].toFloat(), p[1].toFloat()) else path.lineTo(p[i].toFloat(), p[i + 1].toFloat())
      i += 2
    }
    path.close()
  }

  private fun drawGeometry(canvas: Canvas, it: DrawItem) {
    val shape = it.attachment.type == "shape"
    val bmp = bitmap(it.texture)
    if (bmp == null && !shape && it.particleLook == null) return // missing image
    val n = it.vertices.size / 2
    if (verts.size < n * 2) {
      verts = FloatArray(n * 2)
      texs = FloatArray(n * 2)
      colors = IntArray(n)
    }
    if (idx.size < it.indices.size) idx = ShortArray(it.indices.size)
    for (i in 0 until n * 2) verts[i] = it.vertices[i].toFloat()
    for (i in it.indices.indices) idx[i] = it.indices[i].toShort()
    paint.reset()
    paint.isAntiAlias = true
    paint.isFilterBitmap = true
    paint.xfermode = xfer(it.blend)
    val tex = it.texture
    if (bmp != null && tex != null && !shape) {
      paint.shader = shader(tex, bmp)
      val w = bmp.width.toFloat()
      val h = bmp.height.toFloat()
      for (i in 0 until n) {
        texs[i * 2] = it.uvs[i * 2].toFloat() * w
        texs[i * 2 + 1] = it.uvs[i * 2 + 1].toFloat() * h
      }
    }
    val cs = it.colors
    if (cs != null) {
      // Particles: per-vertex colours modulate the texture (or are the fill for untextured squares).
      for (i in 0 until n) colors[i] = argb(cs[i * 4], cs[i * 4 + 1], cs[i * 4 + 2], cs[i * 4 + 3])
      canvas.drawVertices(Canvas.VertexMode.TRIANGLES, n * 2, verts, 0, if (paint.shader != null) texs else null, 0, colors, 0, idx, 0, it.indices.size, paint)
      return
    }
    val c = it.color
    if (paint.shader == null) {
      // Solid fill (shapes): every vertex the item colour.
      val col = argb(c)
      for (i in 0 until n) colors[i] = col
      canvas.drawVertices(Canvas.VertexMode.TRIANGLES, n * 2, verts, 0, null, 0, colors, 0, idx, 0, it.indices.size, paint)
      return
    }
    // Two-colour tint as a colour matrix on the texture: rgb' = dark + (light − dark) × rgb, a' = a × light.a.
    val d = it.dark
    val dr = (d?.get(0) ?: 0.0).toFloat()
    val dg = (d?.get(1) ?: 0.0).toFloat()
    val db = (d?.get(2) ?: 0.0).toFloat()
    colorMatrix.set(
      floatArrayOf(
        c[0].toFloat() - dr, 0f, 0f, 0f, dr * 255,
        0f, c[1].toFloat() - dg, 0f, 0f, dg * 255,
        0f, 0f, c[2].toFloat() - db, 0f, db * 255,
        0f, 0f, 0f, c[3].toFloat(), 0f,
      ),
    )
    paint.colorFilter = ColorMatrixColorFilter(colorMatrix)
    canvas.drawVertices(Canvas.VertexMode.TRIANGLES, n * 2, verts, 0, texs, 0, null, 0, idx, 0, it.indices.size, paint)
  }

  private fun drawText(canvas: Canvas, it: DrawItem) {
    val t = it.text
    if (t.content.isEmpty()) return
    val m = t.matrix
    val mx = Matrix()
    // Box frame (origin at the box centre, y up) → skeleton space, then flip so text draws upright.
    mx.setValues(floatArrayOf(m.a.toFloat(), m.b.toFloat(), m.x.toFloat(), m.c.toFloat(), m.d.toFloat(), m.y.toFloat(), 0f, 0f, 1f))
    canvas.save()
    canvas.concat(mx)
    canvas.scale(1f, -1f)
    textPaint.reset()
    textPaint.isAntiAlias = true
    textPaint.textSize = t.size.toFloat()
    textPaint.typeface = typeface(t.font, t.weight)
    textPaint.textAlign = when (t.align) {
      "left" -> Paint.Align.LEFT
      "right" -> Paint.Align.RIGHT
      else -> Paint.Align.CENTER
    }
    textPaint.xfermode = xfer(it.blend)
    val x = when (t.align) {
      "left" -> (-t.width / 2).toFloat()
      "right" -> (t.width / 2).toFloat()
      else -> 0f
    }
    val lines = t.content.split("\n")
    val lh = t.size.toFloat() * 1.2f
    val y0 = -(lines.size - 1) * lh / 2
    val fm = textPaint.fontMetrics
    val mid = -(fm.ascent + fm.descent) / 2
    val tint = it.color
    t.outline?.let { o ->
      if (t.outlineWidth > 0) {
        textPaint.style = Paint.Style.STROKE
        textPaint.strokeJoin = Paint.Join.ROUND
        textPaint.strokeWidth = (t.outlineWidth * 2).toFloat()
        textPaint.color = argb(o[0] * tint[0], o[1] * tint[1], o[2] * tint[2], o[3] * tint[3])
        lines.forEachIndexed { i, l -> canvas.drawText(l, x, y0 + i * lh + mid, textPaint) }
      }
    }
    textPaint.style = Paint.Style.FILL
    val f = t.fill
    textPaint.color = argb(f[0] * tint[0], f[1] * tint[1], f[2] * tint[2], f[3] * tint[3])
    lines.forEachIndexed { i, l -> canvas.drawText(l, x, y0 + i * lh + mid, textPaint) }
    canvas.restore()
  }

  /** The typeface for a text's family list and weight (cached). */
  fun typeface(families: String, weight: Double): Typeface = familyTypefaces.getOrPut("$weight|$families") {
    val bold = weight >= 600
    val style = if (bold) Typeface.BOLD else Typeface.NORMAL
    for (fam in splitFamilies(families)) {
      doc.findFont(fam, weight)?.let { f ->
        val tf = documentTypeface(f) ?: return@let
        // Like the browser: a regular-weight file drawn bold is emboldened.
        return@getOrPut if (bold && f.weight < 600) Typeface.create(tf, Typeface.BOLD) else tf
      }
      installed(fam, style)?.let { return@getOrPut it }
    }
    Typeface.create(Typeface.DEFAULT, style)
  }

  private fun documentTypeface(f: FontAsset): Typeface? = docTypefaces.getOrPut(f.id) {
    runCatching {
      val bytes = fonts.load(f.src) ?: return@runCatching null
      val ext = if (f.src.startsWith("data:font/otf") || f.src.endsWith(".otf", ignoreCase = true)) ".otf" else ".ttf"
      val file = File.createTempFile("openbone-font", ext, fontDir)
      file.deleteOnExit()
      fontFiles += file
      file.writeBytes(bytes)
      Typeface.createFromFile(file)
    }.getOrNull()
  }

  /** Forget cached bitmaps (they are recycled) and typefaces (their temporary files are deleted). */
  fun release() {
    bitmaps.values.forEach { it?.recycle() }
    bitmaps.clear()
    shaders.clear()
    familyTypefaces.clear()
    docTypefaces.clear()
    fontFiles.forEach { it.delete() }
    fontFiles.clear()
  }

  private companion object {
    val GENERIC = setOf("serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace")

    fun splitFamilies(families: String?): List<String> =
      families.orEmpty().split(",").map { it.trim().removeSurrounding("\"").removeSurrounding("'") }.filter { it.isNotEmpty() }

    /** An installed family, or null when Android doesn't have it (it would quietly give the default typeface). */
    fun installed(family: String, style: Int): Typeface? {
      val fam = family.lowercase()
      val name = when (fam) {
        "system-ui", "ui-sans-serif" -> "sans-serif"
        "ui-serif" -> "serif"
        "ui-monospace" -> "monospace"
        else -> fam
      }
      val tf = Typeface.create(name, style)
      if (fam in GENERIC) return tf
      return tf.takeUnless { it === Typeface.create(null as Typeface?, style) || it === Typeface.create(Typeface.DEFAULT, style) }
    }

    fun ch(v: Double) = (v.coerceIn(0.0, 1.0) * 255).roundToInt()
    fun argb(r: Double, g: Double, b: Double, a: Double) = Color.argb(ch(a), ch(r), ch(g), ch(b))
    fun argb(c: DoubleArray) = argb(c[0], c[1], c[2], c[3])
  }
}
