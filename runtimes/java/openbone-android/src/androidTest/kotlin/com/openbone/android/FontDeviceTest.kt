package com.openbone.android

import android.graphics.Paint
import android.graphics.Typeface
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.openbone.runtime.data.DocumentLoader
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith

/** Document fonts become typefaces: embedded (data:) and relative paths, matched by family and closest weight. */
@RunWith(AndroidJUnit4::class)
class FontDeviceTest {
  private val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir

  private fun width(tf: Typeface, s: String) = Paint().apply { typeface = tf; textSize = 40f }.measureText(s)

  @Test
  fun documentFontsAreUsed() {
    // A monospaced system font embedded under a made-up family, and a serif bold one next to the document.
    val mono = File("/system/fonts/DroidSansMono.ttf").readBytes()
    val dir = File(cache, "fonttest").apply { mkdirs() }
    File("/system/fonts/NotoSerif-Bold.ttf").copyTo(File(dir, "serif-bold.ttf"), overwrite = true)
    val doc = DocumentLoader.fromJson(
      """{"format":"openbone","version":1,"fonts":[
        {"id":"f1","name":"Mono","family":"Zorblax Display","src":"data:font/ttf;base64,${Base64.encodeToString(mono, Base64.NO_WRAP)}"},
        {"id":"f2","name":"Bold","family":"Zorblax Display","src":"serif-bold.ttf","weight":700}]}""",
    )
    val r = CanvasRenderer(doc, ImageSource.embedded, FontSource.files(dir), cache)
    val regular = r.typeface("Zorblax Display, sans-serif", 400.0)
    // Monospaced: narrow and wide letters take the same room, which no default typeface does.
    assertEquals(width(regular, "iiii"), width(regular, "MMMM"), 0.01f)
    val fallback = r.typeface("Nope Family, sans-serif", 400.0)
    assertNotEquals(width(fallback, "iiii"), width(fallback, "MMMM"), 0.01f)
    // Weight 700 picks the bold file (any case, quoted), not the regular one.
    val bold = r.typeface("'zorblax display'", 700.0)
    assertNotEquals(width(regular, "Hello"), width(bold, "Hello"), 0.01f)
    assertSame(bold, r.typeface("'zorblax display'", 700.0))
    assertEquals(width(bold, "Hello"), width(Typeface.createFromFile(File(dir, "serif-bold.ttf")), "Hello"), 0.01f)
    r.release()
  }
}
