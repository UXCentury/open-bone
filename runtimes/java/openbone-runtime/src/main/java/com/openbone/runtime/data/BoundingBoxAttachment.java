package com.openbone.runtime.data;

public class BoundingBoxAttachment extends Attachment {
  /** Flat {@code [x0, y0, ...]} polygon in slot-bone local space (or unused when weighted). */
  public double[] vertices = new double[0];
  /** Optional per-vertex bone influences (same layout as mesh weights), or null. */
  public MeshAttachment.VertexWeight[][] weights;

  public BoundingBoxAttachment() {
    super("boundingBox");
  }
}
