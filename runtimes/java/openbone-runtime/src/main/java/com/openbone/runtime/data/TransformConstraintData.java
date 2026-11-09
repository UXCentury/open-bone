package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class TransformConstraintData extends ConstraintData {
  public final List<String> bones = new ArrayList<>();
  public String target;
  public double mixRotate, mixTranslate, mixScale, mixShear;
  public double offsetRotation, offsetX, offsetY, offsetScaleX, offsetScaleY, offsetShear;
  public boolean local, relative;

  @Override
  public String kind() {
    return "transform";
  }
}
