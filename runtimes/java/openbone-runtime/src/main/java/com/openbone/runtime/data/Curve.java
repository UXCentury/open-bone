package com.openbone.runtime.data;

/** Key curve: linear, stepped or a cubic bezier [x1, y1, x2, y2]. */
public final class Curve {
  public static final Curve LINEAR = new Curve(0, null);
  public static final Curve STEPPED = new Curve(1, null);
  /** 0 linear, 1 stepped, 2 bezier. */
  public final int kind;
  public final double[] bezier;

  private Curve(int kind, double[] bezier) {
    this.kind = kind;
    this.bezier = bezier;
  }

  public static Curve bezier(double x1, double y1, double x2, double y2) {
    return new Curve(2, new double[] {x1, y1, x2, y2});
  }

  public boolean isStepped() {
    return kind == 1;
  }

  /** Eased fraction for t in 0..1 (bezier solved by bisection, as in core/math.ts evalCurve). */
  public double apply(double t) {
    if (kind == 0) return t;
    if (kind == 1) return 0;
    double x1 = bezier[0], y1 = bezier[1], x2 = bezier[2], y2 = bezier[3];
    double lo = 0, hi = 1, s = t;
    for (int i = 0; i < 24; i++) {
      double x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s - t;
      if (Math.abs(x) < 1e-6) break;
      if (x > 0) hi = s;
      else lo = s;
      s = (lo + hi) / 2;
    }
    return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  }
}
