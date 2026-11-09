package com.openbone.runtime.data;

public class ShapeAttachment extends Attachment {
  /** "rect", "ellipse" or "polygon". */
  public String shape = "rect";
  public double x, y, rotation, width, height, radius;
  public double[] points;
  public String fill = "#ffffffff", stroke;
  public Double strokeWidth;

  public ShapeAttachment() {
    super("shape");
  }
}
