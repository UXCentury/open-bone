package com.openbone.runtime;

/** A bone's local pose values. */
public final class LocalTransform {
  public double x, y, rotation, scaleX = 1, scaleY = 1, shearX, shearY;

  /** Value by property name ("x", "rotation"…); NaN if unknown. */
  public double get(String property) {
    switch (property) {
      case "x": return x;
      case "y": return y;
      case "rotation": return rotation;
      case "scaleX": return scaleX;
      case "scaleY": return scaleY;
      case "shearX": return shearX;
      case "shearY": return shearY;
      default: return Double.NaN;
    }
  }

  /** Set a value by property name; unknown names are ignored. */
  public void set(String property, double v) {
    switch (property) {
      case "x": x = v; break;
      case "y": y = v; break;
      case "rotation": rotation = v; break;
      case "scaleX": scaleX = v; break;
      case "scaleY": scaleY = v; break;
      case "shearX": shearX = v; break;
      case "shearY": shearY = v; break;
      default: break;
    }
  }

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
