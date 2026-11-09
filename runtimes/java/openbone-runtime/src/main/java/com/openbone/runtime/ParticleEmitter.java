package com.openbone.runtime;

import com.openbone.runtime.data.ParticlesAttachment;
import java.util.ArrayList;
import java.util.List;

/**
 * Simulation state of one particles attachment on one slot (runtime/particles.ts). Advanced in fixed steps; the result
 * depends only on the seed and the sequence of (bone transform, values) per step.
 */
public final class ParticleEmitter {
  /** Fixed simulation step (seconds). */
  public static final double STEP = 1.0 / 60;
  /** Most steps taken in one realtime frame. */
  public static final int MAX_STEPS = 30;
  private static final int MAX_PREWARM_STEPS = 600;
  private static final double EPS = 1e-9;

  /** Seedable PRNG (mulberry32), identical on every platform. */
  public static final class Rng {
    private int s;

    public Rng(int seed) {
      s = seed;
    }

    public double next() {
      s = s + 0x6d2b79f5;
      int t = s;
      t = (t ^ (t >>> 15)) * (t | 1);
      t ^= t + (t ^ (t >>> 7)) * (t | 61);
      return ((t ^ (t >>> 14)) & 0xffffffffL) / 4294967296.0;
    }

    public double range(double[] r) {
      return r[0] == r[1] ? r[0] : r[0] + (r[1] - r[0]) * next();
    }

    public double between(double a, double b) {
      return a + (b - a) * next();
    }
  }

  /** FNV-1a over UTF-16 code units, unsigned 32-bit (returned in an int). */
  public static int hashString(String s) {
    int h = 0x811c9dc5;
    for (int i = 0; i < s.length(); i++) h = (h ^ s.charAt(i)) * 0x01000193;
    return h;
  }

  /** One live particle (world space, or slot-bone space for local emitters). */
  public static final class Particle {
    public double x, y, vx, vy, age, life, size0, size1, rot0, rot1, spin;
  }

  /** Live keyable values; null fields fall back to the attachment's. */
  public static final class Values {
    public Boolean emitting;
    public Double rate;

    public Values copy() {
      Values v = new Values();
      v.emitting = emitting;
      v.rate = rate;
      return v;
    }
  }

  /** Quads TL, TR, BR, BL with unit uvs and per-vertex RGBA (float32 values held in doubles). */
  public static final class Geometry {
    public int count;
    public double[] vertices, uvs, colors;
    public int[] indices;
  }

  public final ParticlesAttachment data;
  public final List<Particle> particles = new ArrayList<>();
  public double cycle;
  public int steps;
  /** Particles requested by emitParticles(), spawned on the next step. */
  public double pending;
  private double acc;
  private boolean wasEmitting;
  private final Rng rng;
  private double lastX = Double.NaN, lastY = Double.NaN;

  public ParticleEmitter(ParticlesAttachment data, int salt) {
    this.data = data;
    rng = new Rng(toInt32(data.seed) ^ salt);
  }

  /** ECMAScript ToInt32. */
  static int toInt32(double v) {
    if (!Double.isFinite(v)) return 0;
    double t = v < 0 ? Math.ceil(v) : Math.floor(v);
    double m = t % 4294967296.0;
    if (m < 0) m += 4294967296.0;
    return (int) (long) m;
  }

  public int alive() {
    return particles.size();
  }

  /** Restart the emitter cycle (bursts at time 0 fire again on the next step). */
  public void restart() {
    cycle = 0;
    acc = 0;
    wasEmitting = false;
  }

  public void step(double h, Affine m, Values values) {
    ParticlesAttachment d = data;
    boolean emitting = values != null && values.emitting != null ? values.emitting : d.emitting;
    double rate = values != null && values.rate != null ? values.rate : d.rate;
    if (steps == 0 && emitting && d.prewarm && d.loop) {
      int n = (int) Math.min(MAX_PREWARM_STEPS, Math.ceil(d.duration / h - 1e-6));
      lastX = m.x;
      lastY = m.y;
      for (int i = 0; i < n; i++) advance(h, m, true, rate);
    }
    advance(h, m, emitting, rate);
    steps++;
  }

  private void advance(double h, Affine m, boolean emitting, double rate) {
    ParticlesAttachment d = data;
    double damp = d.drag > 0 ? Math.exp(-d.drag * h) : 1;
    double g = d.gravity * h;
    int w = 0;
    List<Particle> ps = particles;
    for (int i = 0; i < ps.size(); i++) {
      Particle p = ps.get(i);
      p.age += h;
      if (p.age >= p.life) continue;
      p.vy -= g;
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * h;
      p.y += p.vy * h;
      ps.set(w++, p);
    }
    while (ps.size() > w) ps.remove(ps.size() - 1);

    if (emitting && !wasEmitting) {
      cycle = 0;
      acc = 0;
    }
    wasEmitting = emitting;
    boolean active = emitting && (d.loop || cycle < d.duration);
    double streamed = 0;
    double burst = pending;
    pending = 0;
    if (active) {
      acc += Math.max(0, rate) * h;
      streamed = Math.floor(acc);
      acc -= streamed;
      double start = cycle, end = start + h;
      boolean wraps = end >= d.duration - EPS;
      double rest = end - d.duration;
      for (ParticlesAttachment.Burst b : d.bursts) {
        if (b.time > d.duration + EPS) continue;
        if (b.time >= start - EPS && b.time < end - EPS) burst += b.count;
        else if (wraps && d.loop && b.time < rest - EPS) burst += b.count;
      }
      cycle = wraps ? (d.loop ? Math.max(0, rest) : d.duration) : end;
    }
    double room = Math.max(0, d.maxParticles - ps.size());
    double nb = Math.min(burst, room);
    double ns = Math.min(streamed, room - nb);
    double lx = Double.isNaN(lastX) ? m.x : lastX;
    double ly = Double.isNaN(lastY) ? m.y : lastY;
    for (int i = 0; i < nb; i++) spawn(m, 0, m.x, m.y);
    for (int i = 0; i < ns; i++) {
      double k = (i + 1) / ns;
      spawn(m, (1 - k) * h, MathUtil.lerp(lx, m.x, k), MathUtil.lerp(ly, m.y, k));
    }
    lastX = m.x;
    lastY = m.y;
  }

  private void spawn(Affine m, double preAge, double ox, double oy) {
    ParticlesAttachment d = data;
    Rng r = rng;
    double rot = d.rotation * MathUtil.DEG;
    double half = (d.angle / 2) * MathUtil.DEG;
    double f = 0, s = 0;
    double dir = rot + r.between(-half, half);
    switch (d.shape) {
      case "circle": {
        double a = r.next() * Math.PI * 2;
        double rad = Math.sqrt(r.next()) * d.radius;
        f = Math.cos(a) * rad;
        s = Math.sin(a) * rad;
        dir = rot + a;
        break;
      }
      case "box":
        s = r.between(-d.width / 2, d.width / 2);
        f = r.between(-d.height / 2, d.height / 2);
        break;
      case "cone":
        s = r.between(-d.radius, d.radius);
        if (d.radius > 0) dir = rot + (s / d.radius) * half;
        break;
      default:
        break;
    }
    double cos = Math.cos(rot), sin = Math.sin(rot);
    double x = d.x + f * cos - s * sin;
    double y = d.y + f * sin + s * cos;
    double speed = r.range(d.speed);
    double vx = Math.cos(dir) * speed, vy = Math.sin(dir) * speed;
    if (d.space.equals("world")) {
      double wx = m.a * x + m.b * y + ox, wy = m.c * x + m.d * y + oy;
      x = wx;
      y = wy;
      double tx = m.a * vx + m.b * vy, ty = m.c * vx + m.d * vy;
      double len = Math.hypot(tx, ty);
      vx = len > 1e-9 ? (tx / len) * speed : 0;
      vy = len > 1e-9 ? (ty / len) * speed : 0;
    }
    Particle p = new Particle();
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = Math.max(1e-3, r.range(d.lifetime));
    p.size0 = r.range(d.startSize);
    p.size1 = r.range(d.endSize);
    p.rot0 = r.range(d.startRotation);
    p.rot1 = r.range(d.endRotation);
    p.spin = r.range(d.angularVelocity);
    if (preAge > 0) {
      p.age = preAge;
      p.vy -= d.gravity * preAge;
      p.x += p.vx * preAge;
      p.y += p.vy * preAge;
    }
    if (p.age < p.life) particles.add(p);
  }

  /** Colour of the gradient at life fraction t. */
  public static double[] gradientColor(List<ParticlesAttachment.ColorStop> stops, double t) {
    if (stops.isEmpty()) return new double[] {1, 1, 1, 1};
    List<ParticlesAttachment.ColorStop> sorted = stops;
    boolean unsorted = false;
    for (int i = 1; i < stops.size(); i++) if (stops.get(i).t < stops.get(i - 1).t) unsorted = true;
    if (stops.size() > 1 && unsorted) {
      sorted = new ArrayList<>(stops);
      sorted.sort((a, b) -> {
        double x = a.t - b.t;
        return x < 0 ? -1 : x > 0 ? 1 : 0;
      });
    }
    if (t <= sorted.get(0).t) return MathUtil.parseHex(sorted.get(0).color);
    ParticlesAttachment.ColorStop last = sorted.get(sorted.size() - 1);
    if (t >= last.t) return MathUtil.parseHex(last.color);
    for (int i = 1; i < sorted.size(); i++) {
      ParticlesAttachment.ColorStop b = sorted.get(i);
      if (t <= b.t) {
        ParticlesAttachment.ColorStop a = sorted.get(i - 1);
        double span = b.t - a.t;
        return MathUtil.lerpColor(MathUtil.parseHex(a.color), MathUtil.parseHex(b.color), (t - a.t) / (span == 0 ? 1 : span));
      }
    }
    return MathUtil.parseHex(last.color);
  }

  private static final double[] UNIT_UVS = {0, 0, 1, 0, 1, 1, 0, 1};

  /** Quads {@code frac} seconds after the last step; {@code m} is the slot bone's world matrix, {@code tint} the slot colour. */
  public Geometry geometry(double frac, Affine m, double[] tint) {
    ParticlesAttachment d = data;
    List<Particle> ps = particles;
    int n = Math.min(ps.size(), 16383);
    double[] vertices = new double[n * 8], colors = new double[n * 16], uvs = new double[n * 8];
    int[] indices = new int[n * 6];
    boolean local = d.space.equals("local");
    double sizeScale = local ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    int k = 0;
    for (int i = 0; i < n; i++) {
      Particle p = ps.get(i);
      double age = Math.min(p.age + frac, p.life);
      double t = age / p.life;
      double x = p.x + p.vx * frac, y = p.y + p.vy * frac, vx = p.vx, vy = p.vy;
      if (local) {
        double wx = m.a * x + m.b * y + m.x, wy = m.c * x + m.d * y + m.y;
        x = wx;
        y = wy;
        double tx = m.a * vx + m.b * vy;
        vy = m.c * vx + m.d * vy;
        vx = tx;
      }
      double size = Math.max(0, MathUtil.lerp(p.size0, p.size1, t)) * sizeScale;
      double[] c = gradientColor(d.colors, t);
      double a = c[3] * tint[3];
      if (size <= 0 || a <= 0) continue;
      double ux, uy, hw;
      if (d.look.equals("spark")) {
        double sp = Math.hypot(vx, vy);
        double len = size / 2 + (sp * d.stretch) / 2;
        double ang = sp > 1e-6 ? Math.atan2(vy, vx) : (MathUtil.lerp(p.rot0, p.rot1, t) + p.spin * age) * MathUtil.DEG;
        ux = Math.cos(ang) * len;
        uy = Math.sin(ang) * len;
        hw = size / 2;
      } else {
        double ang = (MathUtil.lerp(p.rot0, p.rot1, t) + p.spin * age) * MathUtil.DEG;
        ux = (Math.cos(ang) * size) / 2;
        uy = (Math.sin(ang) * size) / 2;
        hw = size / 2;
      }
      double ul = Math.hypot(ux, uy);
      if (ul == 0 || Double.isNaN(ul)) ul = 1;
      double vx2 = (-uy / ul) * hw, vy2 = (ux / ul) * hw;
      int o = k * 8;
      vertices[o] = JsNum.f32(x - ux + vx2);
      vertices[o + 1] = JsNum.f32(y - uy + vy2);
      vertices[o + 2] = JsNum.f32(x + ux + vx2);
      vertices[o + 3] = JsNum.f32(y + uy + vy2);
      vertices[o + 4] = JsNum.f32(x + ux - vx2);
      vertices[o + 5] = JsNum.f32(y + uy - vy2);
      vertices[o + 6] = JsNum.f32(x - ux - vx2);
      vertices[o + 7] = JsNum.f32(y - uy - vy2);
      System.arraycopy(UNIT_UVS, 0, uvs, o, 8);
      double r = JsNum.f32(c[0] * tint[0]), gg = JsNum.f32(c[1] * tint[1]), b = JsNum.f32(c[2] * tint[2]), af = JsNum.f32(a);
      for (int j = 0; j < 4; j++) {
        int q = k * 16 + j * 4;
        colors[q] = r;
        colors[q + 1] = gg;
        colors[q + 2] = b;
        colors[q + 3] = af;
      }
      int ii = k * 6, base = k * 4;
      indices[ii] = base;
      indices[ii + 1] = base + 1;
      indices[ii + 2] = base + 2;
      indices[ii + 3] = base;
      indices[ii + 4] = base + 2;
      indices[ii + 5] = base + 3;
      k++;
    }
    Geometry geo = new Geometry();
    geo.count = k;
    geo.vertices = java.util.Arrays.copyOf(vertices, k * 8);
    geo.uvs = java.util.Arrays.copyOf(uvs, k * 8);
    geo.colors = java.util.Arrays.copyOf(colors, k * 16);
    geo.indices = java.util.Arrays.copyOf(indices, k * 6);
    return geo;
  }
}
