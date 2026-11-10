package com.openbone.runtime;

/**
 * Cubic bezier path for path attachments, measured by arc length (core/path.ts buildSpline). With constant speed off
 * only the segment is found by arc length; the point inside it is at the raw bezier parameter.
 */
public final class Spline {
  private static final int STEPS = 32;
  public final boolean closed;
  /** True (default): positions inside a segment by arc length; false: by the raw bezier parameter. */
  public final boolean constantSpeed;
  public final double length;
  public final int segments;
  private final int knots;
  private final double[] ctrl, table, vertices;

  /** Point and tangent angle (radians) at a distance along the path. */
  public static final class Sample {
    public final double x, y, angle;

    Sample(double x, double y, double angle) {
      this.x = x;
      this.y = y;
      this.angle = angle;
    }
  }

  /** Knots are {@code [inX, inY, x, y, outX, outY]} each. Constant speed on. */
  public Spline(double[] vertices, boolean closed) {
    this(vertices, closed, true);
  }

  /** Knots are {@code [inX, inY, x, y, outX, outY]} each. */
  public Spline(double[] vertices, boolean closed, boolean constantSpeed) {
    this.vertices = vertices;
    this.closed = closed;
    this.constantSpeed = constantSpeed;
    knots = vertices.length / 6;
    int segCount = knots < 2 ? 0 : closed ? knots : knots - 1;
    segments = segCount;
    ctrl = new double[Math.max(segCount, 1) * 8];
    for (int s = 0; s < segCount; s++) {
      int a = s * 6, b = ((s + 1) % knots) * 6, o = s * 8;
      ctrl[o] = vertices[a + 2];
      ctrl[o + 1] = vertices[a + 3];
      ctrl[o + 2] = vertices[a + 4];
      ctrl[o + 3] = vertices[a + 5];
      ctrl[o + 4] = vertices[b];
      ctrl[o + 5] = vertices[b + 1];
      ctrl[o + 6] = vertices[b + 2];
      ctrl[o + 7] = vertices[b + 3];
    }
    table = new double[segCount * STEPS + 1];
    double total = 0;
    for (int s = 0; s < segCount; s++) {
      int o = s * 8;
      double px = ctrl[o], py = ctrl[o + 1];
      for (int i = 1; i <= STEPS; i++) {
        double t = (double) i / STEPS;
        double x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
        double y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
        total += Math.hypot(x - px, y - py);
        table[s * STEPS + i] = total;
        px = x;
        py = y;
      }
    }
    length = total;
  }

  private static double bez(double a, double b, double c, double d, double t) {
    double u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  }

  private static double bezD(double a, double b, double c, double d, double t) {
    double u = 1 - t;
    return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
  }

  private Sample point(int s, double t) {
    int o = s * 8;
    double x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
    double y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
    double dx = bezD(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
    double dy = bezD(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
    if (dx * dx + dy * dy < 1e-12) {
      double t0 = Math.max(0, t - 1e-3), t1 = Math.min(1, t + 1e-3);
      dx = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t1) - bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t0);
      dy = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t1) - bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t0);
      if (dx * dx + dy * dy < 1e-18) {
        dx = ctrl[o + 6] - ctrl[o];
        dy = ctrl[o + 7] - ctrl[o + 1];
      }
    }
    return new Sample(x, y, Math.atan2(dy, dx));
  }

  /** Open paths extend straight past their ends; closed paths wrap. */
  public Sample sample(double distance) {
    if (segments == 0) {
      double x = knots > 0 ? vertices[2] : 0, y = knots > 0 ? vertices[3] : 0;
      return new Sample(x, y, 0);
    }
    double d = distance;
    if (closed && length > 0) d = ((d % length) + length) % length;
    else if (d <= 0 || d >= length) {
      Sample end = d <= 0 ? point(0, 0) : point(segments - 1, 1);
      double over = d <= 0 ? d : d - length;
      return new Sample(end.x + Math.cos(end.angle) * over, end.y + Math.sin(end.angle) * over, end.angle);
    }
    if (!constantSpeed) {
      // Segment by arc length (the first whose end is past d), then the raw parameter inside it.
      int seg = 0;
      while (seg < segments - 1 && table[(seg + 1) * STEPS] <= d) seg++;
      double start = table[seg * STEPS];
      double span = table[(seg + 1) * STEPS] - start;
      return point(seg, span > 0 ? Math.min(1, (d - start) / span) : 0);
    }
    int lo = 0, hi = table.length - 1;
    while (hi - lo > 1) {
      int mid = (lo + hi) >> 1;
      if (table[mid] <= d) lo = mid;
      else hi = mid;
    }
    double span = table[hi] - table[lo];
    double f = span > 0 ? (d - table[lo]) / span : 0;
    int seg = Math.min(segments - 1, (int) Math.floor((double) lo / STEPS));
    double t = (lo - seg * STEPS + f) / STEPS;
    return point(seg, Math.min(1, t));
  }
}
