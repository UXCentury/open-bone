package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class IkConstraintData extends ConstraintData {
  public final List<String> bones = new ArrayList<>();
  public String target;
  public double mix = 1, softness;
  public boolean bendPositive = true, stretch, compress, uniform;

  @Override
  public String kind() {
    return "ik";
  }
}
