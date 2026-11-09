package com.openbone.runtime;

import com.openbone.runtime.data.Attachment;
import com.openbone.runtime.data.ImageAsset;

/**
 * One renderable piece of the draw list, in draw order. Vertices are world x,y pairs (skeleton space, y up), uvs are in
 * {@link #texture} space (0..1, v down). Values are float32-rounded, held in doubles.
 */
public final class DrawItem {
  /** Texture id of the built-in soft round particle sprite (renderers generate it, see {@link #particleDotAlpha}). */
  public static final String PARTICLE_DOT_TEXTURE = "@openbone/particle-dot";
  public static final int PARTICLE_DOT_SIZE = 64;

  /** Alpha of the soft round particle sprite at distance r from its centre (0 = centre, 1 = edge). */
  public static double particleDotAlpha(double r) {
    return Math.pow(r >= 1 ? 0 : r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65, 1.6);
  }

  /** The texture a draw item samples: an image or an atlas page (by id), with its pixel size. */
  public static final class TextureRef {
    public final String id;
    public final double width, height;

    public TextureRef(String id, double width, double height) {
      this.id = id;
      this.width = width;
      this.height = height;
    }
  }

  /** A clipping mask in world space: outline polygon and its triangulation. Shared by consecutive items under it. */
  public static final class ClipRegion {
    public final Slot slot;
    public final double[] polygon;
    public final int[] indices;

    ClipRegion(Slot slot, double[] polygon, int[] indices) {
      this.slot = slot;
      this.polygon = polygon;
      this.indices = indices;
    }
  }

  /** Shape outline stroke. */
  public static final class Stroke {
    public final double[] color;
    public final double width;
    public final double[] outline;

    Stroke(double[] color, double width, double[] outline) {
      this.color = color;
      this.width = width;
      this.outline = outline;
    }
  }

  /** Text to draw in the item's box (content already filled in from its template). */
  public static final class Text {
    public String content, font, align;
    public double size, weight, width, height, outlineWidth;
    public double[] fill, outline;
    /** Box centre to world (skeleton space, y-up). */
    public Affine matrix;
  }

  public Slot slot;
  public Attachment attachment;
  /** The image drawn, or null (solid fill, text, particles without an image). */
  public ImageAsset image;
  public TextureRef texture;
  /** For packed images: the image's rect inside the page (pixels, y-down), or null. */
  public double[] textureRect;
  public double[] vertices, uvs;
  public int[] indices;
  /** Slot tint × attachment colour, RGBA. */
  public double[] color;
  /** Two-colour tint dark RGB(A), or null for black. */
  public double[] dark;
  /** "normal", "additive", "multiply" or "screen". */
  public String blend;
  public Stroke stroke;
  public ClipRegion clip;
  /** Per-vertex RGBA for particles (replaces {@link #color}), or null. */
  public double[] colors;
  /** Particle batches: look ("circle", "square", "spark", "image") and quad count; null otherwise. */
  public String particleLook;
  public int particleCount;
  public Text text;

  /** "particles", "text" or the attachment type. */
  public String kind() {
    return particleLook != null ? "particles" : text != null ? "text" : attachment.type;
  }
}
