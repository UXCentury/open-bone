package com.openbone.runtime.data;

public class BoundingBoxAttachment extends Attachment {
  public double[] vertices = new double[0];

  public BoundingBoxAttachment() {
    super("boundingBox");
  }
}
