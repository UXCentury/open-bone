package com.openbone.runtime;

import com.openbone.runtime.data.Inherit;

/** core/math.ts: matrices, inherit modes, angles, colours, hit tests. */
public final class MathUtil {
  private MathUtil() {}

  public static final double DEG = Math.PI / 180;
  public static final double RAD = 180 / Math.PI;

  public static Affine localMatrix(double x, double y, double rotation, double scaleX, double scaleY, double shearX, double shearY) {
    double rx = (rotation + shearX) * DEG;
    double ry = (rotation + 90 + shearY) * DEG;
    return new Affine(Math.cos(rx) * scaleX, Math.cos(ry) * scaleY, Math.sin(rx) * scaleX, Math.sin(ry) * scaleY, x, y);
  }

  public static Affine localMatrix(LocalTransform t) {
    return localMatrix(t.x, t.y, t.rotation, t.scaleX, t.scaleY, t.shearX, t.shearY);
  }

  /** World matrix of a bone from its parent's (null = none) and its local pose, by inherit mode. */
  public static Affine boneWorld(Affine parent, LocalTransform local, Inherit inherit) {
    return boneWorld(parent, local.x, local.y, local.rotation, local.scaleX, local.scaleY, local.shearX, local.shearY, inherit);
  }

  public static Affine boneWorld(Affine parent, double x, double y, double rotation, double scaleX, double scaleY, double shearX, double shearY, Inherit inherit) {
    Affine l = localMatrix(x, y, rotation, scaleX, scaleY, shearX, shearY);
    if (parent == null) return l;
    double wx = parent.applyX(x, y), wy = parent.applyY(x, y);
    switch (inherit) {
      case onlyTranslation:
        l.x = wx;
        l.y = wy;
        return l;
      case noRotation: {
        double sx = Math.hypot(parent.a, parent.c);
        double sy = Math.hypot(parent.b, parent.d);
        return new Affine(l.a * sx, l.b * sy, l.c * sx, l.d * sy, wx, wy);
      }
      case noScale: {
        double sx = Math.hypot(parent.a, parent.c);
        if (sx == 0) sx = 1;
        double sy = Math.hypot(parent.b, parent.d);
        if (sy == 0) sy = 1;
        Affine p = new Affine(parent.a / sx, parent.b / sy, parent.c / sx, parent.d / sy, 0, 0);
        Affine m = Affine.multiply(p, l);
        m.x = wx;
        m.y = wy;
        return m;
      }
      default:
        return Affine.multiply(parent, l);
    }
  }

  /** Local values putting a bone at {@code childWorld} under {@code parentWorld}; shear X kept from {@code keep}. */
  public static void localFromWorld(Affine parentWorld, Affine childWorld, Inherit inherit, LocalTransform keep) {
    Affine inv = parentWorld.invert();
    double x = inv.applyX(childWorld.x, childWorld.y), y = inv.applyY(childWorld.x, childWorld.y);
    if (inherit != Inherit.normal) {
      keep.x = x;
      keep.y = y;
      return;
    }
    Affine m = Affine.multiply(inv, childWorld);
    double rotation = Math.atan2(m.c, m.a) * RAD - keep.shearX;
    double scaleX = Math.hypot(m.a, m.c);
    double scaleY = Math.hypot(m.b, m.d);
    double shearY = wrapDeg(Math.atan2(m.d, m.b) * RAD - 90 - rotation);
    keep.x = x;
    keep.y = y;
    keep.rotation = wrapDeg(rotation);
    keep.scaleX = scaleX;
    keep.scaleY = scaleY;
    keep.shearY = shearY;
  }

  /** Wrap degrees into (-180, 180] (JS {@code %} semantics). */
  public static double wrapDeg(double d) {
    d %= 360;
    if (d > 180) d -= 360;
    else if (d <= -180) d += 360;
    return d;
  }

  public static double lerp(double a, double b, double t) {
    return a + (b - a) * t;
  }

  public static double lerpAngle(double a, double b, double t) {
    return a + wrapDeg(b - a) * t;
  }

  public static double clamp(double v, double lo, double hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** {@code Math.sign(x) || 1}. */
  public static double detSign(Affine m) {
    double det = m.a * m.d - m.b * m.c;
    return det > 0 ? 1 : det < 0 ? -1 : 1;
  }

  // ---------------- Colours ----------------

  /** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" to RGBA 0..1 (not premultiplied). */
  public static double[] parseHex(String hex) {
    String h = hex == null ? "" : hex;
    int i = h.indexOf('#');
    if (i >= 0) h = h.substring(0, i) + h.substring(i + 1);
    if (h.length() == 3 || h.length() == 4) {
      StringBuilder b = new StringBuilder();
      for (int k = 0; k < h.length(); k++) b.append(h.charAt(k)).append(h.charAt(k));
      h = b.toString();
    }
    return new double[] {hexByte(h, 0), hexByte(h, 2), hexByte(h, 4), h.length() >= 8 ? hexByte(h, 6) : 1};
  }

  /** {@code parseInt(h.slice(i, i + 2), 16) / 255} with parseInt's prefix rules (NaN when no digit). */
  private static double hexByte(String h, int i) {
    if (i >= h.length()) return Double.NaN;
    String s = h.substring(i, Math.min(h.length(), i + 2)).trim();
    int v = 0, n = 0;
    for (int k = 0; k < s.length(); k++) {
      int dgt = Character.digit(s.charAt(k), 16);
      if (dgt < 0) break;
      v = v * 16 + dgt;
      n++;
    }
    return n == 0 ? Double.NaN : v / 255.0;
  }

  public static double[] lerpColor(double[] a, double[] b, double t) {
    return new double[] {lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)};
  }

  public static double[] mulColor(double[] a, double[] b) {
    return new double[] {a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]};
  }

  /** Even-odd point in polygon (flat x,y). */
  public static boolean pointInPolygon(double px, double py, double[] poly) {
    boolean inside = false;
    int n = poly.length / 2;
    for (int i = 0, j = n - 1; i < n; j = i++) {
      double xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
      if ((yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}
