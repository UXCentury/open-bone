package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class SkeletonData {
  public final List<BoneData> bones = new ArrayList<>();
  public final List<SlotData> slots = new ArrayList<>();
  public final List<SkinData> skins = new ArrayList<>();
  public final List<IkConstraintData> ik = new ArrayList<>();
  public final List<TransformConstraintData> transform = new ArrayList<>();
  public final List<PathConstraintData> path = new ArrayList<>();
  public final List<PhysicsConstraintData> physics = new ArrayList<>();
  public final List<SliderData> sliders = new ArrayList<>();
  /** Units per 100 at which physics gravity/wind and IK softness are authored; null = 100. */
  public Double referenceScale;
}
