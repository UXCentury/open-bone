package com.openbone.runtime.data;

public class TextAttachment extends Attachment {
  /** Text or template ("{score:0.00}x"). */
  public String text = "";
  public double x, y, rotation, width, height, size = 24, weight = 400;
  public String font = "sans-serif", color = "#ffffffff";
  /** "left", "center" or "right". */
  public String align = "center";
  public String outline;
  public Double outlineWidth;

  public TextAttachment() {
    super("text");
  }
}
