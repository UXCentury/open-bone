package com.openbone.runtime.data;

public class PhysicsConstraintData extends ConstraintData {
  public String bone;
  public double x, y, rotate, scaleX, inertia, strength, damping, mass, gravity, wind, mix, fps;
  /** Keep volume when stretching ({@code scaleX}): width scales by 1 / the stretch. */
  public boolean volume;

  @Override
  public String kind() {
    return "physics";
  }
}
