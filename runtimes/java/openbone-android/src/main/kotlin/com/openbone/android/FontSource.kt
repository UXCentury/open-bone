package com.openbone.android

import android.content.res.AssetManager
import java.io.File

/**
 * Loads the bytes of a document font file `src` (a `data:` URL or a path relative to the document). Any
 * [SoundSource] reads fonts too: `FontSource { sounds.load(it) }`, which is what [OpenBoneView.load] does by default.
 */
fun interface FontSource {
  fun load(src: String): ByteArray?

  companion object {
    /** Fonts from the app's assets, relative to [dir] (the folder the .obone file is in). */
    fun assets(assets: AssetManager, dir: String = ""): FontSource = SoundSource.assets(assets, dir).let { s -> FontSource { s.load(it) } }

    /** Fonts from the file system, relative to [dir]. */
    fun files(dir: File): FontSource = SoundSource.files(dir).let { s -> FontSource { s.load(it) } }

    /** Only embedded `data:` fonts. */
    val embedded: FontSource = FontSource { SoundSource.decodeDataUrl(it) }
  }
}
