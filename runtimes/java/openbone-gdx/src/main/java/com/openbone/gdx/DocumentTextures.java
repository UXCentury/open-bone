package com.openbone.gdx;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.files.FileHandle;
import com.badlogic.gdx.graphics.Pixmap;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.utils.Disposable;
import com.openbone.runtime.DrawItem;
import com.openbone.runtime.data.AtlasData;
import com.openbone.runtime.data.ImageAsset;
import com.openbone.runtime.data.OpenBoneDocument;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Textures for one document: images and atlas pages by id, loaded from {@code data:} URLs or from paths relative to
 * the document's folder, plus the built-in particle dot and a white texture. Call {@link #dispose()} when done.
 */
public class DocumentTextures implements Disposable {
  private final OpenBoneDocument doc;
  private final FileHandle base;
  private final Map<String, Texture> cache = new HashMap<>();
  private final Map<String, Boolean> missing = new HashMap<>();
  private Texture white, dot;
  public Texture.TextureFilter filter = Texture.TextureFilter.Linear;

  /** @param base folder that relative image paths resolve against (usually the document's folder), or null. */
  public DocumentTextures(OpenBoneDocument doc, FileHandle base) {
    this.doc = doc;
    this.base = base;
  }

  /** Texture for a draw item's texture id, or null when it cannot be loaded. */
  public Texture get(DrawItem.TextureRef ref) {
    if (ref == null) return null;
    if (DrawItem.PARTICLE_DOT_TEXTURE.equals(ref.id)) return dot();
    Texture t = cache.get(ref.id);
    if (t != null || missing.containsKey(ref.id)) return t;
    String src = null;
    for (ImageAsset i : doc.images) if (i.id.equals(ref.id)) src = i.src;
    if (src == null && doc.atlas != null) for (AtlasData.Page p : doc.atlas.pages) if (p.id.equals(ref.id)) src = p.src;
    try {
      t = src == null ? null : load(src);
    } catch (Exception e) {
      Gdx.app.error("OpenBone", "Cannot load texture " + ref.id + ": " + e.getMessage());
      t = null;
    }
    if (t == null) missing.put(ref.id, true);
    else {
      t.setFilter(filter, filter);
      cache.put(ref.id, t);
    }
    return t;
  }

  /** Whether a texture holds premultiplied alpha (atlas pages packed with premultipliedAlpha). */
  public boolean premultiplied(DrawItem.TextureRef ref) {
    if (ref == null || doc.atlas == null || !doc.atlas.premultipliedAlpha) return false;
    for (AtlasData.Page p : doc.atlas.pages) if (p.id.equals(ref.id)) return true;
    return false;
  }

  protected Texture load(String src) {
    if (src.startsWith("data:")) {
      int comma = src.indexOf(',');
      if (comma < 0 || !src.substring(0, comma).endsWith(";base64")) return null;
      byte[] bytes = Base64.getDecoder().decode(src.substring(comma + 1));
      if (bytes.length == 0) return null;
      Pixmap pm = new Pixmap(bytes, 0, bytes.length);
      Texture t = new Texture(pm);
      pm.dispose();
      return t;
    }
    FileHandle f = base != null ? base.child(src) : Gdx.files.internal(src);
    if (!f.exists()) f = Gdx.files.absolute(src);
    return f.exists() ? new Texture(f) : null;
  }

  /** 1×1 white texture (solid fills when the document has no atlas white block). */
  public Texture white() {
    if (white == null) {
      Pixmap pm = new Pixmap(1, 1, Pixmap.Format.RGBA8888);
      pm.setColor(1, 1, 1, 1);
      pm.fill();
      white = new Texture(pm);
      pm.dispose();
    }
    return white;
  }

  /** The soft round particle sprite ({@link DrawItem#particleDotAlpha}). */
  public Texture dot() {
    if (dot == null) {
      int n = DrawItem.PARTICLE_DOT_SIZE;
      Pixmap pm = new Pixmap(n, n, Pixmap.Format.RGBA8888);
      pm.setBlending(Pixmap.Blending.None);
      for (int y = 0; y < n; y++)
        for (int x = 0; x < n; x++) {
          double dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
          float a = (float) DrawItem.particleDotAlpha(Math.sqrt(dx * dx + dy * dy));
          pm.setColor(1, 1, 1, a);
          pm.drawPixel(x, y);
        }
      dot = new Texture(pm);
      dot.setFilter(Texture.TextureFilter.Linear, Texture.TextureFilter.Linear);
      pm.dispose();
    }
    return dot;
  }

  @Override
  public void dispose() {
    for (Texture t : cache.values()) t.dispose();
    cache.clear();
    if (white != null) white.dispose();
    if (dot != null) dot.dispose();
    white = dot = null;
  }
}
