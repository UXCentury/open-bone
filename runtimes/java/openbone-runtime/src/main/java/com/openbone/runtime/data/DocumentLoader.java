package com.openbone.runtime.data;

import com.openbone.runtime.Json;
import com.openbone.runtime.JsNum;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Loads documents: JSON (.obone) or binary (.obonb), then fills the defaults {@code normalizeDocument} fills
 * (docs/runtime-spec.md §2).
 */
public final class DocumentLoader {
  private DocumentLoader() {}

  public static final int FORMAT_VERSION = 1;

  /** Load from file bytes, whichever format they are in. */
  public static OpenBoneDocument load(byte[] bytes) {
    return isBinary(bytes) ? fromBinary(bytes) : fromJson(new String(bytes, StandardCharsets.UTF_8));
  }

  public static OpenBoneDocument fromJson(String json) {
    if (!json.isEmpty() && json.charAt(0) == '﻿') json = json.substring(1);
    return fromTree(Json.parse(json));
  }

  /** Build from a parsed JSON tree (maps, lists, Double, String, Boolean, null). */
  @SuppressWarnings("unchecked")
  public static OpenBoneDocument fromTree(Object tree) {
    if (!(tree instanceof Map)) throw new IllegalArgumentException("Not an OpenBone document (missing format: \"openbone\")");
    Map<String, Object> m = (Map<String, Object>) tree;
    if (!"openbone".equals(m.get("format"))) throw new IllegalArgumentException("Not an OpenBone document (missing format: \"openbone\")");
    double version = num(m, "version", 1);
    if (version > FORMAT_VERSION) throw new IllegalArgumentException("Document version " + JsNum.toString(version) + " is newer than supported " + FORMAT_VERSION);
    OpenBoneDocument d = new OpenBoneDocument();
    d.version = (int) version;
    d.name = str(m, "name", "");
    d.width = num(m, "width", 0);
    d.height = num(m, "height", 0);
    d.originX = num(m, "originX", 0);
    d.originY = num(m, "originY", 0);
    d.background = str(m, "background", null);
    d.fps = num(m, "fps", 30);
    for (Map<String, Object> x : maps(m.get("images"))) {
      ImageAsset i = new ImageAsset();
      i.id = str(x, "id", "");
      i.name = str(x, "name", "");
      i.src = str(x, "src", "");
      i.width = num(x, "width", 0);
      i.height = num(x, "height", 0);
      d.images.add(i);
    }
    if (m.get("atlas") instanceof Map) d.atlas = atlas((Map<String, Object>) m.get("atlas"));
    skeleton(d.skeleton, map(m.get("skeleton")));
    for (Map<String, Object> x : maps(m.get("events"))) {
      EventData e = new EventData();
      e.id = str(x, "id", "");
      e.name = str(x, "name", "");
      e.intValue = num(x, "int", 0);
      e.floatValue = num(x, "float", 0);
      e.stringValue = str(x, "string", "");
      e.audio = str(x, "audio", null);
      e.volume = optNum(x, "volume");
      d.events.add(e);
    }
    for (Map<String, Object> x : maps(m.get("animations"))) d.animations.add(animation(x));
    for (Map<String, Object> x : maps(m.get("stateMachines"))) d.stateMachines.add(stateMachine(x));
    for (Map<String, Object> x : maps(m.get("scripts"))) {
      ScriptData s = new ScriptData();
      s.id = str(x, "id", "");
      s.name = str(x, "name", "");
      s.code = str(x, "code", "");
      d.scripts.add(s);
    }
    if (m.get("audio") instanceof Map) d.audio = audio((Map<String, Object>) m.get("audio"));
    return d;
  }

  // ---------------- Sections ----------------

  private static AtlasData atlas(Map<String, Object> m) {
    AtlasData a = new AtlasData();
    for (Map<String, Object> x : maps(m.get("pages"))) {
      AtlasData.Page p = new AtlasData.Page();
      p.id = str(x, "id", "");
      p.name = str(x, "name", "");
      p.src = str(x, "src", "");
      p.width = num(x, "width", 0);
      p.height = num(x, "height", 0);
      a.pages.add(p);
    }
    for (Map<String, Object> x : maps(m.get("regions"))) {
      AtlasData.Region r = new AtlasData.Region();
      r.image = str(x, "image", "");
      r.page = str(x, "page", "");
      r.x = num(x, "x", 0);
      r.y = num(x, "y", 0);
      r.width = num(x, "width", 0);
      r.height = num(x, "height", 0);
      r.offsetX = num(x, "offsetX", 0);
      r.offsetY = num(x, "offsetY", 0);
      r.originalWidth = num(x, "originalWidth", r.width);
      r.originalHeight = num(x, "originalHeight", r.height);
      r.rotated = bool(x, "rotated", false);
      r.polygon = nums(x.get("polygon"));
      a.regions.add(r);
    }
    Map<String, Object> w = map(m.get("white"));
    if (m.get("white") != null) {
      a.white = new AtlasData.White();
      a.white.page = str(w, "page", "");
      a.white.x = num(w, "x", 0);
      a.white.y = num(w, "y", 0);
      a.white.width = num(w, "width", 0);
      a.white.height = num(w, "height", 0);
    }
    a.padding = num(m, "padding", 0);
    a.scale = num(m, "scale", 1);
    a.premultipliedAlpha = bool(m, "premultipliedAlpha", false);
    a.stripWhitespace = bool(m, "stripWhitespace", false);
    a.polygons = bool(m, "polygons", false);
    return a;
  }

  private static void skeleton(SkeletonData sk, Map<String, Object> m) {
    for (Map<String, Object> x : maps(m.get("bones"))) {
      BoneData b = new BoneData();
      b.id = str(x, "id", "");
      b.name = str(x, "name", "");
      b.parent = str(x, "parent", null);
      b.length = num(x, "length", 0);
      b.x = num(x, "x", 0);
      b.y = num(x, "y", 0);
      b.rotation = num(x, "rotation", 0);
      b.scaleX = num(x, "scaleX", 1);
      b.scaleY = num(x, "scaleY", 1);
      b.shearX = num(x, "shearX", 0);
      b.shearY = num(x, "shearY", 0);
      b.inherit = Inherit.parse(str(x, "inherit", "normal"));
      b.color = str(x, "color", null);
      sk.bones.add(b);
    }
    for (Map<String, Object> x : maps(m.get("slots"))) {
      SlotData s = new SlotData();
      s.id = str(x, "id", "");
      s.name = str(x, "name", "");
      s.bone = str(x, "bone", "");
      s.color = str(x, "color", "#ffffffff");
      s.attachment = str(x, "attachment", null);
      s.blend = str(x, "blend", "normal");
      s.dark = str(x, "dark", null);
      sk.slots.add(s);
    }
    for (Map<String, Object> x : maps(m.get("skins"))) {
      SkinData k = new SkinData();
      k.id = str(x, "id", "");
      k.name = str(x, "name", "");
      Map<String, Object> atts = map(x.get("attachments"));
      for (Map.Entry<String, Object> e : atts.entrySet()) {
        Map<String, Attachment> slotAtts = new LinkedHashMap<>();
        for (Map.Entry<String, Object> a : map(e.getValue()).entrySet()) {
          Attachment att = attachment(a.getKey(), map(a.getValue()));
          if (att != null) slotAtts.put(a.getKey(), att);
        }
        k.attachments.put(e.getKey(), slotAtts);
      }
      if (x.get("bones") instanceof List) k.bones = strs(x.get("bones"));
      if (x.get("constraints") instanceof List) k.constraints = strs(x.get("constraints"));
      sk.skins.add(k);
    }
    for (Map<String, Object> x : maps(m.get("ik"))) {
      IkConstraintData c = new IkConstraintData();
      base(c, x);
      c.bones.addAll(strs(x.get("bones")));
      c.target = str(x, "target", "");
      c.mix = num(x, "mix", 0);
      c.bendPositive = bool(x, "bendPositive", false);
      c.softness = num(x, "softness", 0);
      c.stretch = bool(x, "stretch", false);
      c.compress = bool(x, "compress", false);
      c.uniform = bool(x, "uniform", false);
      sk.ik.add(c);
    }
    for (Map<String, Object> x : maps(m.get("transform"))) {
      TransformConstraintData c = new TransformConstraintData();
      base(c, x);
      c.bones.addAll(strs(x.get("bones")));
      c.target = str(x, "target", "");
      c.mixRotate = num(x, "mixRotate", 0);
      c.mixTranslate = num(x, "mixTranslate", 0);
      c.mixScale = num(x, "mixScale", 0);
      c.mixShear = num(x, "mixShear", 0);
      c.offsetRotation = num(x, "offsetRotation", 0);
      c.offsetX = num(x, "offsetX", 0);
      c.offsetY = num(x, "offsetY", 0);
      c.offsetScaleX = num(x, "offsetScaleX", 0);
      c.offsetScaleY = num(x, "offsetScaleY", 0);
      c.offsetShear = num(x, "offsetShear", 0);
      c.local = bool(x, "local", false);
      c.relative = bool(x, "relative", false);
      sk.transform.add(c);
    }
    for (Map<String, Object> x : maps(m.get("path"))) {
      PathConstraintData c = new PathConstraintData();
      base(c, x);
      c.bones.addAll(strs(x.get("bones")));
      c.target = str(x, "target", "");
      c.positionMode = str(x, "positionMode", "percent");
      c.spacingMode = str(x, "spacingMode", "length");
      c.rotateMode = str(x, "rotateMode", "tangent");
      c.offsetRotation = num(x, "offsetRotation", 0);
      c.position = num(x, "position", 0);
      c.spacing = num(x, "spacing", 0);
      c.mixRotate = num(x, "mixRotate", 0);
      c.mixX = num(x, "mixX", 0);
      c.mixY = num(x, "mixY", 0);
      sk.path.add(c);
    }
    for (Map<String, Object> x : maps(m.get("physics"))) {
      PhysicsConstraintData c = new PhysicsConstraintData();
      base(c, x);
      c.bone = str(x, "bone", "");
      c.x = num(x, "x", 0);
      c.y = num(x, "y", 0);
      c.rotate = num(x, "rotate", 0);
      c.scaleX = num(x, "scaleX", 0);
      c.inertia = num(x, "inertia", 0);
      c.strength = num(x, "strength", 0);
      c.damping = num(x, "damping", 0);
      c.mass = num(x, "mass", 0);
      c.gravity = num(x, "gravity", 0);
      c.wind = num(x, "wind", 0);
      c.mix = num(x, "mix", 0);
      c.fps = num(x, "fps", 0);
      sk.physics.add(c);
    }
    for (Map<String, Object> x : maps(m.get("sliders"))) {
      SliderData s = new SliderData();
      s.id = str(x, "id", "");
      s.name = str(x, "name", "");
      s.animation = str(x, "animation", "");
      s.bone = str(x, "bone", null);
      s.property = str(x, "property", null);
      s.input = str(x, "input", null);
      s.from = num(x, "from", 0);
      s.to = num(x, "to", 0);
      s.timeFrom = optNum(x, "timeFrom");
      s.timeTo = optNum(x, "timeTo");
      s.mix = num(x, "mix", 0);
      s.loop = bool(x, "loop", false);
      s.additive = bool(x, "additive", false);
      sk.sliders.add(s);
    }
    sk.referenceScale = optNum(m, "referenceScale");
  }

  private static void base(ConstraintData c, Map<String, Object> x) {
    c.id = str(x, "id", "");
    c.name = str(x, "name", "");
    c.order = optNum(x, "order");
  }

  private static MeshAttachment.VertexWeight[][] weights(Object v) {
    if (!(v instanceof List)) return null;
    List<?> l = (List<?>) v;
    MeshAttachment.VertexWeight[][] out = new MeshAttachment.VertexWeight[l.size()][];
    for (int i = 0; i < l.size(); i++) {
      List<Map<String, Object>> infs = maps(l.get(i));
      out[i] = new MeshAttachment.VertexWeight[infs.size()];
      for (int j = 0; j < infs.size(); j++) {
        MeshAttachment.VertexWeight w = new MeshAttachment.VertexWeight();
        w.bone = str(infs.get(j), "bone", "");
        w.x = num(infs.get(j), "x", 0);
        w.y = num(infs.get(j), "y", 0);
        w.weight = num(infs.get(j), "weight", 0);
        out[i][j] = w;
      }
    }
    return out;
  }

  private static Attachment attachment(String key, Map<String, Object> x) {
    String type = str(x, "type", "");
    Attachment out;
    switch (type) {
      case "region": {
        RegionAttachment a = new RegionAttachment();
        a.image = str(x, "image", "");
        a.x = num(x, "x", 0);
        a.y = num(x, "y", 0);
        a.rotation = num(x, "rotation", 0);
        a.scaleX = num(x, "scaleX", 1);
        a.scaleY = num(x, "scaleY", 1);
        a.skewX = num(x, "skewX", 0);
        a.skewY = num(x, "skewY", 0);
        a.width = num(x, "width", 0);
        a.height = num(x, "height", 0);
        a.color = str(x, "color", "#ffffffff");
        out = a;
        break;
      }
      case "mesh": {
        MeshAttachment a = new MeshAttachment();
        a.image = str(x, "image", "");
        a.uvs = numsOr(x.get("uvs"));
        a.vertices = numsOr(x.get("vertices"));
        double[] tri = numsOr(x.get("triangles"));
        a.triangles = new int[tri.length];
        for (int i = 0; i < tri.length; i++) a.triangles[i] = (int) tri[i];
        a.weights = weights(x.get("weights"));
        a.hull = (int) num(x, "hull", a.vertices.length / 2);
        a.color = str(x, "color", "#ffffffff");
        if (x.get("linked") instanceof Map) {
          Map<String, Object> l = map(x.get("linked"));
          a.linked = new MeshAttachment.Linked();
          a.linked.mesh = str(l, "mesh", "");
          a.linked.slot = str(l, "slot", null);
          a.linked.skin = str(l, "skin", null);
          a.linked.deform = bool(l, "deform", false);
        }
        out = a;
        break;
      }
      case "shape": {
        ShapeAttachment a = new ShapeAttachment();
        a.shape = str(x, "shape", "rect");
        a.x = num(x, "x", 0);
        a.y = num(x, "y", 0);
        a.rotation = num(x, "rotation", 0);
        a.width = num(x, "width", 0);
        a.height = num(x, "height", 0);
        a.radius = num(x, "radius", 0);
        a.points = nums(x.get("points"));
        a.fill = str(x, "fill", "#ffffffff");
        a.stroke = str(x, "stroke", null);
        a.strokeWidth = optNum(x, "strokeWidth");
        out = a;
        break;
      }
      case "boundingBox": {
        BoundingBoxAttachment a = new BoundingBoxAttachment();
        a.vertices = numsOr(x.get("vertices"));
        out = a;
        break;
      }
      case "point": {
        PointAttachment a = new PointAttachment();
        a.x = num(x, "x", 0);
        a.y = num(x, "y", 0);
        a.rotation = num(x, "rotation", 0);
        out = a;
        break;
      }
      case "clipping": {
        ClippingAttachment a = new ClippingAttachment();
        a.vertices = numsOr(x.get("vertices"));
        a.end = str(x, "end", null);
        out = a;
        break;
      }
      case "path": {
        PathAttachment a = new PathAttachment();
        a.vertices = numsOr(x.get("vertices"));
        a.weights = weights(x.get("weights"));
        a.closed = bool(x, "closed", false);
        a.color = str(x, "color", "#ff8800ff");
        out = a;
        break;
      }
      case "sequence": {
        SequenceAttachment a = new SequenceAttachment();
        for (Map<String, Object> f : maps(x.get("frames"))) {
          SequenceAttachment.Frame fr = new SequenceAttachment.Frame();
          fr.image = str(f, "image", "");
          if (f.get("rect") instanceof Map) {
            Map<String, Object> r = map(f.get("rect"));
            fr.rect = new double[] {num(r, "x", 0), num(r, "y", 0), num(r, "width", 0), num(r, "height", 0)};
          }
          if (f.get("trim") instanceof Map) {
            Map<String, Object> t = map(f.get("trim"));
            fr.trim = new double[] {num(t, "x", 0), num(t, "y", 0), num(t, "sourceWidth", 0), num(t, "sourceHeight", 0)};
          }
          a.frames.add(fr);
        }
        a.x = num(x, "x", 0);
        a.y = num(x, "y", 0);
        a.rotation = num(x, "rotation", 0);
        a.scaleX = num(x, "scaleX", 1);
        a.scaleY = num(x, "scaleY", 1);
        a.skewX = num(x, "skewX", 0);
        a.skewY = num(x, "skewY", 0);
        a.width = num(x, "width", 0);
        a.height = num(x, "height", 0);
        a.color = str(x, "color", "#ffffffff");
        a.fps = num(x, "fps", 24);
        a.mode = str(x, "mode", "loop");
        a.offset = num(x, "offset", 0);
        a.input = str(x, "input", null);
        out = a;
        break;
      }
      case "particles": {
        // Missing fields keep the defaults (normalizeDocument fills them from defaultParticleSettings).
        ParticlesAttachment a = new ParticlesAttachment();
        a.emitting = bool(x, "emitting", a.emitting);
        a.rate = num(x, "rate", a.rate);
        if (x.containsKey("bursts"))
          for (Map<String, Object> b : maps(x.get("bursts"))) {
            ParticlesAttachment.Burst bu = new ParticlesAttachment.Burst();
            bu.time = num(b, "time", 0);
            bu.count = num(b, "count", 0);
            a.bursts.add(bu);
          }
        a.maxParticles = num(x, "maxParticles", a.maxParticles);
        a.duration = num(x, "duration", a.duration);
        a.loop = bool(x, "loop", a.loop);
        a.prewarm = bool(x, "prewarm", a.prewarm);
        a.shape = str(x, "shape", a.shape);
        a.x = num(x, "x", a.x);
        a.y = num(x, "y", a.y);
        a.rotation = num(x, "rotation", a.rotation);
        a.angle = num(x, "angle", a.angle);
        a.radius = num(x, "radius", a.radius);
        a.width = num(x, "width", a.width);
        a.height = num(x, "height", a.height);
        a.space = str(x, "space", a.space);
        a.lifetime = range(x.get("lifetime"), a.lifetime);
        a.speed = range(x.get("speed"), a.speed);
        a.gravity = num(x, "gravity", a.gravity);
        a.drag = num(x, "drag", a.drag);
        a.startSize = range(x.get("startSize"), a.startSize);
        a.endSize = range(x.get("endSize"), a.endSize);
        a.startRotation = range(x.get("startRotation"), a.startRotation);
        a.endRotation = range(x.get("endRotation"), a.endRotation);
        a.angularVelocity = range(x.get("angularVelocity"), a.angularVelocity);
        if (x.get("colors") instanceof List) {
          for (Map<String, Object> c : maps(x.get("colors"))) a.colors.add(new ParticlesAttachment.ColorStop(num(c, "t", 0), str(c, "color", "#ffffffff")));
        } else {
          a.colors.add(new ParticlesAttachment.ColorStop(0, "#ffffffff"));
          a.colors.add(new ParticlesAttachment.ColorStop(1, "#ffffff00"));
        }
        a.blend = str(x, "blend", a.blend);
        a.look = str(x, "look", a.look);
        a.image = str(x, "image", null);
        a.stretch = num(x, "stretch", a.stretch);
        a.seed = num(x, "seed", a.seed);
        out = a;
        break;
      }
      case "text": {
        TextAttachment a = new TextAttachment();
        a.text = str(x, "text", "");
        a.x = num(x, "x", 0);
        a.y = num(x, "y", 0);
        a.rotation = num(x, "rotation", 0);
        a.width = num(x, "width", 0);
        a.height = num(x, "height", 0);
        a.font = str(x, "font", "sans-serif");
        a.size = num(x, "size", 24);
        a.weight = num(x, "weight", 400);
        a.color = str(x, "color", "#ffffffff");
        a.align = str(x, "align", "center");
        a.outline = str(x, "outline", null);
        a.outlineWidth = optNum(x, "outlineWidth");
        out = a;
        break;
      }
      default:
        return null;
    }
    out.name = str(x, "name", key);
    return out;
  }

  private static double[] range(Object v, double[] def) {
    double[] r = nums(v);
    return r != null && r.length >= 2 ? new double[] {r[0], r[1]} : def.clone();
  }

  private static AnimationData animation(Map<String, Object> x) {
    AnimationData a = new AnimationData();
    a.id = str(x, "id", "");
    a.name = str(x, "name", "");
    a.duration = num(x, "duration", 0);
    for (Map<String, Object> t : maps(x.get("timelines"))) {
      Timeline tl = new Timeline();
      tl.target = str(t, "target", "");
      tl.id = str(t, "id", "");
      tl.property = str(t, "property", "");
      tl.attachment = str(t, "attachment", null);
      List<Map<String, Object>> keys = maps(t.get("keys"));
      tl.keys = new Key[keys.size()];
      boolean forceStep = tl.target.equals("bone") && tl.property.equals("inherit");
      for (int i = 0; i < keys.size(); i++) {
        Map<String, Object> k = keys.get(i);
        Key key = new Key();
        key.time = num(k, "time", 0);
        Object v = k.get("value");
        if (v instanceof List) {
          List<?> l = (List<?>) v;
          if (tl.target.equals("drawOrder")) {
            String[] ids = new String[l.size()];
            for (int j = 0; j < ids.length; j++) ids[j] = l.get(j) == null ? null : l.get(j).toString();
            v = ids;
          } else v = numsOr(v);
        }
        key.value = v;
        key.curve = forceStep ? Curve.STEPPED : curve(k.get("curve"));
        tl.keys[i] = key;
      }
      a.timelines.add(tl);
    }
    for (Map<String, Object> e : maps(x.get("events"))) {
      AnimationData.EventKey k = new AnimationData.EventKey();
      k.time = num(e, "time", 0);
      k.event = str(e, "event", "");
      k.intValue = optNum(e, "int");
      k.floatValue = optNum(e, "float");
      k.stringValue = str(e, "string", null);
      a.events.add(k);
    }
    for (Map<String, Object> e : maps(x.get("audio"))) {
      AnimationData.AudioKey k = new AnimationData.AudioKey();
      k.time = num(e, "time", 0);
      k.sound = str(e, "sound", "");
      k.volume = optNum(e, "volume");
      k.rate = optNum(e, "rate");
      k.loop = e.get("loop") instanceof Boolean ? (Boolean) e.get("loop") : null;
      a.audio.add(k);
    }
    return a;
  }

  private static Curve curve(Object c) {
    if ("stepped".equals(c)) return Curve.STEPPED;
    if (c instanceof List) {
      double[] b = numsOr(c);
      if (b.length >= 4) return Curve.bezier(b[0], b[1], b[2], b[3]);
    }
    return Curve.LINEAR;
  }

  private static StateMachineData stateMachine(Map<String, Object> x) {
    StateMachineData sm = new StateMachineData();
    sm.id = str(x, "id", "");
    sm.name = str(x, "name", "");
    for (Map<String, Object> i : maps(x.get("inputs"))) {
      StateMachineData.Input in = new StateMachineData.Input();
      in.id = str(i, "id", "");
      in.name = str(i, "name", "");
      in.type = str(i, "type", "number");
      in.defaultValue = i.get("default");
      sm.inputs.add(in);
    }
    for (Map<String, Object> b : maps(x.get("bindings"))) {
      StateMachineData.Binding bi = new StateMachineData.Binding();
      bi.id = str(b, "id", "");
      bi.input = str(b, "input", "");
      bi.target = str(b, "target", "");
      bi.object = str(b, "object", "");
      bi.property = str(b, "property", "");
      bi.inMin = num(b, "inMin", 0);
      bi.inMax = num(b, "inMax", 0);
      bi.outMin = b.get("outMin");
      bi.outMax = b.get("outMax");
      sm.bindings.add(bi);
    }
    for (Map<String, Object> l : maps(x.get("layers"))) {
      StateMachineData.Layer layer = new StateMachineData.Layer();
      layer.id = str(l, "id", "");
      layer.name = str(l, "name", "");
      layer.entry = str(l, "entry", null);
      for (Map<String, Object> s : maps(l.get("states"))) {
        StateMachineData.State st = new StateMachineData.State();
        st.id = str(s, "id", "");
        st.name = str(s, "name", "");
        st.type = str(s, "type", "animation");
        st.animation = str(s, "animation", null);
        st.loop = bool(s, "loop", false);
        st.speed = num(s, "speed", 1);
        st.blendInput = str(s, "blendInput", null);
        for (Map<String, Object> e : maps(s.get("blend"))) {
          StateMachineData.BlendEntry be = new StateMachineData.BlendEntry();
          be.animation = str(e, "animation", "");
          be.value = num(e, "value", 0);
          st.blend.add(be);
        }
        st.scripts.addAll(strs(s.get("scripts")));
        for (Map<String, Object> e : maps(s.get("sounds"))) {
          StateMachineData.Sound so = new StateMachineData.Sound();
          so.sound = str(e, "sound", "");
          so.on = str(e, "on", "enter");
          so.action = str(e, "action", "play");
          so.volume = optNum(e, "volume");
          st.sounds.add(so);
        }
        for (Map<String, Object> e : maps(s.get("emitters"))) {
          StateMachineData.Emitter em = new StateMachineData.Emitter();
          em.slot = str(e, "slot", "");
          em.emitting = bool(e, "emitting", false);
          st.emitters.add(em);
        }
        for (Map<String, Object> e : maps(s.get("inputs"))) {
          StateMachineData.StateInput si = new StateMachineData.StateInput();
          si.input = str(e, "input", "");
          si.value = e.get("value");
          st.inputs.add(si);
        }
        st.onComplete = str(s, "onComplete", null);
        layer.states.add(st);
      }
      for (Map<String, Object> t : maps(l.get("transitions"))) {
        StateMachineData.Transition tr = new StateMachineData.Transition();
        tr.id = str(t, "id", "");
        tr.from = str(t, "from", "");
        tr.to = str(t, "to", "");
        for (Map<String, Object> c : maps(t.get("conditions"))) {
          StateMachineData.Condition co = new StateMachineData.Condition();
          co.input = str(c, "input", "");
          co.op = str(c, "op", "==");
          co.value = c.get("value");
          tr.conditions.add(co);
        }
        tr.duration = num(t, "duration", 0);
        tr.exitTime = optNum(t, "exitTime");
        layer.transitions.add(tr);
      }
      sm.layers.add(layer);
    }
    for (Map<String, Object> l : maps(x.get("listeners"))) {
      StateMachineData.Listener li = new StateMachineData.Listener();
      li.id = str(l, "id", "");
      li.name = str(l, "name", "");
      li.slot = str(l, "slot", null);
      li.event = str(l, "event", "click");
      for (Map<String, Object> a : maps(l.get("actions"))) {
        StateMachineData.Action ac = new StateMachineData.Action();
        ac.type = str(a, "type", "");
        ac.input = str(a, "input", null);
        ac.event = str(a, "event", null);
        ac.script = str(a, "script", null);
        ac.fn = str(a, "fn", null);
        ac.sound = str(a, "sound", null);
        ac.slot = str(a, "slot", null);
        ac.value = a.get("value");
        ac.volume = optNum(a, "volume");
        ac.fade = optNum(a, "fade");
        ac.emitting = bool(a, "emitting", false);
        ac.count = num(a, "count", 0);
        li.actions.add(ac);
      }
      sm.listeners.add(li);
    }
    sm.scripts.addAll(strs(x.get("scripts")));
    return sm;
  }

  private static AudioData audio(Map<String, Object> m) {
    AudioData a = new AudioData();
    a.master = num(m, "master", 1);
    a.muted = bool(m, "muted", false);
    for (Map<String, Object> x : maps(m.get("assets"))) {
      AudioData.Asset as = new AudioData.Asset();
      as.id = str(x, "id", "");
      as.name = str(x, "name", "");
      as.src = str(x, "src", "");
      as.duration = num(x, "duration", 0);
      a.assets.add(as);
    }
    for (Map<String, Object> x : maps(m.get("buses"))) {
      AudioData.Bus b = new AudioData.Bus();
      b.id = str(x, "id", "");
      b.name = str(x, "name", "");
      b.volume = num(x, "volume", 1);
      b.muted = bool(x, "muted", false);
      a.buses.add(b);
    }
    for (Map<String, Object> x : maps(m.get("sounds"))) {
      SoundData s = new SoundData();
      s.id = str(x, "id", "");
      s.name = str(x, "name", "");
      s.asset = str(x, "asset", "");
      s.bus = str(x, "bus", null);
      s.volume = num(x, "volume", 1);
      s.rate = num(x, "rate", 1);
      s.loop = bool(x, "loop", false);
      s.fadeIn = num(x, "fadeIn", 0);
      s.fadeOut = num(x, "fadeOut", 0);
      a.sounds.add(s);
    }
    return a;
  }

  // ---------------- Binary (.obonb) ----------------

  private static final byte[] MAGIC = {0x4f, 0x42, 0x4e, 0x42};

  public static boolean isBinary(byte[] b) {
    return b.length >= 5 && b[0] == MAGIC[0] && b[1] == MAGIC[1] && b[2] == MAGIC[2] && b[3] == MAGIC[3];
  }

  /** Decode .obonb bytes (core/binary.ts): float32 values are rounded to 7 significant digits. */
  public static OpenBoneDocument fromBinary(byte[] bytes) {
    if (!isBinary(bytes)) throw new IllegalArgumentException("Not an OpenBone binary document (missing OBNB header)");
    int version = bytes[4] & 0xff;
    if (version > 1) throw new IllegalArgumentException("Binary version " + version + " is newer than supported 1");
    BinReader r = new BinReader(bytes);
    long count = r.varint();
    String[] strings = new String[(int) count];
    for (int i = 0; i < count; i++) {
      int n = (int) r.varint();
      if (r.p + n > bytes.length) throw r.fail();
      strings[i] = new String(bytes, r.p, n, StandardCharsets.UTF_8);
      r.p += n;
    }
    r.strings = strings;
    return fromTree(r.value());
  }

  private static final class BinReader {
    final byte[] b;
    int p = 5;
    String[] strings;

    BinReader(byte[] b) {
      this.b = b;
    }

    RuntimeException fail() {
      return new IllegalArgumentException("Corrupt OpenBone binary document");
    }

    long varint() {
      long n = 0;
      double mul = 1;
      for (;;) {
        if (p >= b.length) throw fail();
        int x = b[p++] & 0xff;
        n += (long) ((x & 0x7f) * mul);
        if (x < 0x80) return n;
        mul *= 0x80;
        if (mul > Math.pow(2, 56)) throw fail();
      }
    }

    String str() {
      long i = varint();
      if (i >= strings.length) throw fail();
      return strings[(int) i];
    }

    Object value() {
      if (p >= b.length) throw fail();
      int tag = b[p++] & 0xff;
      switch (tag) {
        case 0: return null;
        case 1: return Boolean.FALSE;
        case 2: return Boolean.TRUE;
        case 3: return (double) varint();
        case 4: return (double) (-varint() - 1);
        case 5: {
          if (p + 4 > b.length) throw fail();
          int bits = (b[p] & 0xff) | (b[p + 1] & 0xff) << 8 | (b[p + 2] & 0xff) << 16 | (b[p + 3] & 0xff) << 24;
          p += 4;
          return JsNum.roundPrecision(Float.intBitsToFloat(bits), 7);
        }
        case 6: {
          if (p + 8 > b.length) throw fail();
          long bits = 0;
          for (int i = 7; i >= 0; i--) bits = (bits << 8) | (b[p + i] & 0xff);
          p += 8;
          return Double.longBitsToDouble(bits);
        }
        case 7: return str();
        case 8: {
          int n = (int) varint();
          List<Object> a = new ArrayList<>(n);
          for (int i = 0; i < n; i++) a.add(value());
          return a;
        }
        case 9: {
          int n = (int) varint();
          Map<String, Object> o = new LinkedHashMap<>();
          for (int i = 0; i < n; i++) {
            String k = str();
            o.put(k, value());
          }
          return o;
        }
        case 10: {
          String mime = str();
          int n = (int) varint();
          if (p + n > b.length) throw fail();
          byte[] data = new byte[n];
          System.arraycopy(b, p, data, 0, n);
          p += n;
          return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(data);
        }
        default: throw fail();
      }
    }
  }

  // ---------------- Tree helpers ----------------

  @SuppressWarnings("unchecked")
  static Map<String, Object> map(Object v) {
    return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  static List<Map<String, Object>> maps(Object v) {
    List<Map<String, Object>> out = new ArrayList<>();
    if (v instanceof List) for (Object o : (List<Object>) v) if (o instanceof Map) out.add((Map<String, Object>) o);
    return out;
  }

  static List<String> strs(Object v) {
    List<String> out = new ArrayList<>();
    if (v instanceof List) for (Object o : (List<?>) v) if (o != null) out.add(o.toString());
    return out;
  }

  static double[] nums(Object v) {
    if (!(v instanceof List)) return null;
    List<?> l = (List<?>) v;
    double[] out = new double[l.size()];
    for (int i = 0; i < out.length; i++) out[i] = l.get(i) instanceof Number ? ((Number) l.get(i)).doubleValue() : Double.NaN;
    return out;
  }

  static double[] numsOr(Object v) {
    double[] r = nums(v);
    return r == null ? new double[0] : r;
  }

  static double num(Map<String, Object> m, String k, double def) {
    Object v = m.get(k);
    return v instanceof Number ? ((Number) v).doubleValue() : def;
  }

  static Double optNum(Map<String, Object> m, String k) {
    Object v = m.get(k);
    return v instanceof Number ? ((Number) v).doubleValue() : null;
  }

  static String str(Map<String, Object> m, String k, String def) {
    Object v = m.get(k);
    return v instanceof String ? (String) v : def;
  }

  static boolean bool(Map<String, Object> m, String k, boolean def) {
    Object v = m.get(k);
    return v instanceof Boolean ? (Boolean) v : def;
  }
}
