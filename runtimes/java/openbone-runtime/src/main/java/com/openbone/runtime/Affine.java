package com.openbone.runtime;

/** 2D affine transform {@code [a b; c d | x y]}: maps local (lx, ly) to (a·lx + b·ly + x, c·lx + d·ly + y). */
public final class Affine {
  public double a = 1, b, c, d = 1, x, y;

  public Affine() {}

  public Affine(double a, double b, double c, double d, double x, double y) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.x = x;
    this.y = y;
  }

  public Affine copy() {
    return new Affine(a, b, c, d, x, y);
  }

  public void set(Affine m) {
    a = m.a;
    b = m.b;
    c = m.c;
    d = m.d;
    x = m.x;
    y = m.y;
  }

  public static Affine multiply(Affine p, Affine l) {
    return new Affine(
        p.a * l.a + p.b * l.c,
        p.a * l.b + p.b * l.d,
        p.c * l.a + p.d * l.c,
        p.c * l.b + p.d * l.d,
        p.a * l.x + p.b * l.y + p.x,
        p.c * l.x + p.d * l.y + p.y);
  }

  public Affine invert() {
    double det = a * d - b * c;
    if (det == 0) det = 1e-9;
    double ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return new Affine(ia, ib, ic, id, -(ia * x + ib * y), -(ic * x + id * y));
  }

  public double applyX(double lx, double ly) {
    return a * lx + b * ly + x;
  }

  public double applyY(double lx, double ly) {
    return c * lx + d * ly + y;
  }

  /** Rotation of the X axis in degrees. */
  public double rotation() {
    return Math.atan2(c, a) * MathUtil.RAD;
  }

  public double scaleX() {
    return Math.hypot(a, c);
  }

  public double scaleY() {
    return Math.hypot(b, d);
  }

  @Override
  public String toString() {
    return "[" + a + ", " + b + ", " + c + ", " + d + " | " + x + ", " + y + "]";
  }
}
