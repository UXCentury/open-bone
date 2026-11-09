package com.openbone.runtime.data;

/** How a bone inherits its parent's transform. */
public enum Inherit {
  normal, onlyTranslation, noRotation, noScale;

  public static Inherit parse(String s) {
    if (s == null) return normal;
    switch (s) {
      case "onlyTranslation": return onlyTranslation;
      case "noRotation": return noRotation;
      case "noScale": return noScale;
      default: return normal;
    }
  }
}
