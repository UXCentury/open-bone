package com.openbone.runtime.data;

/**
 * A font the document carries, so text looks the same everywhere instead of depending on installed fonts. Text
 * attachments name it through {@link #family} in their CSS-like font list; {@link #src} is a data: URL or a path
 * relative to the document (like images and audio).
 */
public class FontAsset {
  public String id, name, family, src;
  /** 100..900 (400 = regular). */
  public double weight = 400;
  /** "normal" or "italic". */
  public String style = "normal";
}
