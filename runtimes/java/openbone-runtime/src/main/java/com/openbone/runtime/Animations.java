package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import com.openbone.runtime.data.EventData;
import com.openbone.runtime.data.Inherit;
import com.openbone.runtime.data.Key;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.runtime.data.ParticlesAttachment;
import com.openbone.runtime.data.Attachment;
import com.openbone.runtime.data.Timeline;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Objects;
import java.util.List;
import java.util.Set;

/** Timeline sampling and application (runtime/animation.ts). */
public final class Animations {
  private Animations() {}

  /** Index of key a (and b = a + 1, or -1) and the eased fraction. */
  private static final class Located {
    Key a, b;
    double t;
  }

  private static Located locate(Key[] keys, double time) {
    Located l = new Located();
    if (time <= keys[0].time) {
      l.a = keys[0];
      return l;
    }
    Key last = keys[keys.length - 1];
    if (time >= last.time) {
      l.a = last;
      return l;
    }
    int lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) {
      int mid = (lo + hi) >> 1;
      if (keys[mid].time <= time) lo = mid;
      else hi = mid;
    }
    l.a = keys[lo];
    l.b = keys[hi];
    double span = l.b.time - l.a.time;
    double f = (time - l.a.time) / (span == 0 || Double.isNaN(span) ? 1 : span);
    l.t = l.a.curve.apply(f);
    return l;
  }

  static double num(Object v) {
    return JsNum.toNumber(v);
  }

  public static double sampleNumber(Key[] keys, double time) {
    Located l = locate(keys, time);
    if (l.b == null || l.a.curve.isStepped()) return num(l.a.value);
    return MathUtil.lerp(num(l.a.value), num(l.b.value), l.t);
  }

  public static double[] sampleArray(Key[] keys, double time) {
    Located l = locate(keys, time);
    double[] av = l.a.value instanceof double[] ? (double[]) l.a.value : new double[0];
    if (l.b == null || l.a.curve.isStepped()) return av;
    double[] bv = l.b.value instanceof double[] ? (double[]) l.b.value : new double[0];
    int n = Math.max(av.length, bv.length);
    double[] out = new double[n];
    for (int i = 0; i < n; i++) out[i] = MathUtil.lerp(i < av.length ? av[i] : 0, i < bv.length ? bv[i] : 0, l.t);
    return out;
  }

  public static Object sampleStep(Key[] keys, double time) {
    return locate(keys, time).a.value;
  }

  /** Local playback time for a total elapsed time. */
  public static double localTime(AnimationData anim, double total, boolean loop) {
    double d = anim.duration();
    if (d <= 0) return 0;
    if (loop) return ((total % d) + d) % d;
    return Math.min(Math.max(total, 0), d);
  }

  /** Pose the skeleton with an animation at local time {@code time}, mixed over the current pose by {@code alpha}. */
  public static void apply(Skeleton sk, AnimationData anim, double time, double alpha) {
    apply(sk, anim, anim.timelines, time, alpha, null);
  }

  /** The same, for an animation being faded out (see {@link MixOut}); {@code mixOut} may be null. */
  public static void apply(Skeleton sk, AnimationData anim, double time, double alpha, MixOut mixOut) {
    apply(sk, anim, anim.timelines, time, alpha, mixOut);
  }

  /** True for timelines whose values blend (a mix fades them); false for the ones that switch at keys. */
  static boolean blends(Timeline tl) {
    switch (tl.target) {
      case "bone": return !"inherit".equals(tl.property);
      case "slot": return "color".equals(tl.property) || "dark".equals(tl.property);
      case "ik": return !"bend".equals(tl.property) && !"stretch".equals(tl.property) && !"compress".equals(tl.property);
      case "transform":
      case "path":
      case "physics":
      case "deform": return true;
      case "particles": return "rate".equals(tl.property);
      default: return false;
    }
  }

  /** Whether any of {@code anims} has a keyed timeline for the same value as {@code tl} (same target, id, property and attachment). */
  public static boolean keyedBy(List<AnimationData> anims, Timeline tl) {
    for (AnimationData a : anims)
      for (Timeline o : a.timelines)
        if (o.keys.length > 0 && Objects.equals(o.target, tl.target) && Objects.equals(o.id, tl.id)
            && Objects.equals(o.property, tl.property) && Objects.equals(o.attachment, tl.attachment)) return true;
    return false;
  }

  static void apply(Skeleton sk, AnimationData anim, List<Timeline> timelines, double time, double alpha) {
    apply(sk, anim, timelines, time, alpha, null);
  }

  static void apply(Skeleton sk, AnimationData anim, List<Timeline> timelines, double time, double full, MixOut mixOut) {
    if (full <= 0) return;
    if (full >= 0.5 || sk.animationTime == null) sk.animationTime = time;
    for (Timeline tl : timelines) {
      if (tl.keys.length == 0) continue;
      double alpha = mixOut != null && blends(tl) && !keyedBy(mixOut.into, tl) ? mixOut.alpha : full;
      if (alpha <= 0) continue;
      switch (tl.target) {
        case "bone": {
          Bone bone = sk.boneById(tl.id);
          if (bone == null) break;
          if (tl.property.equals("inherit")) {
            if (alpha >= 0.5) bone.inherit = Inherit.parse(JsNum.str(sampleStep(tl.keys, time)));
            break;
          }
          double v = sampleNumber(tl.keys, time);
          String prop = tl.property;
          double cur = bone.get(prop);
          bone.set(prop, alpha >= 1 ? v : prop.equals("rotation") ? MathUtil.lerpAngle(cur, v, alpha) : MathUtil.lerp(cur, v, alpha));
          break;
        }
        case "slot": {
          Slot slot = sk.slotById(tl.id);
          if (slot == null) break;
          if (tl.property.equals("color") || tl.property.equals("dark")) {
            Located l = locate(tl.keys, time);
            double[] ca = MathUtil.parseHex((String) l.a.value);
            double[] v = l.b == null || l.a.curve.isStepped() ? ca : MathUtil.lerpColor(ca, MathUtil.parseHex((String) l.b.value), l.t);
            if (tl.property.equals("color")) slot.color = alpha >= 1 ? v : MathUtil.lerpColor(slot.color, v, alpha);
            else slot.dark = alpha >= 1 ? v : MathUtil.lerpColor(slot.dark != null ? slot.dark : new double[] {0, 0, 0, 1}, v, alpha);
          } else if (alpha >= 0.5) {
            Object v = sampleStep(tl.keys, time);
            slot.attachmentName = v == null ? null : JsNum.str(v);
          }
          break;
        }
        case "ik":
        case "transform":
        case "path":
        case "physics": {
          Skeleton.ConstraintValues values = sk.constraintValues.get(tl.id);
          if (values == null) break;
          String prop = tl.property;
          if (tl.target.equals("ik") && (prop.equals("bend") || prop.equals("stretch") || prop.equals("compress"))) {
            if (alpha >= 0.5) values.put(prop, num(sampleStep(tl.keys, time)));
          } else values.put(prop, MathUtil.lerp(values.get(prop, 0), sampleNumber(tl.keys, time), alpha));
          break;
        }
        case "particles": {
          Slot slot = sk.slotById(tl.id);
          if (slot == null) break;
          ParticleEmitter.Values cur = sk.particleValues.get(tl.id);
          if (cur == null) cur = new ParticleEmitter.Values();
          if (tl.property.equals("emitting")) {
            if (alpha >= 0.5) {
              Object v = sampleStep(tl.keys, time);
              cur.emitting = v == null ? null : JsNum.truthy(v);
            }
          } else {
            Attachment att = sk.getAttachment(slot);
            double base = cur.rate != null ? cur.rate : att instanceof ParticlesAttachment ? ((ParticlesAttachment) att).rate : 0;
            cur.rate = MathUtil.lerp(base, sampleNumber(tl.keys, time), alpha);
          }
          sk.particleValues.put(tl.id, cur);
          break;
        }
        case "deform": {
          Slot slot = sk.slotById(tl.id);
          if (slot == null) break;
          double[] v = sampleArray(tl.keys, time);
          double[] cur = slot.deform.get(tl.attachment);
          double[] out;
          if (cur != null && alpha < 1) {
            out = new double[v.length];
            for (int i = 0; i < v.length; i++) out[i] = MathUtil.lerp(i < cur.length ? cur[i] : 0, v[i], alpha);
          } else if (alpha < 1) {
            out = new double[v.length];
            for (int i = 0; i < v.length; i++) out[i] = v[i] * alpha;
          } else out = v;
          slot.deform.put(tl.attachment, out);
          break;
        }
        case "sequence": {
          Slot slot = sk.slotById(tl.id);
          if (slot == null) break;
          if (alpha >= 0.5) slot.sequenceFrames.put(tl.attachment, sampleNumber(tl.keys, time));
          break;
        }
        case "drawOrder": {
          if (alpha < 0.5) break;
          Object ov = sampleStep(tl.keys, time);
          String[] order = ov instanceof String[] ? (String[]) ov : new String[0];
          List<Slot> listed = new ArrayList<>();
          for (String id : order) {
            Slot s = id == null ? null : sk.slotById(id);
            if (s != null) listed.add(s);
          }
          Set<Slot> placed = new HashSet<>(listed);
          Slot[] out = new Slot[sk.slots.size()];
          for (int i = 0; i < out.length; i++) if (!placed.contains(sk.slots.get(i))) out[i] = sk.slots.get(i);
          int next = 0;
          for (int i = 0; i < out.length && next < listed.size(); i++) if (out[i] == null) out[i] = listed.get(next++);
          List<Slot> order2 = new ArrayList<>();
          for (Slot s : out) if (s != null) order2.add(s);
          sk.drawOrder = order2;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Event keys crossed when total time moves from prev (exclusive) to next (inclusive). */
  public static List<FiredEvent> eventsBetween(OpenBoneDocument doc, AnimationData anim, double prev, double next, boolean loop) {
    List<FiredEvent> out = new ArrayList<>();
    if (anim.events.isEmpty() || next <= prev) return out;
    double d = anim.duration();
    for (AnimationData.EventKey k : anim.events) {
      EventData ev = doc.eventById(k.event);
      if (ev == null) continue;
      if (!loop || d <= 0) {
        if (k.time > prev && k.time <= next) out.add(fire(k, ev, anim));
        continue;
      }
      double first = Math.floor(prev / d), lastC = Math.floor(next / d);
      for (double c = first; c <= lastC; c++) {
        double at = c * d + k.time;
        if (at > prev && at <= next) out.add(fire(k, ev, anim));
      }
    }
    return out;
  }

  private static FiredEvent fire(AnimationData.EventKey k, EventData ev, AnimationData anim) {
    return new FiredEvent(ev.name, ev.id, k.time, k.intValue != null ? k.intValue : ev.intValue, k.floatValue != null ? k.floatValue : ev.floatValue,
        k.stringValue != null ? k.stringValue : ev.stringValue, ev.audio != null && !ev.audio.isEmpty() ? ev.audio : null, ev.volume, anim.name);
  }
}
