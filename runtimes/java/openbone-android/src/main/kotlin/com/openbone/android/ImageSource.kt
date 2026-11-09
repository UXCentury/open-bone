package com.openbone.android

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.io.File

/** Loads the bitmap for an image or atlas page `src` (a `data:` URL or a path relative to the document). */
fun interface ImageSource {
  fun load(src: String): Bitmap?

  companion object {
    /** Decode `data:<mime>;base64,…` URLs; null for anything else. */
    fun decodeDataUrl(src: String): Bitmap? {
      if (!src.startsWith("data:")) return null
      val comma = src.indexOf(',')
      if (comma < 0 || !src.substring(0, comma).endsWith(";base64")) return null
      val bytes = Base64.decode(src.substring(comma + 1), Base64.DEFAULT)
      return if (bytes.isEmpty()) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size, unpremultipliedOptions())
    }

    internal fun unpremultipliedOptions() = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }

    /** Images from the app's assets, relative to [dir] (the folder the .obone file is in, e.g. "anim/knight"). */
    fun assets(assets: AssetManager, dir: String = ""): ImageSource = ImageSource { src ->
      decodeDataUrl(src) ?: runCatching {
        val path = if (dir.isEmpty()) src else "${dir.trimEnd('/')}/$src"
        assets.open(path).use { BitmapFactory.decodeStream(it, null, unpremultipliedOptions()) }
      }.getOrNull()
    }

    /** Images from the file system, relative to [dir]. */
    fun files(dir: File): ImageSource = ImageSource { src ->
      decodeDataUrl(src) ?: File(dir, src).takeIf { it.exists() }?.let { BitmapFactory.decodeFile(it.path, unpremultipliedOptions()) }
    }

    /** Only embedded `data:` images. */
    val embedded: ImageSource = ImageSource { decodeDataUrl(it) }
  }
}
