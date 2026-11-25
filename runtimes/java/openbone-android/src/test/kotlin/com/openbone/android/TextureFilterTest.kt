package com.openbone.android

import com.openbone.runtime.DrawItem
import com.openbone.runtime.data.DocumentLoader
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Pixel art (textureFilter "nearest") draws its bitmaps without filtering. */
class TextureFilterTest {
  private fun renderer(extra: String, atlas: String = "") = CanvasRenderer(
    DocumentLoader.fromJson(
      """{"format":"openbone","version":1,"name":"t","width":8,"height":8,"originX":0,"originY":0,"background":null,"fps":30$extra,
      "images":[{"id":"img","name":"a","src":"a.png","width":4,"height":4}],
      "atlas":{"pages":[{"id":"pg","name":"p","src":"p.png","width":8,"height":8}],"regions":[]$atlas},
      "skeleton":{"bones":[],"slots":[],"skins":[]},"animations":[],"stateMachines":[]}""",
    ),
    ImageSource.embedded,
  )

  private fun ref(id: String) = DrawItem.TextureRef(id, 4.0, 4.0)

  @Test
  fun pixelArtDisablesBitmapFiltering() {
    val r = renderer(""","textureFilter":"nearest"""")
    assertFalse(r.filterBitmap(ref("img")))
    assertFalse(r.filterBitmap(ref("pg")))
    assertTrue(r.filterBitmap(ref(DrawItem.PARTICLE_DOT_TEXTURE)))
    assertTrue(r.filterBitmap(null))
    assertTrue(renderer("").filterBitmap(ref("img")))
  }

  @Test
  fun atlasFiltersWinForItsPages() {
    val r = renderer(""","textureFilter":"nearest"""", ""","filterMag":"linear"""")
    assertTrue(r.filterBitmap(ref("pg")))
    assertFalse(r.filterBitmap(ref("img")))
    assertFalse(renderer("", ""","filterMag":"nearest"""").filterBitmap(ref("pg")))
  }
}
