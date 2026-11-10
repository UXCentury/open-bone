package com.openbone.android

import android.content.res.AssetManager
import android.util.Base64
import java.io.File

/** Loads the bytes of a sound file `src` (a `data:` URL or a path relative to the document). */
fun interface SoundSource {
  fun load(src: String): ByteArray?

  companion object {
    /** Decode `data:<mime>;base64,…` URLs; null for anything else. */
    fun decodeDataUrl(src: String): ByteArray? {
      if (!src.startsWith("data:")) return null
      val comma = src.indexOf(',')
      if (comma < 0 || !src.substring(0, comma).endsWith(";base64")) return null
      return Base64.decode(src.substring(comma + 1), Base64.DEFAULT).takeIf { it.isNotEmpty() }
    }

    /** Sounds from the app's assets, relative to [dir] (the folder the .obone file is in, e.g. "anim/button"). */
    fun assets(assets: AssetManager, dir: String = ""): SoundSource = SoundSource { src ->
      decodeDataUrl(src) ?: runCatching {
        val path = if (dir.isEmpty()) src else "${dir.trimEnd('/')}/$src"
        assets.open(path).use { it.readBytes() }
      }.getOrNull()
    }

    /** Sounds from the file system, relative to [dir]. */
    fun files(dir: File): SoundSource = SoundSource { src ->
      decodeDataUrl(src) ?: File(dir, src).takeIf { it.isFile }?.readBytes()
    }

    /** Only embedded `data:` sounds. */
    val embedded: SoundSource = SoundSource { decodeDataUrl(it) }
  }
}
