package com.openbone.runtime;

/** A bone's local pose values. */
public final class LocalTransform {
  public double x, y, rotation, scaleX = 1, scaleY = 1, shearX, shearY;

  public void set(LocalTransform o) {
    x = o.x;
    y = o.y;
    rotation = o.rotation;
    scaleX = o.scaleX;
    scaleY = o.scaleY;
    shearX = o.shearX;
    shearY = o.shearY;
  }
}
