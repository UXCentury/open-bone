package com.openbone.gdx;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.graphics.Camera;
import com.badlogic.gdx.graphics.GL20;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.g2d.BitmapFont;
import com.badlogic.gdx.graphics.g2d.GlyphLayout;
import com.badlogic.gdx.graphics.g2d.SpriteBatch;
import com.badlogic.gdx.math.Matrix4;
import com.badlogic.gdx.math.Vector2;
import com.badlogic.gdx.math.Vector3;
import com.badlogic.gdx.utils.Align;
import com.badlogic.gdx.utils.Disposable;
import com.openbone.runtime.Affine;
import com.openbone.runtime.DrawItem;
import com.openbone.runtime.OpenBoneInstance;
import java.util.List;

/**
 * Draws an OpenBone draw list with libGDX: two-colour tint, normal/additive/multiply/screen blending, stencil clipping
 * masks, particles (per-vertex colours), shapes with strokes, and text: by default through FreeType with the document's
 * own font families resolved to installed fonts and real outlines ({@link OpenBoneFonts}; needs the gdx-freetype
 * natives), or through one {@link BitmapFont} you pass in.
 *
 * <p>Coordinates are skeleton space (y up). Pass a projection that maps them to the screen, e.g. an
 * {@code OrthographicCamera} centred on the skeleton. Clipping needs a stencil buffer (LWJGL3:
 * {@code config.setBackBufferConfig(8, 8, 8, 8, 16, 8, 0)}).
 */
public class OpenBoneRenderer implements Disposable {
  private final TwoColorBatch batch;
  private final SpriteBatch textBatch = new SpriteBatch(256);
  private BitmapFont font;
  private boolean ownFont;
  /** FreeType fonts for text (null when you passed a BitmapFont, or FreeType's natives aren't there). */
  private OpenBoneFonts fonts;
  private boolean fontsChecked;
  private final GlyphLayout layout = new GlyphLayout();
  private final Matrix4 projection = new Matrix4(), textTransform = new Matrix4();
  private DrawItem.ClipRegion clip;
  /** Draw calls in the last frame. */
  public int drawCalls;

  public OpenBoneRenderer() {
    this((BitmapFont) null);
  }

  /**
   * @param font one font for every text attachment, scaled to each text's size (null = the document's own fonts
   *     through FreeType, or libGDX's built-in font when FreeType's natives aren't available).
   */
  public OpenBoneRenderer(BitmapFont font) {
    batch = new TwoColorBatch(32000);
    this.font = font;
    fontsChecked = font != null;
  }

  /** Text through these FreeType fonts (register your own font files on them first); disposed with the renderer. */
  public OpenBoneRenderer(OpenBoneFonts fonts) {
    batch = new TwoColorBatch(32000);
    this.fonts = fonts;
    fontsChecked = true;
  }

  /** The FreeType fonts in use (register font files for the families your documents name), or null. */
  public OpenBoneFonts fonts() {
    if (!fontsChecked) {
      fontsChecked = true;
      if (OpenBoneFonts.isAvailable()) fonts = new OpenBoneFonts();
    }
    return fonts;
  }

  private BitmapFont font() {
    if (font == null) {
      font = new BitmapFont();
      font.getData().setScale(1);
      font.setUseIntegerPositions(false);
      ownFont = true;
    }
    return font;
  }

  /**
   * Screen pixels (libGDX input: origin top-left, y down) to skeleton space, for the camera you draw with. The result
   * is what {@code instance.pointer(...)} and the bounding-box queries take, e.g.
   * {@code instance.skeleton.boundingBoxes().containsPoint(p.x, p.y)}. With a {@code Viewport}, use
   * {@code viewport.unproject(...)} instead (it accounts for the letterbox).
   */
  public static Vector2 screenToSkeleton(Camera camera, float screenX, float screenY, Vector2 out) {
    Vector3 v = camera.unproject(new Vector3(screenX, screenY, 0));
    return out.set(v.x, v.y);
  }

  public void draw(OpenBoneInstance instance, DocumentTextures textures, Matrix4 projection) {
    draw(instance.drawList(), textures, projection);
  }

  public void draw(List<DrawItem> items, DocumentTextures textures, Matrix4 projection) {
    this.projection.set(projection);
    batch.setProjection(projection);
    batch.drawCalls = 0;
    batch.begin();
    clip = null;
    for (DrawItem it : items) {
      if (it.clip != clip) setClip(it.clip, textures);
      if (it.text != null) drawText(it);
      else drawGeometry(it, textures);
      if (it.stroke != null) drawStroke(it, textures);
    }
    batch.end();
    if (clip != null) {
      Gdx.gl.glDisable(GL20.GL_STENCIL_TEST);
      clip = null;
    }
    drawCalls = batch.drawCalls;
  }

  private void setClip(DrawItem.ClipRegion region, DocumentTextures textures) {
    batch.flush();
    clip = region;
    if (region == null) {
      Gdx.gl.glDisable(GL20.GL_STENCIL_TEST);
      return;
    }
    Gdx.gl.glEnable(GL20.GL_STENCIL_TEST);
    Gdx.gl.glClearStencil(0);
    Gdx.gl.glClear(GL20.GL_STENCIL_BUFFER_BIT);
    Gdx.gl.glStencilFunc(GL20.GL_ALWAYS, 1, 0xff);
    Gdx.gl.glStencilOp(GL20.GL_KEEP, GL20.GL_KEEP, GL20.GL_REPLACE);
    Gdx.gl.glColorMask(false, false, false, false);
    batch.state(textures.white(), false, "normal");
    double[] p = region.polygon;
    int base = batch.reserve(p.length / 2, region.indices.length);
    for (int i = 0; i + 1 < p.length; i += 2) batch.vertex((float) p[i], (float) p[i + 1], 1, 1, 1, 1, 0, 0, 0, 0, 0);
    for (int i : region.indices) batch.index(base + i);
    batch.flush();
    Gdx.gl.glColorMask(true, true, true, true);
    Gdx.gl.glStencilFunc(GL20.GL_EQUAL, 1, 0xff);
    Gdx.gl.glStencilOp(GL20.GL_KEEP, GL20.GL_KEEP, GL20.GL_KEEP);
  }

  private void drawGeometry(DrawItem it, DocumentTextures textures) {
    Texture tex;
    if (it.texture != null) tex = textures.get(it.texture);
    else if (it.image == null && (it.particleLook != null || "shape".equals(it.attachment.type))) tex = textures.white();
    else tex = null;
    if (tex == null) return; // missing image
    batch.state(tex, textures.premultiplied(it.texture), it.blend);
    double[] v = it.vertices, uv = it.uvs, c = it.color, cs = it.colors;
    float dr = 0, dg = 0, db = 0;
    if (it.dark != null) {
      dr = (float) it.dark[0];
      dg = (float) it.dark[1];
      db = (float) it.dark[2];
    }
    int n = v.length / 2;
    int max = 30000;
    if (n <= max) {
      int base = batch.reserve(n, it.indices.length);
      for (int i = 0; i < n; i++) {
        float r, g, b, a;
        if (cs != null) {
          r = (float) cs[i * 4];
          g = (float) cs[i * 4 + 1];
          b = (float) cs[i * 4 + 2];
          a = (float) cs[i * 4 + 3];
        } else {
          r = (float) c[0];
          g = (float) c[1];
          b = (float) c[2];
          a = (float) c[3];
        }
        batch.vertex((float) v[i * 2], (float) v[i * 2 + 1], r, g, b, a, dr, dg, db, (float) uv[i * 2], (float) uv[i * 2 + 1]);
      }
      for (int idx : it.indices) batch.index(base + idx);
      return;
    }
    // Very large particle batches: draw quad by quad (4 vertices, 6 indices each).
    for (int q = 0; q < n / 4; q++) {
      int base = batch.reserve(4, 6);
      for (int k = 0; k < 4; k++) {
        int i = q * 4 + k;
        batch.vertex((float) v[i * 2], (float) v[i * 2 + 1], (float) cs[i * 4], (float) cs[i * 4 + 1], (float) cs[i * 4 + 2], (float) cs[i * 4 + 3], 0, 0, 0,
            (float) uv[i * 2], (float) uv[i * 2 + 1]);
      }
      int[] quad = {0, 1, 2, 0, 2, 3};
      for (int k : quad) batch.index(base + k);
    }
  }

  private void drawStroke(DrawItem it, DocumentTextures textures) {
    double[] o = it.stroke.outline, c = it.stroke.color;
    int n = o.length / 2;
    if (n < 2 || c[3] <= 0) return;
    batch.state(textures.white(), false, it.blend);
    double hw = it.stroke.width / 2;
    for (int i = 0; i < n; i++) {
      double x0 = o[i * 2], y0 = o[i * 2 + 1], x1 = o[((i + 1) % n) * 2], y1 = o[((i + 1) % n) * 2 + 1];
      double dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      double nx = -dy / len * hw, ny = dx / len * hw, ex = dx / len * hw, ey = dy / len * hw;
      int base = batch.reserve(4, 6);
      float r = (float) c[0], g = (float) c[1], b = (float) c[2], a = (float) c[3];
      batch.vertex((float) (x0 - ex + nx), (float) (y0 - ey + ny), r, g, b, a, 0, 0, 0, 0, 0);
      batch.vertex((float) (x1 + ex + nx), (float) (y1 + ey + ny), r, g, b, a, 0, 0, 0, 0, 0);
      batch.vertex((float) (x1 + ex - nx), (float) (y1 + ey - ny), r, g, b, a, 0, 0, 0, 0, 0);
      batch.vertex((float) (x0 - ex - nx), (float) (y0 - ey - ny), r, g, b, a, 0, 0, 0, 0, 0);
      batch.index(base);
      batch.index(base + 1);
      batch.index(base + 2);
      batch.index(base);
      batch.index(base + 2);
      batch.index(base + 3);
    }
  }

  private void drawText(DrawItem it) {
    DrawItem.Text t = it.text;
    if (t.content.isEmpty()) return;
    batch.flush();
    OpenBoneFonts ft = fonts();
    if (ft != null && drawFreeType(ft, it)) return;
    BitmapFont f = font();
    float lineHeight = f.getData().lineHeight / f.getData().scaleY;
    float scale = (float) t.size * 1.2f / lineHeight;
    f.getData().setScale(scale);
    Affine m = t.matrix;
    textTransform.idt();
    float[] val = textTransform.val;
    val[Matrix4.M00] = (float) m.a;
    val[Matrix4.M01] = (float) m.b;
    val[Matrix4.M10] = (float) m.c;
    val[Matrix4.M11] = (float) m.d;
    val[Matrix4.M03] = (float) m.x;
    val[Matrix4.M13] = (float) m.y;
    textBatch.setProjectionMatrix(projection);
    textBatch.setTransformMatrix(textTransform);
    textBatch.begin();
    double[] tint = it.color;
    int halign = "left".equals(t.align) ? Align.left : "right".equals(t.align) ? Align.right : Align.center;
    String[] lines = t.content.split("\n", -1);
    float lh = (float) t.size * 1.2f;
    float y0 = (lines.length - 1) * lh / 2;
    for (int pass = 0; pass < 2; pass++) {
      double[] col = pass == 0 ? t.outline : t.fill;
      if (col == null) continue;
      f.setColor((float) (col[0] * tint[0]), (float) (col[1] * tint[1]), (float) (col[2] * tint[2]), (float) (col[3] * tint[3]));
      float off = pass == 0 ? (float) t.outlineWidth : 0;
      int rings = pass == 0 ? 8 : 1;
      for (int r = 0; r < rings; r++) {
        float ox = pass == 0 ? (float) (Math.cos(r * Math.PI / 4) * off) : 0, oy = pass == 0 ? (float) (Math.sin(r * Math.PI / 4) * off) : 0;
        for (int i = 0; i < lines.length; i++) {
          layout.setText(f, lines[i], f.getColor(), (float) t.width, halign, false);
          float y = y0 - i * lh + f.getCapHeight() / 2;
          f.draw(textBatch, layout, (float) (-t.width / 2) + ox, y + oy);
        }
      }
    }
    textBatch.end();
    // SpriteBatch.end resets blending; restore ours.
    batch.begin();
  }

  /**
   * Text with the document's fonts: the outline under the fill, then the fill. The outline stamps the same glyphs
   * around a ring of the outline width (16 directions, plus an inner ring for wide outlines), so it lines up with the
   * fill exactly and matches the web renderer's canvas stroke (outlineWidth × 2, half of it outside the glyphs).
   */
  private boolean drawFreeType(OpenBoneFonts ft, DrawItem it) {
    DrawItem.Text t = it.text;
    boolean outlined = t.outline != null && t.outlineWidth > 0;
    BitmapFont fill = ft.font(t.font, t.content, (float) t.size, 0);
    if (fill == null) return false;
    Affine m = t.matrix;
    textTransform.idt();
    float[] val = textTransform.val;
    val[Matrix4.M00] = (float) m.a;
    val[Matrix4.M01] = (float) m.b;
    val[Matrix4.M10] = (float) m.c;
    val[Matrix4.M11] = (float) m.d;
    val[Matrix4.M03] = (float) m.x;
    val[Matrix4.M13] = (float) m.y;
    textBatch.setProjectionMatrix(projection);
    textBatch.setTransformMatrix(textTransform);
    textBatch.begin();
    double[] tint = it.color;
    int halign = "left".equals(t.align) ? Align.left : "right".equals(t.align) ? Align.right : Align.center;
    String[] lines = t.content.split("\n", -1);
    float lh = (float) t.size * 1.2f;
    float y0 = (lines.length - 1) * lh / 2;
    fill.getData().setScale(1f / ft.oversample);
    // Centre each line on the cap height, like the canvas's "middle" baseline.
    float cap = fill.getCapHeight();
    float w = (float) t.outlineWidth;
    for (int pass = outlined ? 0 : 1; pass < 2; pass++) {
      double[] col = pass == 0 ? t.outline : t.fill;
      if (col == null) continue;
      fill.setColor((float) (col[0] * tint[0]), (float) (col[1] * tint[1]), (float) (col[2] * tint[2]), (float) (col[3] * tint[3]));
      for (int i = 0; i < lines.length; i++) {
        layout.setText(fill, lines[i], fill.getColor(), (float) t.width, halign, false);
        float x = (float) (-t.width / 2), y = y0 - i * lh + cap / 2;
        if (pass == 1) {
          fill.draw(textBatch, layout, x, y);
          continue;
        }
        int rings = w > 2 ? 2 : 1;
        for (int r = 1; r <= rings; r++) {
          float rad = w * r / rings;
          for (int k = 0; k < 16; k++) {
            double a = k * Math.PI / 8;
            fill.draw(textBatch, layout, x + (float) Math.cos(a) * rad, y + (float) Math.sin(a) * rad);
          }
        }
      }
    }
    textBatch.end();
    batch.begin();
    return true;
  }

  @Override
  public void dispose() {
    batch.dispose();
    textBatch.dispose();
    if (fonts != null) fonts.dispose();
    if (ownFont && font != null) font.dispose();
  }
}
