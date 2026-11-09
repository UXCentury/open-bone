package com.openbone.runtime.data;

public class BoneData {
  public String id, name, parent;
  public double length, x, y, rotation, scaleX = 1, scaleY = 1, shearX, shearY;
  public Inherit inherit = Inherit.normal;
  public String color;

  /** Bone setup property by name ("x", "rotation"…); NaN if unknown. */
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
}
