package com.openbone.runtime.data;

public class RegionAttachment extends Attachment {
  public String image, color = "#ffffffff";
  public double x, y, rotation, scaleX = 1, scaleY = 1, skewX, skewY, width, height;

  public RegionAttachment() {
    super("region");
  }
}
