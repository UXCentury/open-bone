package com.openbone.runtime.data;

/**
 * How a renderer samples one texture (an image or an atlas page); see {@link OpenBoneDocument#textureSampling}. It never
 * changes the pose or the draw list.
 */
public final class TextureSampling {
  /** Minification: nearest | linear | mipmap | mipmapNearestNearest | mipmapLinearNearest | mipmapNearestLinear | mipmapLinearLinear. */
  public final String min;
  /** Texel filters of minification and magnification (mipmap filters reduce to their first part; "mipmap" is linear). */
  public final boolean minNearest, magNearest;
  /** True when {@link #min} uses mipmaps; mipNearest picks the nearest level instead of blending two. */
  public final boolean mipmaps, mipNearest;
  /** clamp | repeat | mirroredRepeat */
  public final String wrapX, wrapY;

  TextureSampling(String min, String mag, String wrapX, String wrapY) {
    this.min = min;
    this.minNearest = texelNearest(min);
    this.magNearest = texelNearest(mag);
    this.mipmaps = !min.equals("nearest") && !min.equals("linear");
    this.mipNearest = min.equals("mipmapNearestNearest") || min.equals("mipmapLinearNearest");
    this.wrapX = wrapX;
    this.wrapY = wrapY;
  }

  /** For renderers with one smooth on/off switch: true = hard pixel edges. */
  public boolean nearest() {
    return magNearest;
  }

  static boolean texelNearest(String f) {
    return f.equals("nearest") || f.equals("mipmapNearestNearest") || f.equals("mipmapNearestLinear");
  }
}
