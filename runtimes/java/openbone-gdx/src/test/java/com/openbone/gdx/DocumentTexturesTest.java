package com.openbone.gdx;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.badlogic.gdx.graphics.Texture.TextureFilter;
import com.badlogic.gdx.graphics.Texture.TextureWrap;
import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.OpenBoneDocument;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/** The libGDX filters and wraps DocumentTextures gives a document's textures (no GL needed). */
class DocumentTexturesTest {
  private static OpenBoneDocument doc(String extra, String atlas) {
    String json = "{\"format\":\"openbone\",\"version\":1,\"name\":\"t\",\"width\":8,\"height\":8,\"originX\":0,\"originY\":0,\"background\":null,\"fps\":30" + extra
        + ",\"images\":[{\"id\":\"img\",\"name\":\"a\",\"src\":\"a.png\",\"width\":4,\"height\":4}]"
        + ",\"atlas\":{\"pages\":[{\"id\":\"pg\",\"name\":\"p\",\"src\":\"p.png\",\"width\":8,\"height\":8}],\"regions\":[]" + atlas + "}"
        + ",\"skeleton\":{\"bones\":[],\"slots\":[],\"skins\":[]},\"animations\":[],\"stateMachines\":[]}";
    return DocumentLoader.load(json.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void pixelArtIsNearest() {
    OpenBoneDocument d = doc(",\"textureFilter\":\"nearest\"", "");
    TextureFilter[] nearest = {TextureFilter.Nearest, TextureFilter.Nearest};
    assertArrayEquals(nearest, DocumentTextures.filters(d.textureSampling("img")));
    assertArrayEquals(nearest, DocumentTextures.filters(d.textureSampling("pg")));
    assertArrayEquals(new TextureFilter[] {TextureFilter.Linear, TextureFilter.Linear}, DocumentTextures.filters(doc("", "").textureSampling("img")));
  }

  @Test
  void atlasFiltersAndWrapsWinForItsPages() {
    OpenBoneDocument d = doc(",\"textureFilter\":\"nearest\"", ",\"filterMin\":\"mipmapLinearNearest\",\"filterMag\":\"linear\",\"wrapX\":\"repeat\",\"wrapY\":\"mirroredRepeat\"");
    assertArrayEquals(new TextureFilter[] {TextureFilter.MipMapLinearNearest, TextureFilter.Linear}, DocumentTextures.filters(d.textureSampling("pg")));
    assertEquals(TextureWrap.Repeat, DocumentTextures.wrap(d.textureSampling("pg").wrapX));
    assertEquals(TextureWrap.MirroredRepeat, DocumentTextures.wrap(d.textureSampling("pg").wrapY));
    assertEquals(TextureWrap.ClampToEdge, DocumentTextures.wrap(d.textureSampling("img").wrapX));
    assertArrayEquals(new TextureFilter[] {TextureFilter.Nearest, TextureFilter.Nearest}, DocumentTextures.filters(d.textureSampling("img")));
  }
}
