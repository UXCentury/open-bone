package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class TransformConstraintData extends ConstraintData {
  public final List<String> bones = new ArrayList<>();
  public String target;
  public double mixRotate, mixTranslate, mixScale, mixShear;
  public double offsetRotation, offsetX, offsetY, offsetScaleX, offsetScaleY, offsetShear;
  public boolean local, relative;
  /** Property mapping; when non-empty it replaces the classic copy (docs/runtime-spec.md §7.2). */
  public final List<TransformMapping> map = new ArrayList<>();
  /** Mapping only: read the target's local values; null = the same space as {@code local}. */
  public Boolean localSource;

  @Override
  public String kind() {
    return "transform";
  }
}
