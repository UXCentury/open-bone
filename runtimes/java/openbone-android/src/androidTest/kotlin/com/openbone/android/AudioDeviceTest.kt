package com.openbone.android

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.openbone.runtime.AudioCommand
import com.openbone.runtime.data.DocumentLoader
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** OpenBoneAudio on a device: SoundPool and MediaPlayer voices, loading, cancelling and completion. */
@RunWith(AndroidJUnit4::class)
class AudioDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  /** 0.2 s of a 440 Hz tone, 16-bit mono 22050 Hz WAV (the interactive fixture's "beep" is 0.2 s too). */
  private val wav: ByteArray by lazy {
    val rate = 22050
    val n = rate / 5
    val pcm = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until n) pcm.putShort((sin(2 * PI * 440 * i / rate) * 8000).toInt().toShort())
    val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    h.put("RIFF".toByteArray()).putInt(36 + n * 2).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
      .putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(n * 2)
    ByteArrayOutputStream().apply { write(h.array()); write(pcm.array()) }.toByteArray()
  }

  private val doc by lazy {
    DocumentLoader.load(instrumentation.context.assets.open("conformance/fixtures/interactive.obone").use { it.readBytes() })
  }

  private fun audio(longSound: Double = 5.0): OpenBoneAudio {
    lateinit var a: OpenBoneAudio
    instrumentation.runOnMainSync { a = OpenBoneAudio(instrumentation.targetContext, doc, { wav }, longSound) }
    return a
  }

  private fun play(id: String) = AudioCommand.play(id, doc.audio.assets[0].id, "bus_sfx", 1.0, 1.0, false, 0.0)

  private fun waitMain(ms: Long) {
    SystemClock.sleep(ms)
    instrumentation.waitForIdleSync()
  }

  @Test
  fun soundPoolVoicesLoadPlayAndExpire() {
    val a = audio()
    instrumentation.runOnMainSync {
      a.handle(play("p1"))
      a.handle(play("p2"))
      a.handle(AudioCommand.stop("p2", 0.0)) // stopped while still loading: never starts
    }
    waitMain(500)
    instrumentation.runOnMainSync {
      assertNotNull("loaded and playing", a.mixer.voice("p1"))
      assertNull(a.mixer.voice("p2"))
      a.update(1.0) // past its 0.2 s
      assertEquals(0, a.mixer.voiceCount())
      a.handle(play("p3")) // loaded now: starts at once
      assertNotNull(a.mixer.voice("p3"))
      a.release()
    }
  }

  @Test
  fun mediaPlayerVoicesFinishByThemselves() {
    val a = audio(longSound = 0.0)
    instrumentation.runOnMainSync { a.handle(play("m")) }
    waitMain(200)
    instrumentation.runOnMainSync { assertNotNull(a.mixer.voice("m")) }
    waitMain(1500)
    instrumentation.runOnMainSync {
      assertNull("completion releases the voice", a.mixer.voice("m"))
      a.release()
    }
  }

  @Test
  fun viewOwnsAPlayerPerDocument() {
    lateinit var view: OpenBoneView
    instrumentation.runOnMainSync {
      view = OpenBoneView(instrumentation.targetContext)
      view.isPlaying = false
      view.load(doc, sounds = { wav })
      view.audio!!.handle(play("x"))
    }
    waitMain(300)
    instrumentation.runOnMainSync {
      assertNotNull(view.audio!!.mixer.voice("x"))
      view.release()
      assertNull(view.audio)
    }
  }
}
