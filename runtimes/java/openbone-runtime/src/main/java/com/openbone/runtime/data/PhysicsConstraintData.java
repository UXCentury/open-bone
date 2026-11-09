package com.openbone.runtime.data;

public class PhysicsConstraintData extends ConstraintData {
  public String bone;
  public double x, y, rotate, scaleX, inertia, strength, damping, mass, gravity, wind, mix, fps;

  @Override
  public String kind() {
    return "physics";
  }
}
