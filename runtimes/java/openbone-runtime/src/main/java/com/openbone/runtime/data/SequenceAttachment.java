package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class SequenceAttachment extends Attachment {
  public final List<Frame> frames = new ArrayList<>();
  public double x, y, rotation, scaleX = 1, scaleY = 1, skewX, skewY, width, height, fps = 24, offset;
  public String color = "#ffffffff";
  /** "loop", "once", "pingPong" or "holdLast". */
  public String mode = "loop";
  /** Number input id that drives the frame, or null. */
  public String input;

  public SequenceAttachment() {
    super("sequence");
  }

  public static class Frame {
    public String image;
    /** Sub-rectangle {x, y, width, height} of the image, or null for the whole image. */
    public double[] rect;
    /** Trim {x, y, sourceWidth, sourceHeight}, or null. */
    public double[] trim;
  }
}
