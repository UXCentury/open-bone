package com.openbone.android

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.SoundPool
import android.util.Log
import com.openbone.runtime.AudioCommand
import com.openbone.runtime.AudioMixer
import com.openbone.runtime.data.AudioData
import com.openbone.runtime.data.OpenBoneDocument
import java.io.File

/**
 * Plays a document's sounds: short ones through a [SoundPool], long ones (over [longSound] seconds) through a
 * [MediaPlayer] each. Every file is read once through [sounds] and cached in the app's cache folder; voices follow the
 * command's volume × bus × master, rate (0.5…2), looping and fade-in, stop fades and fades ([AudioMixer], stepped in
 * [update]), and `mix` commands (setMute actions) that mute or unmute a bus or the master on top of the document's
 * mix. A play that arrives while its sound is still loading starts when it is ready, unless a stop came first.
 *
 * [OpenBoneView] makes one for each document it loads ([OpenBoneView.isAudioEnabled]). Use it directly with an
 * instance of your own:
 *
 * ```kotlin
 * val audio = OpenBoneAudio(context, doc, SoundSource.assets(assets, "button"))
 * instance.addListener(object : OpenBoneInstance.Listener { override fun audio(c: AudioCommand) = audio.handle(c) })
 * // every frame: audio.update(seconds)   when done: audio.release()
 * ```
 *
 * Create and use it on a thread with a Looper (the main thread): load and completion callbacks arrive there.
 */
class OpenBoneAudio(
  context: Context,
  val document: OpenBoneDocument,
  private val sounds: SoundSource = SoundSource.embedded,
  /** Sounds longer than this (seconds, from the document) play through MediaPlayer instead of SoundPool. */
  private val longSound: Double = 5.0,
) {
  private val cacheDir = File(context.cacheDir, "openbone-audio/${System.identityHashCode(this)}")
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_GAME)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()
  private val pool = SoundPool.Builder().setMaxStreams(16).setAudioAttributes(attributes).build()

  /** A voice: a SoundPool stream (soundId, streamId 0 while loading) or a MediaPlayer. */
  private class Voice(val loop: Boolean, val rate: Float, var gain: Float) {
    var soundId = 0
    var streamId = 0
    var player: MediaPlayer? = null
    var prepared = false
  }

  private val files = HashMap<String, File?>()
  private val soundIds = HashMap<String, Int>()
  private val loaded = HashMap<Int, Boolean>() // soundId → loaded OK (absent while loading)
  private val voices = HashMap<Int, Voice>()
  private var released = false

  val mixer: AudioMixer = AudioMixer(document, object : AudioMixer.Output {
    override fun start(voice: Int, asset: AudioData.Asset, gain: Double, rate: Double, loop: Boolean) =
      startVoice(voice, asset, gain.toFloat(), rate.toFloat(), loop)

    override fun setGain(voice: Int, gain: Double) {
      val v = voices[voice] ?: return
      v.gain = clamp(gain.toFloat())
      if (v.streamId != 0) pool.setVolume(v.streamId, v.gain, v.gain)
      if (v.prepared) v.player?.setVolume(v.gain, v.gain)
    }

    override fun stop(voice: Int) {
      val v = voices.remove(voice) ?: return
      if (v.streamId != 0) pool.stop(v.streamId)
      v.player?.let { p ->
        if (v.prepared) runCatching { p.stop() }
        p.release()
      }
    }
  })

  init {
    pool.setOnLoadCompleteListener { _, soundId, status ->
      if (released) return@setOnLoadCompleteListener
      loaded[soundId] = status == 0
      // Start the voices that were waiting for this sound (a stop before now removed them).
      for ((handle, v) in voices.entries.toList()) {
        if (v.soundId != soundId || v.streamId != 0) continue
        val stream = if (status == 0) playStream(v) else 0
        if (stream == 0) {
          voices.remove(handle)
          mixer.voiceFinished(handle)
        } else v.streamId = stream
      }
    }
  }

  /** Extra gain on everything this player plays. */
  var volume: Double
    get() = mixer.volume
    set(value) {
      mixer.volume = value
    }

  /** Handles one audio command (give it everything the instance's `audio` listener receives). */
  fun handle(c: AudioCommand) {
    if (!released) mixer.handle(c)
  }

  /** Steps fades and releases finished one-shots; call once per frame with real seconds. */
  fun update(seconds: Double) {
    if (!released) mixer.update(seconds)
  }

  /** Stops every voice. */
  fun stopAll() = mixer.stopAll()

  /** Stops every voice and frees the sounds and cached files. */
  fun release() {
    if (released) return
    mixer.stopAll()
    released = true
    pool.release()
    cacheDir.deleteRecursively()
  }

  private fun clamp(g: Float) = g.coerceIn(0f, 1f)

  private fun playStream(v: Voice): Int =
    pool.play(v.soundId, v.gain, v.gain, 1, if (v.loop) -1 else 0, v.rate)

  private fun startVoice(handle: Int, asset: AudioData.Asset, gain: Float, rate: Float, loop: Boolean): Boolean {
    val file = file(asset) ?: return false
    val v = Voice(loop, rate.coerceIn(0.5f, 2f), clamp(gain))
    if (asset.duration > longSound) {
      val p = MediaPlayer()
      v.player = p
      try {
        p.setAudioAttributes(attributes)
        p.setDataSource(file.path)
        p.isLooping = loop
        p.setOnPreparedListener {
          if (voices[handle] !== v) return@setOnPreparedListener
          v.prepared = true
          p.setVolume(v.gain, v.gain)
          if (v.rate != 1f) runCatching { p.playbackParams = p.playbackParams.setSpeed(v.rate) }
          p.start()
        }
        p.setOnCompletionListener {
          if (voices[handle] !== v) return@setOnCompletionListener
          voices.remove(handle)
          p.release()
          mixer.voiceFinished(handle)
        }
        p.setOnErrorListener { _, _, _ ->
          if (voices.remove(handle) === v) mixer.voiceFinished(handle)
          p.release()
          true
        }
        p.prepareAsync()
      } catch (e: Exception) {
        Log.e("OpenBone", "Cannot play sound \"${asset.name}\": ${e.message}")
        p.release()
        return false
      }
      voices[handle] = v
      return true
    }
    v.soundId = soundIds.getOrPut(asset.id) { pool.load(file.path, 1) }
    when (loaded[v.soundId]) {
      false -> return false // failed to decode
      true -> {
        v.streamId = playStream(v)
        if (v.streamId == 0) return false
      }
      null -> Unit // still loading: starts in the load listener
    }
    voices[handle] = v
    return true
  }

  /** The sound's bytes in a cache file (SoundPool and MediaPlayer read files), or null when it cannot be read. */
  private fun file(asset: AudioData.Asset): File? {
    if (files.containsKey(asset.id)) return files[asset.id]
    return writeFile(asset).also { files[asset.id] = it }
  }

  private fun writeFile(asset: AudioData.Asset): File? {
    val bytes = runCatching { sounds.load(asset.src) }.getOrNull()
    if (bytes == null) {
      Log.e("OpenBone", "Cannot read sound \"${asset.name}\" (${asset.src.take(80)})")
      return null
    }
    val ext = when {
      asset.src.startsWith("data:") -> asset.src.substringBefore(',').let {
        if ("mpeg" in it || "mp3" in it) "mp3" else if ("ogg" in it) "ogg" else "wav"
      }
      else -> asset.src.substringAfterLast('.', "wav").lowercase()
    }
    return runCatching {
      cacheDir.mkdirs()
      File(cacheDir, "${asset.id.replace(Regex("[^A-Za-z0-9_-]"), "_")}.$ext").also { it.writeBytes(bytes) }
    }.getOrNull()
  }
}
