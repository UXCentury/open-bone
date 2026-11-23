package com.openbone.runtime.data;

/**
 * One mapping of a transform constraint: value = offset + (the target's {@code from}) x scale, clamped to min..max,
 * is written to each constrained bone's {@code to}. Channels: rotation, x, y, scaleX, scaleY, shearY.
 */
public class TransformMapping {
  public String from, to;
  public double scale, offset;
  /** Null when unset. */
  public Double min, max;
}
