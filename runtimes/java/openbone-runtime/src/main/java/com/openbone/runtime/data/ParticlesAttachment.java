package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

/** A particle emitter. Missing fields take the defaults below (core/particles.ts defaultParticleSettings). */
public class ParticlesAttachment extends Attachment {
  public boolean emitting = true;
  public double rate = 20;
  public final List<Burst> bursts = new ArrayList<>();
  public double maxParticles = 200, duration = 1;
  public boolean loop = true, prewarm = false;
  /** "point", "circle", "box" or "cone". */
  public String shape = "point";
  public double x, y, rotation = 90, angle = 30, radius = 10, width = 40, height = 40;
  /** "world" or "local". */
  public String space = "world";
  public double[] lifetime = {0.8, 1.2}, speed = {80, 120};
  public double gravity, drag;
  public double[] startSize = {10, 14}, endSize = {2, 4}, startRotation = {0, 0}, endRotation = {0, 0}, angularVelocity = {0, 0};
  public final List<ColorStop> colors = new ArrayList<>();
  public String blend = "normal";
  /** "circle", "square", "spark" or "image". */
  public String look = "circle";
  public String image;
  public double stretch = 0.05, seed = 1;

  public ParticlesAttachment() {
    super("particles");
  }

  public static class Burst {
    public double time, count;
  }

  public static class ColorStop {
    public double t;
    public String color;

    public ColorStop() {}

    public ColorStop(double t, String color) {
      this.t = t;
      this.color = color;
    }
  }
}
