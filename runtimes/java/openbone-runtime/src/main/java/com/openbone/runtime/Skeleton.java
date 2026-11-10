package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import com.openbone.runtime.data.AtlasData;
import com.openbone.runtime.data.Attachment;
import com.openbone.runtime.data.BoneData;
import com.openbone.runtime.data.BoundingBoxAttachment;
import com.openbone.runtime.data.ClippingAttachment;
import com.openbone.runtime.data.ConstraintData;
import com.openbone.runtime.data.IkConstraintData;
import com.openbone.runtime.data.ImageAsset;
import com.openbone.runtime.data.Inherit;
import com.openbone.runtime.data.MeshAttachment;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.runtime.data.ParticlesAttachment;
import com.openbone.runtime.data.PathAttachment;
import com.openbone.runtime.data.PathConstraintData;
import com.openbone.runtime.data.PhysicsConstraintData;
import com.openbone.runtime.data.PointAttachment;
import com.openbone.runtime.data.RegionAttachment;
import com.openbone.runtime.data.SequenceAttachment;
import com.openbone.runtime.data.ShapeAttachment;
import com.openbone.runtime.data.SkinData;
import com.openbone.runtime.data.SliderData;
import com.openbone.runtime.data.SlotData;
import com.openbone.runtime.data.StateMachineData;
import com.openbone.runtime.data.TextAttachment;
import com.openbone.runtime.data.Timeline;
import com.openbone.runtime.data.TransformConstraintData;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * Pose state of one document: bones, slots, skin, constraint values, physics and particles; produces the draw list.
 * Port of runtime/skeleton.ts (docs/runtime-spec.md §2–§8).
 */
public final class Skeleton {
  public final OpenBoneDocument doc;
  public final List<Bone> bones = new ArrayList<>();
  public final List<Slot> slots = new ArrayList<>();
  public List<Slot> drawOrder = new ArrayList<>();
  public SkinData skin;
  /** Live (keyable) constraint values by constraint id. */
  public final Map<String, ConstraintValues> constraintValues = new HashMap<>();
  /** Placement of the skeleton (applied to root bones). */
  public double x, y, scaleX = 1, scaleY = 1;
  /** Seconds passed to update(); drives sequences when no animation is applied. */
  public double clock;
  /** Local time of the dominant animation applied this frame, or null. */
  public Double animationTime;
  /** Live number input values by input id (set by the state machine). */
  public final Map<String, Double> inputValues = new HashMap<>();
  /** "realtime" (advance by update()) or "seek" (only through seekParticles). */
  public String particleClock = "realtime";
  /** Keyable emitter values by slot id. */
  public final Map<String, ParticleEmitter.Values> particleValues = new HashMap<>();
  /** Values for text templates by input name. */
  public Function<String, Object> textValues;
  /** Text shown instead of an attachment's own, by slot id. */
  public final Map<String, String> textOverrides = new HashMap<>();

  private final Map<String, Bone> boneById = new HashMap<>();
  private final Map<String, Slot> slotById = new HashMap<>();
  private final Map<String, ImageAsset> images = new HashMap<>();
  private final Map<String, Packed> packed = new HashMap<>();
  private White white;
  private final Map<String, PhysicsState> physicsState = new HashMap<>();
  private final Map<String, Double> inputDefaults = new HashMap<>();
  private final Map<String, Object> inputDefaultsByName = new HashMap<>();
  private double pendingDt;
  private Map<String, Affine> setupCache;
  private final Map<String, ParticleEmitter> emitters = new HashMap<>();
  private double particlePending, particleFrac;
  private int particleSteps;
  private final Map<String, Double> pendingBursts = new LinkedHashMap<>();
  private boolean activeComputed;
  private SkinData activeFor;
  private final Set<String> inactiveConstraints = new HashSet<>();
  private final Map<Attachment, Object[]> shapeCache = new IdentityHashMap<>();
  private final Map<Attachment, Object[]> clipCache = new IdentityHashMap<>();

  static final double[] REGION_UVS = {0, 0, 1, 0, 1, 1, 0, 1};
  static final int[] REGION_INDICES = {0, 1, 2, 0, 2, 3};
  private static final int MAX_PHYSICS_STEPS = 8;

  /** Live constraint values by property name. */
  public static final class ConstraintValues {
    private final Map<String, Double> map = new HashMap<>();

    public double get(String prop, double def) {
      Double v = map.get(prop);
      return v != null ? v : def;
    }

    public Double get(String prop) {
      return map.get(prop);
    }

    public void put(String prop, double v) {
      map.put(prop, v);
    }
  }

  /** Linear map from 0..1 image uvs to page uvs. */
  public static final class UvMap {
    final double ou, ov, su, sv;
    final boolean rotated;

    UvMap(double ou, double ov, double su, double sv, boolean rotated) {
      this.ou = ou;
      this.ov = ov;
      this.su = su;
      this.sv = sv;
      this.rotated = rotated;
    }

    static UvMap of(AtlasData.Region r, AtlasData.Page page) {
      if (r.rotated)
        return new UvMap((r.x + r.height + r.offsetY) / page.width, (r.y - r.offsetX) / page.height, r.originalHeight / page.width, r.originalWidth / page.height, true);
      return new UvMap((r.x - r.offsetX) / page.width, (r.y - r.offsetY) / page.height, r.originalWidth / page.width, r.originalHeight / page.height, false);
    }

    double[] remap(double[] uvs) {
      double[] out = new double[uvs.length];
      for (int i = 0; i < uvs.length; i += 2) {
        double u = uvs[i], v = uvs[i + 1];
        out[i] = JsNum.f32(rotated ? ou - v * su : ou + u * su);
        out[i + 1] = JsNum.f32(rotated ? ov + u * sv : ov + v * sv);
      }
      return out;
    }
  }

  private static final class Packed {
    DrawItem.TextureRef page;
    double[] rect;
    UvMap map;
    double[] regionUvs;
    double[] trim;
    double[] polyImage, polyUvs;
    int[] polyIndices;
  }

  private static final class White {
    DrawItem.TextureRef page;
    double u, v;
  }

  private static final class Particle {
    double x, y, vx, vy, px, py;

    Particle(double x, double y) {
      this.x = x;
      this.y = y;
      px = x;
      py = y;
    }
  }

  private static final class PhysicsState {
    Particle origin, tip;
    double lastOx, lastOy, lastTx, lastTy, time;
    double steps;
  }

  public Skeleton(OpenBoneDocument doc) {
    this.doc = doc;
    textValues = inputDefaultsByName::get;
    for (BoneData bd : doc.skeleton.bones) {
      Bone b = new Bone(bd);
      if (bd.parent != null) {
        b.parent = boneById.get(bd.parent);
        if (b.parent != null) b.parent.children.add(b);
      }
      bones.add(b);
      boneById.put(bd.id, b);
    }
    for (SlotData sd : doc.skeleton.slots) {
      Bone bone = boneById.get(sd.bone);
      if (bone == null) continue;
      Slot s = new Slot(sd, bone);
      slots.add(s);
      slotById.put(sd.id, s);
    }
    for (ImageAsset img : doc.images) images.put(img.id, img);
    Map<String, AtlasData.Page> pages = new HashMap<>();
    if (doc.atlas != null) {
      for (AtlasData.Page p : doc.atlas.pages) pages.put(p.id, p);
      for (AtlasData.Region r : doc.atlas.regions) {
        AtlasData.Page page = pages.get(r.page);
        if (page == null || !images.containsKey(r.image)) continue;
        Packed pk = new Packed();
        pk.page = new DrawItem.TextureRef(page.id, page.width, page.height);
        pk.map = UvMap.of(r, page);
        pk.trim = r.isTrimmed()
            ? new double[] {r.offsetX / r.originalWidth, r.offsetY / r.originalHeight, (r.offsetX + r.width) / r.originalWidth, (r.offsetY + r.height) / r.originalHeight}
            : null;
        double[] quad = pk.trim != null ? f32(new double[] {pk.trim[0], pk.trim[1], pk.trim[2], pk.trim[1], pk.trim[2], pk.trim[3], pk.trim[0], pk.trim[3]}) : REGION_UVS;
        pk.rect = new double[] {r.x, r.y, r.rotated ? r.height : r.width, r.rotated ? r.width : r.height};
        if (r.polygon != null && r.polygon.length >= 6) {
          double[] image = new double[r.polygon.length];
          for (int i = 0; i < image.length; i += 2) {
            image[i] = JsNum.f32(r.polygon[i] / r.originalWidth);
            image[i + 1] = JsNum.f32(r.polygon[i + 1] / r.originalHeight);
          }
          int n = image.length / 2;
          int[] indices = new int[(n - 2) * 3];
          for (int i = 0; i < n - 2; i++) {
            indices[i * 3] = 0;
            indices[i * 3 + 1] = i + 1;
            indices[i * 3 + 2] = i + 2;
          }
          pk.polyImage = image;
          pk.polyUvs = pk.map.remap(image);
          pk.polyIndices = indices;
        }
        pk.regionUvs = pk.map.remap(quad);
        packed.put(r.image, pk);
      }
      AtlasData.White w = doc.atlas.white;
      AtlasData.Page wp = w != null ? pages.get(w.page) : null;
      if (w != null && wp != null) {
        white = new White();
        white.page = new DrawItem.TextureRef(wp.id, wp.width, wp.height);
        white.u = (w.x + w.width / 2) / wp.width;
        white.v = (w.y + w.height / 2) / wp.height;
      }
    }
    for (StateMachineData sm : doc.stateMachines)
      for (StateMachineData.Input i : sm.inputs) {
        if (i.defaultValue instanceof Double) inputDefaults.put(i.id, (Double) i.defaultValue);
        if (!i.type.equals("trigger") && i.defaultValue != null && !inputDefaultsByName.containsKey(i.name)) inputDefaultsByName.put(i.name, i.defaultValue);
      }
    updateActive();
    setToSetupPose();
    updateWorldTransform();
  }

  private static double[] f32(double[] a) {
    for (int i = 0; i < a.length; i++) a[i] = JsNum.f32(a[i]);
    return a;
  }

  public Bone findBone(String ref) {
    Bone b = boneById.get(ref);
    if (b != null) return b;
    for (Bone x : bones) if (x.data.name.equals(ref)) return x;
    return null;
  }

  public Slot findSlot(String ref) {
    Slot s = slotById.get(ref);
    if (s != null) return s;
    for (Slot x : slots) if (x.data.name.equals(ref)) return x;
    return null;
  }

  public Bone boneById(String id) {
    return boneById.get(id);
  }

  public Slot slotById(String id) {
    return slotById.get(id);
  }

  /** Set the skin by id or name (null or unknown = none) and recompute skin bones / constraints. */
  public void setSkin(String ref) {
    SkinData found = null;
    if (ref != null && !ref.isEmpty())
      for (SkinData s : doc.skeleton.skins)
        if (s.id.equals(ref) || s.name.equals(ref)) {
          found = s;
          break;
        }
    if (found == skin && activeComputed && activeFor == found) return;
    skin = found;
    updateActive();
  }

  /** Default update order: ik, transform, path, physics; sorted by {@code order} when any constraint has one. */
  public List<ConstraintData> constraintOrder() {
    List<ConstraintData> list = new ArrayList<>();
    list.addAll(doc.skeleton.ik);
    list.addAll(doc.skeleton.transform);
    list.addAll(doc.skeleton.path);
    list.addAll(doc.skeleton.physics);
    boolean any = false;
    for (ConstraintData c : list) if (c.order != null) any = true;
    if (!any) return list;
    List<int[]> idx = new ArrayList<>();
    for (int i = 0; i < list.size(); i++) idx.add(new int[] {i});
    final List<ConstraintData> l = list;
    idx.sort((a, b) -> {
      double ka = l.get(a[0]).order != null ? l.get(a[0]).order : a[0];
      double kb = l.get(b[0]).order != null ? l.get(b[0]).order : b[0];
      double d = ka - kb;
      if (d < 0) return -1;
      if (d > 0) return 1;
      return Integer.compare(a[0], b[0]);
    });
    List<ConstraintData> out = new ArrayList<>();
    for (int[] i : idx) out.add(list.get(i[0]));
    return out;
  }

  /** Recompute which bones and constraints are active for the current skin. */
  public void updateActive() {
    activeComputed = true;
    activeFor = skin;
    Set<String> reqBones = new HashSet<>(), reqCons = new HashSet<>();
    for (SkinData s : doc.skeleton.skins) {
      if (s.bones != null) reqBones.addAll(s.bones);
      if (s.constraints != null) reqCons.addAll(s.constraints);
    }
    Set<String> active = null;
    if (!reqBones.isEmpty()) {
      Set<String> mine = new HashSet<>();
      if (skin != null && skin.bones != null) mine.addAll(skin.bones);
      active = new HashSet<>();
      for (BoneData b : doc.skeleton.bones) {
        if (b.parent != null && !active.contains(b.parent)) continue;
        if (!reqBones.contains(b.id) || mine.contains(b.id)) active.add(b.id);
      }
    }
    for (Bone b : bones) b.active = active == null || active.contains(b.data.id);
    inactiveConstraints.clear();
    Set<String> mineC = new HashSet<>();
    if (skin != null && skin.constraints != null) mineC.addAll(skin.constraints);
    for (ConstraintData c : constraintOrder()) {
      boolean skip = reqCons.contains(c.id) && !mineC.contains(c.id);
      if (!skip && active != null) {
        if (c instanceof PhysicsConstraintData) skip = off(((PhysicsConstraintData) c).bone);
        else if (c instanceof PathConstraintData) {
          PathConstraintData p = (PathConstraintData) c;
          for (String id : p.bones) skip |= off(id);
          Slot ts = slotById.get(p.target);
          skip |= off(ts != null ? ts.bone.data.id : "");
        } else {
          List<String> bs = c instanceof IkConstraintData ? ((IkConstraintData) c).bones : ((TransformConstraintData) c).bones;
          String target = c instanceof IkConstraintData ? ((IkConstraintData) c).target : ((TransformConstraintData) c).target;
          for (String id : bs) skip |= off(id);
          skip |= off(target);
        }
      }
      if (skip) inactiveConstraints.add(c.id);
    }
  }

  private boolean off(String id) {
    Bone b = boneById.get(id);
    return b != null && !b.active;
  }

  public boolean isConstraintActive(String id) {
    return !inactiveConstraints.contains(id);
  }

  public void setToSetupPose() {
    for (Bone b : bones) b.setToSetupPose();
    for (Slot s : slots) s.setToSetupPose();
    drawOrder = new ArrayList<>(slots);
    animationTime = null;
    constraintValues.clear();
    particleValues.clear();
    for (ConstraintData c : doc.skeleton.ik) constraintValues.put(c.id, setupValues(c));
    for (ConstraintData c : doc.skeleton.transform) constraintValues.put(c.id, setupValues(c));
    for (ConstraintData c : doc.skeleton.path) constraintValues.put(c.id, setupValues(c));
    for (ConstraintData c : doc.skeleton.physics) constraintValues.put(c.id, setupValues(c));
  }

  private static ConstraintValues setupValues(ConstraintData c) {
    ConstraintValues v = new ConstraintValues();
    if (c instanceof IkConstraintData) {
      IkConstraintData k = (IkConstraintData) c;
      v.put("mix", k.mix);
      v.put("softness", k.softness);
      v.put("bend", k.bendPositive ? 1 : -1);
      v.put("stretch", k.stretch ? 1 : 0);
      v.put("compress", k.compress ? 1 : 0);
    } else if (c instanceof TransformConstraintData) {
      TransformConstraintData t = (TransformConstraintData) c;
      v.put("mix", 1);
      v.put("mixRotate", t.mixRotate);
      v.put("mixTranslate", t.mixTranslate);
      v.put("mixScale", t.mixScale);
      v.put("mixShear", t.mixShear);
    } else if (c instanceof PathConstraintData) {
      PathConstraintData p = (PathConstraintData) c;
      v.put("position", p.position);
      v.put("spacing", p.spacing);
      v.put("mixRotate", p.mixRotate);
      v.put("mixX", p.mixX);
      v.put("mixY", p.mixY);
    } else {
      PhysicsConstraintData p = (PhysicsConstraintData) c;
      v.put("mix", p.mix);
      v.put("inertia", p.inertia);
      v.put("strength", p.strength);
      v.put("damping", p.damping);
      v.put("mass", p.mass);
      v.put("gravity", p.gravity);
      v.put("wind", p.wind);
    }
    return v;
  }

  private ConstraintValues values(ConstraintData c) {
    ConstraintValues v = constraintValues.get(c.id);
    if (v == null) constraintValues.put(c.id, v = setupValues(c));
    return v;
  }

  /** Advance simulated time (physics, particles, sequences). Call once per frame before updateWorldTransform. */
  public void update(double dt) {
    if (dt > 0) {
      pendingDt += dt;
      clock += dt;
      particlePending += dt;
    }
  }

  // ---------------- Particles ----------------

  /** Forget every particle; emitters restart (and prewarm) on their next step. */
  public void resetParticles() {
    emitters.clear();
    pendingBursts.clear();
    particlePending = 0;
    particleFrac = 0;
    particleSteps = 0;
  }

  public double particleTime() {
    return particleSteps * ParticleEmitter.STEP + particleFrac;
  }

  /** Deterministically bring particles to time t; {@code pose(time)} poses the skeleton at a time. */
  public void seekParticles(double t, java.util.function.DoubleConsumer pose) {
    particleClock = "seek";
    particlePending = 0;
    int target = (int) Math.max(0, Math.floor(t / ParticleEmitter.STEP + 1e-6));
    if (target < particleSteps) resetParticles();
    while (particleSteps < target) {
      pose.accept(particleSteps * ParticleEmitter.STEP);
      stepParticles(ParticleEmitter.STEP);
      particleSteps++;
    }
    particleFrac = Math.max(0, Math.min(ParticleEmitter.STEP, t - target * ParticleEmitter.STEP));
  }

  /** Turn a slot's emitter on/off from outside the timeline (kept until the next setToSetupPose). */
  public void setEmitting(String slotRef, boolean emitting) {
    Slot slot = findSlot(slotRef);
    if (slot == null) return;
    ParticleEmitter.Values cur = particleValues.get(slot.data.id);
    ParticleEmitter.Values v = cur != null ? cur.copy() : new ParticleEmitter.Values();
    v.emitting = emitting;
    particleValues.put(slot.data.id, v);
  }

  /** Restart a slot's emitter cycle (its bursts fire again). */
  public void restartEmitter(String slotRef) {
    Slot slot = findSlot(slotRef);
    if (slot == null) return;
    ParticleEmitter em = emitters.get(slot.data.id);
    if (em != null) em.restart();
  }

  /** Spawn {@code count} particles from a slot's emitter on the next step. */
  public void emitParticles(String slotRef, double count) {
    Slot slot = findSlot(slotRef);
    if (slot != null && count > 0) pendingBursts.merge(slot.data.id, count, Double::sum);
  }

  /** The emitter simulating a slot's current particles attachment, or null. */
  public ParticleEmitter emitter(String slotRef) {
    Slot slot = findSlot(slotRef);
    ParticleEmitter em = slot != null ? emitters.get(slot.data.id) : null;
    return em != null && em.data == getAttachment(slot) ? em : null;
  }

  private void stepParticles(double h) {
    for (Slot slot : slots) {
      if (!slot.bone.active) continue;
      Attachment att = getAttachment(slot);
      String id = slot.data.id;
      if (!(att instanceof ParticlesAttachment)) {
        emitters.remove(id);
        continue;
      }
      ParticleEmitter em = emitters.get(id);
      if (em == null || em.data != att) {
        em = new ParticleEmitter((ParticlesAttachment) att, ParticleEmitter.hashString(slot.data.name));
        emitters.put(id, em);
      }
      Double burst = pendingBursts.get(id);
      if (burst != null && burst != 0) em.pending += burst;
      em.step(h, slot.bone.world, particleValues.get(id));
    }
    pendingBursts.clear();
  }

  private void advanceParticles(double dt) {
    double acc = particleFrac + dt;
    double n = Math.floor(acc / ParticleEmitter.STEP + 1e-6);
    int steps = (int) Math.min(n, ParticleEmitter.MAX_STEPS);
    for (int i = 0; i < steps; i++) stepParticles(ParticleEmitter.STEP);
    particleSteps += steps;
    particleFrac = Math.max(0, Math.min(ParticleEmitter.STEP, acc - n * ParticleEmitter.STEP));
  }

  /** Forget physics motion: the next frame starts at rest on the animated pose. */
  public void resetPhysics() {
    physicsState.clear();
    pendingDt = 0;
  }

  public double unitScaleX() {
    return (doc.skeleton.referenceScale != null ? doc.skeleton.referenceScale : 100) / 100 * scaleX;
  }

  public double unitScaleY() {
    return (doc.skeleton.referenceScale != null ? doc.skeleton.referenceScale : 100) / 100 * scaleY;
  }

  private Affine rootMatrix() {
    return new Affine(scaleX, 0, 0, scaleY, x, y);
  }

  /** Solve world transforms, then the active constraints in update order. */
  public void updateWorldTransform() {
    applySliders();
    Affine root = rootMatrix();
    for (Bone b : bones) {
      if (!b.active) continue;
      b.resetApplied();
      b.updateWorld(root);
    }
    double dt = pendingDt;
    pendingDt = 0;
    for (ConstraintData c : constraintOrder()) {
      if (inactiveConstraints.contains(c.id)) continue;
      if (c instanceof IkConstraintData) applyIk((IkConstraintData) c, values(c));
      else if (c instanceof TransformConstraintData) applyTransform((TransformConstraintData) c, values(c));
      else if (c instanceof PathConstraintData) applyPath((PathConstraintData) c, values(c));
      else applyPhysics((PhysicsConstraintData) c, values(c), dt);
    }
    double pdt = particlePending;
    particlePending = 0;
    if (particleClock.equals("realtime") && pdt > 0) advanceParticles(pdt);
  }

  // ---------------- Sliders ----------------

  private static final String[] PROPS = {"x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"};

  private void applySliders() {
    List<SliderData> list = doc.skeleton.sliders;
    if (list.isEmpty()) return;
    Double savedTime = animationTime;
    for (SliderData sl : list) {
      if (sl.mix <= 0) continue;
      AnimationData anim = doc.animationById(sl.animation);
      if (anim == null) continue;
      Double v = null;
      if (sl.bone != null && !sl.bone.isEmpty()) {
        Bone b = boneById.get(sl.bone);
        if (b != null) v = b.get(sl.property != null && !sl.property.isEmpty() ? sl.property : "rotation");
      } else if (sl.input != null && !sl.input.isEmpty()) {
        Double iv = inputValues.get(sl.input);
        if (iv == null) iv = inputDefaults.get(sl.input);
        v = iv != null ? iv : 0.0;
      }
      if (v == null) continue;
      double span = sl.to - sl.from;
      double f = span == 0 ? 0 : (v - sl.from) / span;
      f = sl.loop ? f - Math.floor(f) : Math.min(1, Math.max(0, f));
      double t0 = sl.timeFrom != null ? sl.timeFrom : 0;
      double t1 = sl.timeTo != null ? sl.timeTo : anim.duration();
      double t = t0 + f * (t1 - t0);
      if (!sl.additive) {
        Animations.apply(this, anim, t, sl.mix);
        continue;
      }
      double[][] before = new double[bones.size()][7];
      Inherit[] inherits = new Inherit[bones.size()];
      for (int i = 0; i < bones.size(); i++) {
        for (int k = 0; k < 7; k++) before[i][k] = bones.get(i).get(PROPS[k]);
        inherits[i] = bones.get(i).inherit;
      }
      for (Bone b : bones) b.setToSetupPose();
      List<Timeline> boneTl = new ArrayList<>(), other = new ArrayList<>();
      Set<String> keysInherit = new HashSet<>();
      for (Timeline tl : anim.timelines) {
        if (tl.target.equals("bone")) {
          boneTl.add(tl);
          if (tl.property.equals("inherit")) keysInherit.add(tl.id);
        } else other.add(tl);
      }
      Animations.apply(this, anim, boneTl, t, 1);
      for (int i = 0; i < bones.size(); i++) {
        Bone b = bones.get(i);
        for (int k = 0; k < 7; k++) {
          String p = PROPS[k];
          double delta = p.equals("rotation") ? MathUtil.wrapDeg(b.get(p) - b.data.get(p)) : b.get(p) - b.data.get(p);
          b.set(p, before[i][k] + delta * sl.mix);
        }
      }
      for (int i = 0; i < bones.size(); i++) {
        Bone b = bones.get(i);
        if (sl.mix < 0.5 || !keysInherit.contains(b.data.id)) b.inherit = inherits[i];
      }
      if (!other.isEmpty()) Animations.apply(this, anim, other, t, sl.mix);
    }
    animationTime = savedTime;
  }

  // ---------------- IK ----------------

  private void applyIk(IkConstraintData c, ConstraintValues v) {
    double mix = v.get("mix", Double.NaN);
    if (mix <= 0) return;
    boolean bendPositive = v.get("bend", c.bendPositive ? 1 : -1) > 0;
    boolean stretch = v.get("stretch", c.stretch ? 1 : 0) > 0;
    boolean compress = v.get("compress", c.compress ? 1 : 0) > 0;
    boolean uniform = c.uniform;
    Bone target = boneById.get(c.target);
    List<Bone> bs = new ArrayList<>();
    for (String id : c.bones) {
      Bone b = boneById.get(id);
      if (b != null) bs.add(b);
    }
    if (target == null || bs.isEmpty()) return;
    Affine root = rootMatrix();
    double tx = target.world.x, ty = target.world.y;
    if (bs.size() == 1) {
      Bone b = bs.get(0);
      Affine pw = b.parent != null ? b.parent.world : root;
      Affine inv = pw.invert();
      double dx = tx - b.world.x, dy = ty - b.world.y;
      double lx = inv.a * dx + inv.b * dy, ly = inv.c * dx + inv.d * dy;
      double want = Math.atan2(ly, lx) * MathUtil.RAD - b.applied.shearX;
      b.applied.rotation += MathUtil.wrapDeg(want - b.applied.rotation) * mix;
      b.updateWorld(root);
      double len = b.data.length * b.world.scaleX();
      if ((stretch || compress) && len > 1e-6) {
        double k = Math.hypot(dx, dy) / len;
        if ((k > 1 && stretch) || (k < 1 && compress)) {
          double s = 1 + (k - 1) * mix;
          b.world.a *= s;
          b.world.c *= s;
          if (uniform) {
            b.world.b *= s;
            b.world.d *= s;
          }
          b.syncApplied(root);
        }
      }
      b.updateSubtree(root, false);
      return;
    }
    Bone p = bs.get(0), ch = bs.get(1);
    double px = p.world.x, py = p.world.y;
    double l1 = Math.hypot(ch.world.x - px, ch.world.y - py);
    double l2 = ch.data.length * ch.world.scaleX();
    double reach = l1 + l2;
    double dRaw = Math.hypot(tx - px, ty - py);
    double dSoft = dRaw;
    double soft = Math.min(v.get("softness", 0) * Math.abs(unitScaleX()), reach);
    if (soft > 1e-6 && dRaw > reach - soft) dSoft = reach - soft + soft * (1 - Math.exp(-(dRaw - (reach - soft)) / soft));
    double dEff = Math.min(Math.max(dSoft, Math.abs(l1 - l2) + 1e-4), reach - 1e-4);
    double ux = dRaw > 1e-9 ? (tx - px) / dRaw : 1;
    double uy = dRaw > 1e-9 ? (ty - py) / dRaw : 0;
    double ax = px + ux * dEff, ay = py + uy * dEff;
    double base = Math.atan2(uy, ux);
    double den = 2 * l1 * dEff;
    double cosA = (l1 * l1 + dEff * dEff - l2 * l2) / (den == 0 || Double.isNaN(den) ? 1 : den);
    double a1 = base + (bendPositive ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, cosA)));
    double curDir = Math.atan2(ch.world.y - py, ch.world.x - px);
    double sP = MathUtil.detSign(p.parent != null ? p.parent.world : root);
    double deltaP = MathUtil.wrapDeg((a1 - curDir) * MathUtil.RAD) * sP;
    double pRot = p.applied.rotation, cRot = ch.applied.rotation;
    p.applied.rotation = pRot + deltaP;
    p.updateSubtree(root, true);
    double want = Math.atan2(ay - ch.world.y, ax - ch.world.x) * MathUtil.RAD;
    double sC = MathUtil.detSign(p.world);
    double deltaC = MathUtil.wrapDeg(want - ch.worldRotation()) * sC;
    p.applied.rotation = pRot + deltaP * mix;
    ch.applied.rotation = cRot + deltaC * mix;
    p.updateWorld(root);
    ch.updateWorld(root);
    if (stretch && dRaw > dEff + 1e-9) {
      double s = 1 + (dRaw / dEff - 1) * mix;
      Affine cw = ch.world;
      double u = uniform ? s : 1;
      p.world.a *= s;
      p.world.c *= s;
      p.world.b *= u;
      p.world.d *= u;
      double ox = p.world.applyX(ch.applied.x, ch.applied.y), oy = p.world.applyY(ch.applied.x, ch.applied.y);
      ch.world.set(new Affine(cw.a * s, cw.b * u, cw.c * s, cw.d * u, ox, oy));
      p.syncApplied(root);
      ch.syncApplied(root);
    }
    ch.updateSubtree(root, false);
    for (Bone sib : p.children) if (sib != ch) sib.updateSubtree(root, true);
  }

  // ---------------- Transform ----------------

  private Affine setupWorldOf(String id) {
    if (setupCache == null) {
      setupCache = new HashMap<>();
      for (BoneData b : doc.skeleton.bones) {
        Affine parent = b.parent != null ? setupCache.get(b.parent) : null;
        setupCache.put(b.id, MathUtil.boneWorld(parent, b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY, b.inherit));
      }
    }
    Affine s = setupCache.get(id);
    return Affine.multiply(rootMatrix(), s != null ? s : new Affine());
  }

  private static void rotateAxes(Affine w, double rad) {
    if (rad == 0) return;
    double cos = Math.cos(rad), sin = Math.sin(rad);
    double a = w.a, b = w.b, c = w.c, d = w.d;
    w.a = cos * a - sin * c;
    w.b = cos * b - sin * d;
    w.c = sin * a + cos * c;
    w.d = sin * b + cos * d;
  }

  private static double skewOf(Affine m) {
    return MathUtil.wrapDeg((Math.atan2(m.d, m.b) - Math.atan2(m.c, m.a)) * MathUtil.RAD - 90);
  }

  private static void setSkew(Affine w, double skewDeg) {
    double ly = Math.hypot(w.b, w.d);
    double ang = Math.atan2(w.c, w.a) + (90 + skewDeg) * MathUtil.DEG;
    w.b = Math.cos(ang) * ly;
    w.d = Math.sin(ang) * ly;
  }

  private static double orOne(double v) {
    return v == 0 || Double.isNaN(v) ? 1 : v;
  }

  private void applyTransform(TransformConstraintData c, ConstraintValues v) {
    double m = v.get("mix", 1);
    double mr = v.get("mixRotate", Double.NaN) * m, mt = v.get("mixTranslate", Double.NaN) * m, ms = v.get("mixScale", Double.NaN) * m, mh = v.get("mixShear", 0) * m;
    if (mr <= 0 && mt <= 0 && ms <= 0 && mh <= 0) return;
    Bone target = boneById.get(c.target);
    if (target == null) return;
    Affine root = rootMatrix();
    double offScaleX = c.offsetScaleX, offScaleY = c.offsetScaleY, offShear = c.offsetShear;
    for (String id : c.bones) {
      Bone b = boneById.get(id);
      if (b == null || b == target) continue;
      if (c.local) {
        LocalTransform p = b.applied, t = target.applied;
        if (c.relative) {
          BoneData s = target.data;
          p.rotation += (MathUtil.wrapDeg(t.rotation - s.rotation) + c.offsetRotation) * mr;
          p.x += (t.x - s.x + c.offsetX) * mt;
          p.y += (t.y - s.y + c.offsetY) * mt;
          p.scaleX *= 1 + ((s.scaleX != 0 && !Double.isNaN(s.scaleX) ? t.scaleX / s.scaleX : 1) - 1 + offScaleX) * ms;
          p.scaleY *= 1 + ((s.scaleY != 0 && !Double.isNaN(s.scaleY) ? t.scaleY / s.scaleY : 1) - 1 + offScaleY) * ms;
          p.shearY += (t.shearY - s.shearY + offShear) * mh;
        } else {
          p.rotation += MathUtil.wrapDeg(t.rotation + c.offsetRotation - p.rotation) * mr;
          p.x += (t.x + c.offsetX - p.x) * mt;
          p.y += (t.y + c.offsetY - p.y) * mt;
          p.scaleX += (t.scaleX + offScaleX - p.scaleX) * ms;
          p.scaleY += (t.scaleY + offScaleY - p.scaleY) * ms;
          p.shearY += (t.shearY + offShear - p.shearY) * mh;
        }
        b.updateSubtree(root, true);
        continue;
      }
      Affine w = b.world, t = target.world;
      if (c.relative) {
        Affine s = setupWorldOf(target.data.id);
        if (mr > 0) rotateAxes(w, (MathUtil.wrapDeg(t.rotation() - s.rotation()) + c.offsetRotation) * mr * MathUtil.DEG);
        if (mt > 0) {
          w.x += (t.x - s.x + c.offsetX) * mt;
          w.y += (t.y - s.y + c.offsetY) * mt;
        }
        if (ms > 0) {
          double kx = 1 + (t.scaleX() / orOne(s.scaleX()) - 1 + offScaleX) * ms;
          double ky = 1 + (t.scaleY() / orOne(s.scaleY()) - 1 + offScaleY) * ms;
          w.a *= kx;
          w.c *= kx;
          w.b *= ky;
          w.d *= ky;
        }
        if (mh > 0) setSkew(w, skewOf(w) + (MathUtil.wrapDeg(skewOf(t) - skewOf(s)) + offShear) * mh);
      } else {
        if (mr > 0) rotateAxes(w, MathUtil.wrapDeg(t.rotation() + c.offsetRotation - w.rotation()) * mr * MathUtil.DEG);
        if (mt > 0) {
          double ox = t.applyX(c.offsetX, c.offsetY), oy = t.applyY(c.offsetX, c.offsetY);
          w.x += (ox - w.x) * mt;
          w.y += (oy - w.y) * mt;
        }
        if (ms > 0) {
          double sx = orOne(w.scaleX()), sy = orOne(w.scaleY());
          double kx = (sx + (t.scaleX() + offScaleX - sx) * ms) / sx;
          double ky = (sy + (t.scaleY() + offScaleY - sy) * ms) / sy;
          w.a *= kx;
          w.c *= kx;
          w.b *= ky;
          w.d *= ky;
        }
        if (mh > 0) {
          double sb = skewOf(w);
          setSkew(w, sb + MathUtil.wrapDeg(skewOf(t) + offShear - sb) * mh);
        }
      }
      b.syncApplied(root);
      b.updateSubtree(root, false);
    }
  }

  // ---------------- Path ----------------

  private void applyPath(PathConstraintData c, ConstraintValues v) {
    double mixRotate = v.get("mixRotate", Double.NaN), mixX = v.get("mixX", Double.NaN), mixY = v.get("mixY", Double.NaN);
    if (mixRotate <= 0 && mixX <= 0 && mixY <= 0) return;
    Slot slot = slotById.get(c.target);
    if (slot == null) return;
    Attachment att = getAttachment(slot);
    if (!(att instanceof PathAttachment)) return;
    Spline spline = new Spline(attachmentWorldVertices(slot, att), ((PathAttachment) att).closed, c.constantSpeed);
    double total = spline.length;
    if (total <= 1e-9) return;
    List<Bone> bs = new ArrayList<>();
    for (String id : c.bones) {
      Bone b = boneById.get(id);
      if (b != null) bs.add(b);
    }
    int n = bs.size();
    if (n == 0) return;
    double[] lengths = new double[n];
    double sumLen = 0;
    for (int i = 0; i < n; i++) {
      lengths[i] = bs.get(i).data.length * bs.get(i).world.scaleX();
      sumLen += lengths[i];
    }
    double position = v.get("position", Double.NaN), spacing = v.get("spacing", Double.NaN);
    double[] dist = new double[n + 1];
    dist[0] = c.positionMode.equals("percent") ? position * total : position;
    for (int i = 0; i < n; i++) {
      double gap;
      switch (c.spacingMode) {
        case "fixed": gap = spacing; break;
        case "percent": gap = spacing * total; break;
        case "proportional": gap = spacing * total * (sumLen > 0 ? lengths[i] / sumLen : 1.0 / n); break;
        default: gap = lengths[i] + spacing;
      }
      dist[i + 1] = dist[i] + gap;
    }
    Spline.Sample[] pts = new Spline.Sample[n + 1];
    for (int i = 0; i <= n; i++) pts[i] = spline.sample(dist[i]);
    Affine root = rootMatrix();
    double off = c.offsetRotation * MathUtil.DEG;
    for (int i = 0; i < n; i++) {
      Bone b = bs.get(i);
      Affine w = b.world;
      Spline.Sample p = pts[i];
      w.x += (p.x - w.x) * mixX;
      w.y += (p.y - w.y) * mixY;
      if (mixRotate > 0) {
        double ang = p.angle;
        if (!c.rotateMode.equals("tangent")) {
          Spline.Sample q = pts[i + 1];
          double dx = q.x - w.x, dy = q.y - w.y, d = Math.hypot(dx, dy);
          if (d > 1e-6) {
            ang = Math.atan2(dy, dx);
            if (c.rotateMode.equals("chainScale") && lengths[i] > 1e-6) {
              double k = 1 + (d / lengths[i] - 1) * mixRotate;
              w.a *= k;
              w.c *= k;
            }
          }
        }
        rotateAxes(w, MathUtil.wrapDeg((ang + off) * MathUtil.RAD - w.rotation()) * mixRotate * MathUtil.DEG);
        b.syncApplied(root);
      }
      b.updateSubtree(root, false);
    }
  }

  // ---------------- Physics ----------------

  private void applyPhysics(PhysicsConstraintData c, ConstraintValues v, double dt) {
    Bone b = boneById.get(c.bone);
    if (b == null) return;
    Affine w = b.world;
    double len = b.data.length > 1e-6 ? b.data.length : 1;
    double ox = w.x, oy = w.y;
    double tx = w.applyX(len, 0), ty = w.applyY(len, 0);
    PhysicsState st = physicsState.get(c.id);
    if (st == null) {
      st = new PhysicsState();
      st.origin = new Particle(ox, oy);
      st.tip = new Particle(tx, ty);
      st.lastOx = ox;
      st.lastOy = oy;
      st.lastTx = tx;
      st.lastTy = ty;
      physicsState.put(c.id, st);
    }
    double carry = 1 - Math.min(1, Math.max(0, v.get("inertia", Double.NaN)));
    shift(st.origin, (ox - st.lastOx) * carry, (oy - st.lastOy) * carry);
    shift(st.tip, (tx - st.lastTx) * carry, (ty - st.lastTy) * carry);
    st.lastOx = ox;
    st.lastOy = oy;
    st.lastTx = tx;
    st.lastTy = ty;
    double fps = c.fps == 0 || Double.isNaN(c.fps) ? 60 : c.fps;
    double h = 1 / Math.max(1, fps);
    st.time += dt;
    double due = Math.floor(st.time / h + 1e-6);
    if (due - st.steps > MAX_PHYSICS_STEPS) st.steps = due - MAX_PHYSICS_STEPS;
    double k = Math.min(Math.max(0, v.get("strength", Double.NaN)) / Math.max(1e-6, v.get("mass", Double.NaN)), 1 / (h * h));
    double decay = Math.exp(-Math.max(0, v.get("damping", Double.NaN)) * h);
    double wind = v.get("wind", Double.NaN) * unitScaleX();
    double gravity = v.get("gravity", Double.NaN) * unitScaleY();
    for (; st.steps < due; st.steps++) {
      step(st.origin, ox, oy, k, wind, gravity, h, decay);
      step(st.tip, tx, ty, k, wind, gravity, h, decay);
    }
    double mix = Math.min(1, Math.max(0, v.get("mix", Double.NaN)));
    if (mix <= 0) return;
    double f = Math.min(1, Math.max(0, st.time / h - st.steps));
    double sox = st.origin.px + (st.origin.x - st.origin.px) * f, soy = st.origin.py + (st.origin.y - st.origin.py) * f;
    double stx = st.tip.px + (st.tip.x - st.tip.px) * f, sty = st.tip.py + (st.tip.y - st.tip.py) * f;
    w.x = ox + (sox - ox) * c.x * mix;
    w.y = oy + (soy - oy) * c.y * mix;
    if (c.rotate > 0 || c.scaleX > 0) {
      double dx = stx - w.x, dy = sty - w.y, d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        double base = Math.atan2(ty - oy, tx - ox);
        rotateAxes(w, MathUtil.wrapDeg((Math.atan2(dy, dx) - base) * MathUtil.RAD) * c.rotate * mix * MathUtil.DEG);
        if (c.scaleX > 0 && b.data.length > 1e-6) {
          double rest = Math.hypot(tx - ox, ty - oy);
          if (rest == 0 || Double.isNaN(rest)) rest = len;
          double s = 1 + (d / rest - 1) * c.scaleX * mix;
          w.a *= s;
          w.c *= s;
        }
      }
    }
    b.syncApplied(rootMatrix());
    b.updateSubtree(rootMatrix(), false);
  }

  private static void shift(Particle p, double dx, double dy) {
    p.x += dx;
    p.y += dy;
    p.px += dx;
    p.py += dy;
  }

  private static void step(Particle p, double gx, double gy, double k, double wind, double gravity, double h, double decay) {
    p.px = p.x;
    p.py = p.y;
    p.vx = (p.vx + ((gx - p.x) * k + wind) * h) * decay;
    p.vy = (p.vy + ((gy - p.y) * k - gravity) * h) * decay;
    p.x += p.vx * h;
    p.y += p.vy * h;
  }

  // ---------------- Sequences ----------------

  /** Frame counter of a sequence on a slot (offset included). */
  public double sequenceCounter(Slot slot, SequenceAttachment att) {
    Double keyed = slot.sequenceFrames.get(att.name);
    if (keyed != null) return Math.floor(keyed + 1e-6) + att.offset;
    if (att.input != null && !att.input.isEmpty()) {
      Double v = inputValues.get(att.input);
      if (v == null) v = inputDefaults.get(att.input);
      if (v != null) return Math.floor(v + 1e-6) + att.offset;
    }
    double time = animationTime != null ? animationTime : clock;
    return Math.floor(time * att.fps + 1e-6) + att.offset;
  }

  /** Index of the frame shown now (-1 = none). */
  public int sequenceFrame(Slot slot, SequenceAttachment att) {
    return sequenceFrameIndex(att.frames.size(), att.mode, sequenceCounter(slot, att));
  }

  public static int sequenceFrameIndex(int count, String mode, double counter) {
    if (count <= 0 || !Double.isFinite(counter)) return count > 0 ? 0 : -1;
    double f = Math.floor(counter);
    switch (mode) {
      case "loop":
        return (int) (((f % count) + count) % count);
      case "once":
        return f < 0 ? 0 : f >= count ? -1 : (int) f;
      case "holdLast":
        return (int) Math.min(Math.max(f, 0), count - 1);
      case "pingPong": {
        if (count == 1) return 0;
        double period = 2 * count - 2;
        double k = ((f % period) + period) % period;
        return (int) (k < count ? k : period - k);
      }
      default:
        return -1;
    }
  }

  private DrawItem sequenceItem(Slot slot, SequenceAttachment att, int index) {
    SequenceAttachment.Frame frame = index >= 0 && index < att.frames.size() ? att.frames.get(index) : null;
    ImageAsset image = frame != null ? images.get(frame.image) : null;
    if (frame == null || image == null) return null;
    double[] color = MathUtil.mulColor(slot.color, MathUtil.parseHex(att.color));
    if (color[3] <= 0) return null;
    double iw = image.width, ih = image.height;
    double[] r = frame.rect != null ? frame.rect : new double[] {0, 0, iw, ih};
    double u0 = r[0] / iw, v0 = r[1] / ih, u1 = (r[0] + r[2]) / iw, v1 = (r[1] + r[3]) / ih;
    double q0 = 0, p0 = 0, q1 = 1, p1 = 1;
    if (frame.trim != null) {
      double[] t = frame.trim;
      q0 = t[0] / t[2];
      p0 = t[1] / t[3];
      q1 = (t[0] + r[2]) / t[2];
      p1 = (t[1] + r[3]) / t[3];
    }
    Packed pk = packed.get(frame.image);
    if (pk != null && pk.trim != null) {
      double a0 = pk.trim[0], b0 = pk.trim[1], a1 = pk.trim[2], b1 = pk.trim[3];
      double nu0 = Math.max(u0, a0), nv0 = Math.max(v0, b0), nu1 = Math.min(u1, a1), nv1 = Math.min(v1, b1);
      if (nu0 >= nu1 || nv0 >= nv1) return null;
      double fq0 = q0 + ((nu0 - u0) / (u1 - u0)) * (q1 - q0), fp0 = p0 + ((nv0 - v0) / (v1 - v0)) * (p1 - p0);
      double fq1 = q0 + ((nu1 - u0) / (u1 - u0)) * (q1 - q0), fp1 = p0 + ((nv1 - v0) / (v1 - v0)) * (p1 - p0);
      q0 = fq0;
      p0 = fp0;
      q1 = fq1;
      p1 = fp1;
      u0 = nu0;
      v0 = nv0;
      u1 = nu1;
      v1 = nv1;
    }
    double[] vertices = attachmentWorldVertices(slot, att);
    if (q0 != 0 || p0 != 0 || q1 != 1 || p1 != 1) vertices = trimQuad(vertices, q0, p0, q1, p1);
    double[] quadUvs = f32(new double[] {u0, v0, u1, v0, u1, v1, u0, v1});
    DrawItem.TextureRef texture = pk != null ? pk.page : new DrawItem.TextureRef(image.id, image.width, image.height);
    double[] uvs = pk != null ? pk.map.remap(quadUvs) : quadUvs;
    boolean whole = pk == null && u0 == 0 && v0 == 0 && u1 == 1 && v1 == 1;
    DrawItem it = new DrawItem();
    it.slot = slot;
    it.attachment = att;
    it.image = image;
    it.texture = texture;
    if (!whole)
      it.textureRect = new double[] {Math.min(uvs[0], uvs[4]) * texture.width, Math.min(uvs[1], uvs[5]) * texture.height, Math.abs(uvs[4] - uvs[0]) * texture.width,
          Math.abs(uvs[5] - uvs[1]) * texture.height};
    it.vertices = vertices;
    it.uvs = uvs;
    it.indices = REGION_INDICES;
    it.color = color;
    it.dark = slot.dark;
    it.blend = slot.data.blend;
    return it;
  }

  // ---------------- Text ----------------

  /** Show fixed text (or a template) in a slot's text attachment instead of its own; null restores it. */
  public void setText(String slotRef, String text) {
    Slot slot = findSlot(slotRef);
    if (slot == null) throw new IllegalArgumentException("Slot \"" + slotRef + "\" not found");
    if (text == null) textOverrides.remove(slot.data.id);
    else textOverrides.put(slot.data.id, text);
  }

  /** The text a slot's text attachment shows now (template filled in). */
  public String textContent(Slot slot, TextAttachment att) {
    String t = textOverrides.get(slot.data.id);
    return Template.format(t != null ? t : att.text, textValues);
  }

  /** Box centre to world matrix of a text attachment. */
  public Affine textMatrix(Slot slot, TextAttachment att) {
    double r = att.rotation * MathUtil.DEG, c = Math.cos(r), s = Math.sin(r);
    return Affine.multiply(slot.bone.world, new Affine(c, -s, s, c, att.x, att.y));
  }

  // ---------------- Attachments ----------------

  /** Current attachment of a slot: active skin, then the default skin. */
  public Attachment getAttachment(Slot slot) {
    return getAttachment(slot, slot.attachmentName);
  }

  public Attachment getAttachment(Slot slot, String name) {
    if (name == null) return null;
    String id = slot.data.id;
    Attachment a = skin != null ? skin.get(id, name) : null;
    if (a != null) return a;
    SkinData def = doc.defaultSkin();
    return def != null ? def.get(id, name) : null;
  }

  /** World-space vertices (float32 values) of a slot's attachment (bounding boxes and paths pose like meshes: weights, deform). */
  public double[] attachmentWorldVertices(Slot slot, Attachment att) {
    Affine m = slot.bone.world;
    if (att instanceof RegionAttachment || att instanceof SequenceAttachment || att instanceof TextAttachment) {
      double ax, ay, rot, w, hgt, sx = 1, sy = 1, skx = 0, sky = 0;
      boolean text = att instanceof TextAttachment;
      if (att instanceof RegionAttachment) {
        RegionAttachment r = (RegionAttachment) att;
        ax = r.x; ay = r.y; rot = r.rotation; w = r.width; hgt = r.height; sx = r.scaleX; sy = r.scaleY; skx = r.skewX; sky = r.skewY;
      } else if (att instanceof SequenceAttachment) {
        SequenceAttachment r = (SequenceAttachment) att;
        ax = r.x; ay = r.y; rot = r.rotation; w = r.width; hgt = r.height; sx = r.scaleX; sy = r.scaleY; skx = r.skewX; sky = r.skewY;
      } else {
        TextAttachment r = (TextAttachment) att;
        ax = r.x; ay = r.y; rot = r.rotation; w = r.width; hgt = r.height;
      }
      double hw = (w / 2) * (text ? 1 : sx), hh = (hgt / 2) * (text ? 1 : sy);
      double cos = Math.cos(rot * MathUtil.DEG), sin = Math.sin(rot * MathUtil.DEG);
      double[] corners = {-hw, hh, hw, hh, hw, -hh, -hw, -hh};
      double kx = !text && skx != 0 && !Double.isNaN(skx) ? Math.tan(skx * MathUtil.DEG) : 0;
      double ky = !text && sky != 0 && !Double.isNaN(sky) ? Math.tan(sky * MathUtil.DEG) : 0;
      if (kx != 0 || ky != 0)
        for (int i = 0; i < 8; i += 2) {
          double x0 = corners[i], y0 = corners[i + 1];
          corners[i] = x0 + kx * y0;
          corners[i + 1] = y0 + ky * x0;
        }
      double[] out = new double[8];
      for (int i = 0; i < 8; i += 2) {
        double lx = ax + corners[i] * cos - corners[i + 1] * sin;
        double ly = ay + corners[i] * sin + corners[i + 1] * cos;
        out[i] = JsNum.f32(m.a * lx + m.b * ly + m.x);
        out[i + 1] = JsNum.f32(m.c * lx + m.d * ly + m.y);
      }
      return out;
    }
    if (att instanceof MeshAttachment || att instanceof PathAttachment || att instanceof BoundingBoxAttachment) {
      double[] verts;
      MeshAttachment.VertexWeight[][] weights;
      String linked = null;
      if (att instanceof MeshAttachment) {
        MeshAttachment mesh = (MeshAttachment) att;
        verts = mesh.vertices;
        weights = mesh.weights;
        if (mesh.linked != null && mesh.linked.deform) linked = mesh.linked.mesh;
      } else if (att instanceof PathAttachment) {
        verts = ((PathAttachment) att).vertices;
        weights = ((PathAttachment) att).weights;
      } else {
        verts = ((BoundingBoxAttachment) att).vertices;
        weights = ((BoundingBoxAttachment) att).weights;
      }
      int n = verts.length / 2;
      double[] deform = linked != null ? slot.deform.get(linked) : null;
      if (deform == null) deform = slot.deform.get(att.name);
      double[] out = new double[n * 2];
      if (weights != null) {
        for (int v = 0; v < n; v++) {
          double wx = 0, wy = 0;
          double dx = deform != null && v * 2 < deform.length ? deform[v * 2] : 0;
          double dy = deform != null && v * 2 + 1 < deform.length ? deform[v * 2 + 1] : 0;
          for (MeshAttachment.VertexWeight inf : weights[v]) {
            Bone ib = boneById.get(inf.bone);
            Affine bm = ib != null ? ib.world : m;
            double lx = inf.x + dx, ly = inf.y + dy;
            wx += (bm.a * lx + bm.b * ly + bm.x) * inf.weight;
            wy += (bm.c * lx + bm.d * ly + bm.y) * inf.weight;
          }
          out[v * 2] = JsNum.f32(wx);
          out[v * 2 + 1] = JsNum.f32(wy);
        }
      } else {
        for (int v = 0; v < n; v++) {
          double lx = verts[v * 2] + (deform != null && v * 2 < deform.length ? deform[v * 2] : 0);
          double ly = verts[v * 2 + 1] + (deform != null && v * 2 + 1 < deform.length ? deform[v * 2 + 1] : 0);
          out[v * 2] = JsNum.f32(m.a * lx + m.b * ly + m.x);
          out[v * 2 + 1] = JsNum.f32(m.c * lx + m.d * ly + m.y);
        }
      }
      return out;
    }
    double[] local;
    if (att instanceof ShapeAttachment) local = shapeOutline((ShapeAttachment) att);
    else if (att instanceof ClippingAttachment) local = ((ClippingAttachment) att).vertices;
    else if (att instanceof PointAttachment) local = new double[] {((PointAttachment) att).x, ((PointAttachment) att).y};
    else if (att instanceof ParticlesAttachment) local = new double[] {((ParticlesAttachment) att).x, ((ParticlesAttachment) att).y};
    else local = new double[0];
    double[] out = new double[local.length];
    for (int i = 0; i + 1 < local.length; i += 2) {
      out[i] = JsNum.f32(m.a * local[i] + m.b * local[i + 1] + m.x);
      out[i + 1] = JsNum.f32(m.c * local[i] + m.d * local[i + 1] + m.y);
    }
    return out;
  }

  /** Outline polygon of a shape in slot-bone space (core/geometry.ts shapeOutline, 32 segments). */
  public static double[] shapeOutline(ShapeAttachment s) {
    int segments = 32;
    List<Double> pts = new ArrayList<>();
    double hw = s.width / 2, hh = s.height / 2;
    if (s.shape.equals("rect")) {
      double r = Math.min(s.radius, Math.min(hw, hh));
      if (r <= 0) {
        double[] q = {-hw, -hh, hw, -hh, hw, hh, -hw, hh};
        for (double d : q) pts.add(d);
      } else {
        double[][] corners = {{hw - r, -hh + r, -90}, {hw - r, hh - r, 0}, {-hw + r, hh - r, 90}, {-hw + r, -hh + r, 180}};
        int seg = (int) Math.max(2, JsNum.round(segments / 4.0));
        for (double[] cc : corners)
          for (int i = 0; i <= seg; i++) {
            double a = (cc[2] + (90.0 * i) / seg) * MathUtil.DEG;
            pts.add(cc[0] + Math.cos(a) * r);
            pts.add(cc[1] + Math.sin(a) * r);
          }
      }
    } else if (s.shape.equals("ellipse")) {
      for (int i = 0; i < segments; i++) {
        double a = ((double) i / segments) * Math.PI * 2;
        pts.add(Math.cos(a) * hw);
        pts.add(Math.sin(a) * hh);
      }
    } else if (s.points != null) for (double d : s.points) pts.add(d);
    double cos = Math.cos(s.rotation * MathUtil.DEG), sin = Math.sin(s.rotation * MathUtil.DEG);
    double[] out = new double[pts.size()];
    for (int i = 0; i + 1 < out.length; i += 2) {
      double x0 = pts.get(i), y0 = pts.get(i + 1);
      out[i] = s.x + x0 * cos - y0 * sin;
      out[i + 1] = s.y + x0 * sin + y0 * cos;
    }
    if (out.length % 2 == 1) out[out.length - 1] = pts.get(out.length - 1);
    return out;
  }

  // ---------------- Draw list ----------------

  /** Renderable geometry in draw order (docs/runtime-spec.md §8.4). */
  public List<DrawItem> drawList() {
    List<DrawItem> items = new ArrayList<>();
    DrawItem.ClipRegion clip = null;
    String clipEnd = null;
    for (Slot slot : drawOrder) {
      Attachment att = slot.bone.active ? getAttachment(slot) : null;
      int first = items.size();
      if (att instanceof ClippingAttachment) {
        ClippingAttachment ca = (ClippingAttachment) att;
        if (clip == null && ca.vertices.length >= 6) {
          String key = Json.stringify(ca.vertices);
          Object[] cached = clipCache.get(att);
          if (cached == null || !cached[0].equals(key)) {
            cached = new Object[] {key, Earcut.triangulate(ca.vertices)};
            clipCache.put(att, cached);
          }
          clip = new DrawItem.ClipRegion(slot, attachmentWorldVertices(slot, att), (int[]) cached[1]);
          clipEnd = ca.end;
        }
      } else if (att instanceof RegionAttachment || att instanceof MeshAttachment) {
        String imageId = att instanceof RegionAttachment ? ((RegionAttachment) att).image : ((MeshAttachment) att).image;
        String colorHex = att instanceof RegionAttachment ? ((RegionAttachment) att).color : ((MeshAttachment) att).color;
        ImageAsset image = images.get(imageId);
        double[] color = MathUtil.mulColor(slot.color, MathUtil.parseHex(colorHex));
        if (color[3] > 0) {
          double[] vertices = attachmentWorldVertices(slot, att);
          Packed pk = packed.get(imageId);
          double[] uvs;
          int[] indices;
          if (att instanceof RegionAttachment) {
            uvs = pk != null ? pk.regionUvs : REGION_UVS;
            indices = REGION_INDICES;
            if (pk != null && pk.polyImage != null) {
              vertices = quadPoints(vertices, pk.polyImage);
              uvs = pk.polyUvs;
              indices = pk.polyIndices;
            } else if (pk != null && pk.trim != null) vertices = trimQuad(vertices, pk.trim[0], pk.trim[1], pk.trim[2], pk.trim[3]);
          } else {
            MeshAttachment mesh = (MeshAttachment) att;
            uvs = pk != null ? pk.map.remap(mesh.uvs) : f32(mesh.uvs.clone());
            indices = mesh.triangles;
          }
          DrawItem it = new DrawItem();
          it.slot = slot;
          it.attachment = att;
          it.image = image;
          it.texture = pk != null ? pk.page : image != null ? new DrawItem.TextureRef(image.id, image.width, image.height) : null;
          if (pk != null) it.textureRect = pk.rect;
          it.vertices = vertices;
          it.uvs = uvs;
          it.indices = indices;
          it.color = color;
          it.dark = slot.dark;
          it.blend = slot.data.blend;
          items.add(it);
        }
      } else if (att instanceof SequenceAttachment) {
        DrawItem it = sequenceItem(slot, (SequenceAttachment) att, sequenceFrame(slot, (SequenceAttachment) att));
        if (it != null) items.add(it);
      } else if (att instanceof ParticlesAttachment) {
        DrawItem it = particleItem(slot, (ParticlesAttachment) att);
        if (it != null) items.add(it);
      } else if (att instanceof TextAttachment) {
        TextAttachment ta = (TextAttachment) att;
        double[] color = slot.color;
        if (color[3] > 0) {
          DrawItem it = new DrawItem();
          it.slot = slot;
          it.attachment = att;
          it.vertices = attachmentWorldVertices(slot, att);
          it.uvs = REGION_UVS;
          it.indices = REGION_INDICES;
          it.color = color;
          it.blend = slot.data.blend;
          DrawItem.Text t = new DrawItem.Text();
          t.content = textContent(slot, ta);
          t.font = ta.font;
          t.size = ta.size;
          t.weight = ta.weight;
          t.align = ta.align;
          t.width = ta.width;
          t.height = ta.height;
          t.fill = MathUtil.parseHex(ta.color);
          t.outline = ta.outline != null && !ta.outline.isEmpty() && ta.outlineWidth != null && ta.outlineWidth != 0 && !Double.isNaN(ta.outlineWidth) ? MathUtil.parseHex(ta.outline) : null;
          t.outlineWidth = ta.outlineWidth != null ? ta.outlineWidth : 0;
          t.matrix = textMatrix(slot, ta);
          it.text = t;
          items.add(it);
        }
      } else if (att instanceof ShapeAttachment) {
        ShapeAttachment sa = (ShapeAttachment) att;
        double[] outline = attachmentWorldVertices(slot, att);
        String key = sa.shape + "|" + sa.width + "|" + sa.height + "|" + sa.radius + "|" + (sa.points == null ? "" : Json.stringify(sa.points));
        Object[] cached = shapeCache.get(att);
        if (cached == null || !cached[0].equals(key)) {
          cached = new Object[] {key, Earcut.triangulate(shapeOutline(sa))};
          shapeCache.put(att, cached);
        }
        double[] color = MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.fill));
        boolean hasStroke = sa.stroke != null && !sa.stroke.isEmpty() && sa.strokeWidth != null && sa.strokeWidth > 0
            && MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.stroke))[3] > 0;
        if (color[3] > 0 || hasStroke) {
          DrawItem it = new DrawItem();
          it.slot = slot;
          it.attachment = att;
          it.texture = white != null ? white.page : null;
          it.vertices = outline;
          it.uvs = white != null ? fill2(outline.length, white.u, white.v) : new double[outline.length];
          it.indices = (int[]) cached[1];
          it.color = color;
          it.blend = slot.data.blend;
          if (sa.stroke != null && !sa.stroke.isEmpty() && sa.strokeWidth != null && sa.strokeWidth != 0 && !Double.isNaN(sa.strokeWidth))
            it.stroke = new DrawItem.Stroke(MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.stroke)), sa.strokeWidth, outline);
          items.add(it);
        }
      }
      if (clip != null && clip.slot != slot) for (int i = first; i < items.size(); i++) items.get(i).clip = clip;
      if (clip != null && slot.data.id.equals(clipEnd)) {
        clip = null;
        clipEnd = null;
      }
    }
    return items;
  }

  private DrawItem particleItem(Slot slot, ParticlesAttachment att) {
    ParticleEmitter em = emitters.get(slot.data.id);
    if (em == null || em.data != att || em.alive() == 0) return null;
    ParticleEmitter.Geometry geo = em.geometry(particleFrac, slot.bone.world, slot.color);
    if (geo.count == 0) return null;
    DrawItem.TextureRef texture = null;
    ImageAsset image = null;
    double[] uvs = geo.uvs;
    double[] textureRect = null;
    if (att.look.equals("image")) {
      image = att.image != null && !att.image.isEmpty() ? images.get(att.image) : null;
      Packed pk = att.image != null && !att.image.isEmpty() ? packed.get(att.image) : null;
      if (pk != null) {
        texture = pk.page;
        textureRect = pk.rect;
        uvs = pk.map.remap(geo.uvs);
      } else if (image != null) texture = new DrawItem.TextureRef(image.id, image.width, image.height);
      if (texture == null) return null;
    } else if (att.look.equals("square")) {
      if (white != null) {
        texture = white.page;
        uvs = fill2(geo.uvs.length, white.u, white.v);
      }
    } else texture = new DrawItem.TextureRef(DrawItem.PARTICLE_DOT_TEXTURE, DrawItem.PARTICLE_DOT_SIZE, DrawItem.PARTICLE_DOT_SIZE);
    DrawItem it = new DrawItem();
    it.slot = slot;
    it.attachment = att;
    it.image = image;
    it.texture = texture;
    it.textureRect = textureRect;
    it.vertices = geo.vertices;
    it.uvs = uvs;
    it.indices = geo.indices;
    it.color = slot.color;
    it.colors = geo.colors;
    it.blend = att.blend;
    it.particleLook = att.look;
    it.particleCount = geo.count;
    return it;
  }

  // ---------------- Hit testing ----------------

  /** World polygon used for hit tests: the current bounding box, else the slot's first bounding box, else the attachment. */
  public double[] hitPolygon(Slot slot) {
    Attachment att = getAttachment(slot);
    if (!(att instanceof BoundingBoxAttachment)) {
      Map<String, Attachment> all = new LinkedHashMap<>();
      SkinData def = doc.defaultSkin();
      if (def != null && def.attachments.get(slot.data.id) != null) all.putAll(def.attachments.get(slot.data.id));
      if (skin != null && skin.attachments.get(slot.data.id) != null) all.putAll(skin.attachments.get(slot.data.id));
      Attachment found = null;
      for (String k : jsKeyOrder(all.keySet()))
        if (all.get(k) instanceof BoundingBoxAttachment) {
          found = all.get(k);
          break;
        }
      if (found != null) att = found;
    }
    if (att == null) return null;
    if (att instanceof BoundingBoxAttachment || att instanceof ShapeAttachment || att instanceof ClippingAttachment) return attachmentWorldVertices(slot, att);
    if (att instanceof RegionAttachment || att instanceof SequenceAttachment || att instanceof TextAttachment) return attachmentWorldVertices(slot, att);
    if (att instanceof MeshAttachment) {
      double[] v = attachmentWorldVertices(slot, att);
      return java.util.Arrays.copyOf(v, Math.min(v.length, ((MeshAttachment) att).hull * 2));
    }
    return null;
  }

  /** Property order of a JS object: array-index keys ascending, then the rest in insertion order. */
  static List<String> jsKeyOrder(Iterable<String> keys) {
    List<String> ints = new ArrayList<>(), rest = new ArrayList<>();
    for (String k : keys) (isArrayIndex(k) ? ints : rest).add(k);
    ints.sort((a, b) -> Long.compare(Long.parseLong(a), Long.parseLong(b)));
    ints.addAll(rest);
    return ints;
  }

  private static boolean isArrayIndex(String k) {
    if (k.isEmpty() || k.length() > 10) return false;
    if (k.length() > 1 && k.charAt(0) == '0') return false;
    for (int i = 0; i < k.length(); i++) if (k.charAt(i) < '0' || k.charAt(i) > '9') return false;
    return Long.parseLong(k) < 4294967295L;
  }

  /**
   * The active bounding boxes in the current pose (world polygons, their AABB, point / segment / AABB / skeleton
   * overlap queries). A snapshot: take a new one, or call {@link SkeletonBounds#update} on it, after the pose changes.
   */
  public SkeletonBounds boundingBoxes() {
    return new SkeletonBounds(this);
  }

  public boolean hitTest(Slot slot, double px, double py) {
    if (!slot.bone.active) return false;
    double[] poly = hitPolygon(slot);
    return poly != null && MathUtil.pointInPolygon(px, py, poly);
  }

  /** Axis-aligned bounds {minX, minY, maxX, maxY} of everything drawn and every bone. */
  public double[] bounds() {
    double[] b = {Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY};
    for (DrawItem it : drawList()) for (int i = 0; i + 1 < it.vertices.length; i += 2) addBound(b, it.vertices[i], it.vertices[i + 1]);
    for (Bone bone : bones) {
      addBound(b, bone.world.x, bone.world.y);
      addBound(b, bone.world.applyX(bone.data.length, 0), bone.world.applyY(bone.data.length, 0));
    }
    return b;
  }

  private static void addBound(double[] b, double x, double y) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }

  private static double[] fill2(int n, double a, double b) {
    double[] out = new double[n];
    double fa = JsNum.f32(a), fb = JsNum.f32(b);
    for (int i = 0; i + 1 < n; i += 2) {
      out[i] = fa;
      out[i + 1] = fb;
    }
    return out;
  }

  /** Shrink a region quad (TL, TR, BR, BL) to the part [u0, v0, u1, v1] of its image. */
  static double[] trimQuad(double[] q, double u0, double v0, double u1, double v1) {
    double ux = q[2] - q[0], uy = q[3] - q[1], vx = q[6] - q[0], vy = q[7] - q[1];
    double[] out = new double[8];
    double[][] uv = {{u0, v0}, {u1, v0}, {u1, v1}, {u0, v1}};
    for (int i = 0; i < 4; i++) {
      out[i * 2] = JsNum.f32(q[0] + ux * uv[i][0] + vx * uv[i][1]);
      out[i * 2 + 1] = JsNum.f32(q[1] + uy * uv[i][0] + vy * uv[i][1]);
    }
    return out;
  }

  /** Points in 0..1 image space placed on a region quad (TL, TR, BR, BL). */
  static double[] quadPoints(double[] q, double[] uv) {
    double ux = q[2] - q[0], uy = q[3] - q[1], vx = q[6] - q[0], vy = q[7] - q[1];
    double[] out = new double[uv.length];
    for (int i = 0; i + 1 < uv.length; i += 2) {
      out[i] = JsNum.f32(q[0] + ux * uv[i] + vx * uv[i + 1]);
      out[i + 1] = JsNum.f32(q[1] + uy * uv[i] + vy * uv[i + 1]);
    }
    return out;
  }
}
