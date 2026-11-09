package com.openbone.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.openbone.conformance.ConformanceRunner
import com.openbone.runtime.FiredEvent
import com.openbone.runtime.Json
import com.openbone.runtime.data.DocumentLoader
import com.openbone.scripting.QuickJsScriptHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The conformance suite and the view, on a real Android runtime (ART + QuickJS for Android). */
@RunWith(AndroidJUnit4::class)
class DeviceConformanceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val assets = instrumentation.context.assets

  private fun bytes(path: String) = assets.open(path).use { it.readBytes() }

  @Test
  @Suppress("UNCHECKED_CAST")
  fun everyConformanceCase() {
    val host = QuickJsScriptHost()
    val failures = ArrayList<String>()
    var cases = 0
    for (file in assets.list("conformance/expected")!!.filter { it.endsWith(".json") }.sorted()) {
      val exp = Json.parse(String(bytes("conformance/expected/$file"))) as Map<String, Any?>
      val doc = DocumentLoader.load(bytes(exp["document"] as String))
      val runner = ConformanceRunner(file.removeSuffix(".json"), doc, host)
      for (c in exp["cases"] as List<Any?>) {
        cases++
        try {
          runner.runCase(c as Map<String, Any>)
        } catch (e: Throwable) {
          failures += e.message ?: e.toString()
        }
      }
    }
    assertEquals("failures: " + failures.joinToString("\n"), 0, failures.size)
    assertEquals(82, cases)
  }

  @Test
  fun viewDrawsAndTouchDrivesListenersAndScripts() {
    val events = ArrayList<FiredEvent>()
    lateinit var view: OpenBoneView
    instrumentation.runOnMainSync {
      view = OpenBoneView(instrumentation.targetContext)
      view.isPlaying = false
      view.load(bytes("conformance/fixtures/interactive.obone"))
      view.useStateMachine("main")
      view.onEvent { events += it }
      view.measure(View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY))
      view.layout(0, 0, 400, 400)
      // Press the button (hit box centred at 0, 100 in skeleton space) through real touch events.
      val p = view.skeletonToView(0f, 100f)
      val t = SystemClock.uptimeMillis()
      view.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, p[0], p[1], 0))
      view.advance(1 / 60.0)
      view.dispatchTouchEvent(MotionEvent.obtain(t, t + 50, MotionEvent.ACTION_UP, p[0], p[1], 0))
      for (i in 0 until 3) view.advance(1 / 60.0)
    }
    assertTrue("click event reported: $events", events.any { it.name == "click" })
    val text = view.drawList().firstOrNull { it.text != null }?.text?.content
    assertEquals("the script counted the click into the template", "1 / ready", text)
    val bmp = Bitmap.createBitmap(400, 400, Bitmap.Config.ARGB_8888)
    instrumentation.runOnMainSync { view.draw(Canvas(bmp)) }
    var painted = 0
    for (y in 0 until 400 step 4) for (x in 0 until 400 step 4) if (bmp.getPixel(x, y) ushr 24 != 0) painted++
    assertTrue("something was drawn ($painted samples)", painted > 20)
    view.release()
  }
}
