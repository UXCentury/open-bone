package com.openbone.runtime;

import com.openbone.runtime.data.BoneData;
import com.openbone.runtime.data.Inherit;
import java.util.ArrayList;
import java.util.List;

/** A bone of a {@link Skeleton}: local pose (written by animations), applied values and world matrix. */
public final class Bone {
  public final BoneData data;
  public Bone parent;
  public final List<Bone> children = new ArrayList<>();
  /** Local pose written by animations, sliders, bindings and scripts. */
  public double x, y, rotation, scaleX = 1, scaleY = 1, shearX, shearY;
  /** Inherit mode used this frame (setup value, or an inherit key). */
  public Inherit inherit = Inherit.normal;
  /** False while the bone is skin-only and the current skin does not list it. */
  public boolean active = true;
  /** Local values used for the world transform this frame (constraints may change them). */
  public final LocalTransform applied = new LocalTransform();
  public final Affine world = new Affine();

  public Bone(BoneData data) {
    this.data = data;
    setToSetupPose();
    resetApplied();
  }

  public String name() {
    return data.name;
  }

  public void setToSetupPose() {
    BoneData d = data;
    x = d.x;
    y = d.y;
    rotation = d.rotation;
    scaleX = d.scaleX;
    scaleY = d.scaleY;
    shearX = d.shearX;
    shearY = d.shearY;
    inherit = d.inherit;
  }

  public void resetApplied() {
    LocalTransform a = applied;
    a.x = x;
    a.y = y;
    a.rotation = rotation;
    a.scaleX = scaleX;
    a.scaleY = scaleY;
    a.shearX = shearX;
    a.shearY = shearY;
  }

  public void updateWorld(Affine root) {
    world.set(MathUtil.boneWorld(parent != null ? parent.world : root, applied, parent != null ? inherit : Inherit.normal));
  }

  /** After a constraint wrote {@link #world} directly: store matching local values in {@link #applied}. */
  public void syncApplied(Affine root) {
    MathUtil.localFromWorld(parent != null ? parent.world : root, world, parent != null ? inherit : Inherit.normal, applied);
  }

  public void updateSubtree(Affine root, boolean includeSelf) {
    if (!active) return;
    if (includeSelf) updateWorld(root);
    for (Bone c : children) c.updateSubtree(root, true);
  }

  public double worldX() {
    return world.x;
  }

  public double worldY() {
    return world.y;
  }

  public double worldRotation() {
    return world.rotation();
  }

  /** World point to this bone's local space. */
  public double[] worldToLocal(double wx, double wy) {
    Affine inv = world.invert();
    return new double[] {inv.applyX(wx, wy), inv.applyY(wx, wy)};
  }

  /** Local pose property by name ("x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"); NaN if unknown. */
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

  /** Set a local pose property by name; returns false if the name is not a bone property. */
  public boolean set(String property, double v) {
    switch (property) {
      case "x": x = v; return true;
      case "y": y = v; return true;
      case "rotation": rotation = v; return true;
      case "scaleX": scaleX = v; return true;
      case "scaleY": scaleY = v; return true;
      case "shearX": shearX = v; return true;
      case "shearY": shearY = v; return true;
      default: return false;
    }
  }

  @Override
  public String toString() {
    return data.name;
  }
}
