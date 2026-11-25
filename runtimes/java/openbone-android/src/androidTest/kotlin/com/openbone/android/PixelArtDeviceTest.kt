package com.openbone.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.openbone.runtime.OpenBoneInstance
import com.openbone.runtime.data.DocumentLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith

/** A 2×2 image (red, blue / green, white) drawn 8×8: pixel art keeps hard texel edges, the default blends them. */
@RunWith(AndroidJUnit4::class)
class PixelArtDeviceTest {
  private fun render(filter: String): Bitmap {
    val doc = DocumentLoader.fromJson(
      """{"format":"openbone","version":1,"name":"px","width":8,"height":8,"originX":4,"originY":4,"fps":30$filter,
      "images":[{"id":"img","name":"px","src":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8AAQmDqPwgAAEnICfchVbMlAAAAAElFTkSuQmCC","width":2,"height":2}],
      "skeleton":{"bones":[{"id":"b","name":"root","parent":null}],"slots":[{"id":"s","name":"px","bone":"b","attachment":"r"}],
      "skins":[{"id":"skin_default","name":"default","attachments":{"s":{"r":{"type":"region","name":"r","image":"img","width":8,"height":8}}}}]},
      "animations":[]}""",
    )
    val inst = OpenBoneInstance(doc)
    inst.advance(0.0)
    val bmp = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
    val toView = Matrix().apply { setScale(1f, -1f); postTranslate(4f, 4f) }
    CanvasRenderer(doc, ImageSource.embedded).draw(Canvas(bmp), inst.drawList(), toView)
    return bmp
  }

  @Test
  fun nearestKeepsTexelEdges() {
    // Pixel (3, 1) sits 3/8 of a texel from the red/blue edge: unfiltered it is pure red.
    assertEquals(Color.RED, render(""","textureFilter":"nearest"""").getPixel(3, 1))
    assertNotEquals(Color.RED, render("").getPixel(3, 1))
  }
}
