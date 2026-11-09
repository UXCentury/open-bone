package com.openbone.runtime.data;

public class ClippingAttachment extends Attachment {
  public double[] vertices = new double[0];
  /** Slot id the mask ends at (inclusive), or null for never. */
  public String end;

  public ClippingAttachment() {
    super("clipping");
  }
}
