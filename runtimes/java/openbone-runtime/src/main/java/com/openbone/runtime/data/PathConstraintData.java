package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class PathConstraintData extends ConstraintData {
  public final List<String> bones = new ArrayList<>();
  /** Slot id holding the path attachment. */
  public String target;
  /** "fixed" or "percent". */
  public String positionMode = "percent";
  /** "length", "fixed", "percent" or "proportional". */
  public String spacingMode = "length";
  /** "tangent", "chain" or "chainScale". */
  public String rotateMode = "tangent";
  public double offsetRotation, position, spacing, mixRotate, mixX, mixY;

  @Override
  public String kind() {
    return "path";
  }
}
