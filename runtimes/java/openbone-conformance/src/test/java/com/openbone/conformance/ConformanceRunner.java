package com.openbone.conformance;

import com.openbone.runtime.AudioCommand;
import com.openbone.runtime.DrawItem;
import com.openbone.runtime.FiredEvent;
import com.openbone.runtime.Json;
import com.openbone.runtime.OpenBoneInstance;
import com.openbone.runtime.ScriptHost;
import com.openbone.runtime.Skeleton;
import com.openbone.runtime.Slot;
import com.openbone.runtime.StateMachineInstance;
import com.openbone.runtime.Bone;
import com.openbone.runtime.data.OpenBoneDocument;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs one case of conformance/expected/*.json exactly like conformance/generate.ts and compares every sample with the
 * tolerances in conformance/README.md.
 */
public final class ConformanceRunner {
  static final double DT = 1.0 / 60;
  static final int SAMPLE_EVERY = 10;

  static final double TOL_XY = 1e-3, TOL_ABCD = 1e-4, TOL_COLOR = 1.0 / 255, TOL_VERT = 1e-3, TOL_PARTICLE = 1e-2, TOL_NUM = 1e-4;
  /** Slack for comparing two 4-decimal values. */
  static final double EPS = 1e-7;

  static double r4(double n) {
    double v = Math.floor(n * 1e4 + 0.5) / 1e4;
    double r = Math.floor(n * 1e4);
    v = (n * 1e4 - r >= 0.5 ? r + 1 : r) / 1e4;
    return v == 0 ? 0 : v;
  }

  /** Records events and audio commands between samples (play ids renumbered p1, p2…). */
  static final class Recorder implements OpenBoneInstance.Listener {
    final List<FiredEvent> events = new ArrayList<>();
    final List<Map<String, Object>> audio = new ArrayList<>();
    final Map<String, String> ids = new HashMap<>();

    @Override
    public void event(FiredEvent e) {
      events.add(e);
    }

    @Override
    public void audio(AudioCommand c) {
      String id = ids.get(c.id);
      if (id == null) ids.put(c.id, id = "p" + (ids.size() + 1));
      Map<String, Object> m = c.toMap();
      m.put("id", id);
      audio.add(m);
    }
  }

  private final OpenBoneDocument doc;
  private final ScriptHost host;
  private final String file;

  ConformanceRunner(String file, OpenBoneDocument doc, ScriptHost host) {
    this.file = file;
    this.doc = doc;
    this.host = host;
  }

  @SuppressWarnings("unchecked")
  void runCase(Map<String, Object> c) {
    String kind = (String) c.get("kind");
    String name = (String) c.get("name");
    List<Object> samples = (List<Object>) c.get("samples");
    double duration = ((Number) c.get("duration")).doubleValue();
    int steps = (int) Math.round(duration / DT);
    OpenBoneInstance inst = new OpenBoneInstance(doc, host);
    List<String> errors = new ArrayList<>();
    StateMachineInstance machine = null;
    List<Map<String, Object>> actions = new ArrayList<>();
    if (kind.equals("stateMachine")) {
      machine = inst.useStateMachine((String) c.get("stateMachine"));
      for (Object a : (List<Object>) c.get("actions")) actions.add((Map<String, Object>) a);
      final StateMachineInstance m = machine;
      machine.addListener(new StateMachineInstance.EventListener() {
        @Override
        public void error(Throwable e) {
          errors.add(String.valueOf(e));
        }
      });
    } else {
      inst.skeleton.setSkin((String) c.get("skin"));
      if (kind.equals("animation")) inst.play((String) c.get("animation"), true);
    }
    Recorder rec = new Recorder();
    inst.addListener(rec);
    int si = 0;
    inst.advance(0);
    compare(name, 0, inst, rec, (Map<String, Object>) samples.get(si++));
    for (int i = 1; i <= steps; i++) {
      double t = (i - 1) * DT;
      for (Map<String, Object> a : actions) {
        if (Math.abs(((Number) a.get("t")).doubleValue() - t) > DT / 2) continue;
        if (a.containsKey("fire")) machine.fire((String) a.get("fire"));
        else if (a.containsKey("input")) machine.setInput((String) a.get("input"), a.get("value"));
        else inst.pointer((String) a.get("pointer"), ((Number) a.get("x")).doubleValue(), ((Number) a.get("y")).doubleValue());
      }
      inst.advance(DT);
      if (i % SAMPLE_EVERY == 0) compare(name, i * DT, inst, rec, (Map<String, Object>) samples.get(si++));
    }
    inst.dispose();
    if (si != samples.size()) throw new AssertionError(file + " " + name + ": produced " + si + " samples, expected " + samples.size());
    if (!errors.isEmpty()) throw new AssertionError(file + " " + name + ": script errors " + errors);
  }

  @SuppressWarnings("unchecked")
  private void compare(String caseName, double t, OpenBoneInstance inst, Recorder rec, Map<String, Object> exp) {
    String where = file + " " + caseName + " t=" + r4(t);
    num(where + " t", r4(t), exp.get("t"), 1e-9);
    Skeleton sk = inst.skeleton;
    List<Object> bones = (List<Object>) exp.get("bones");
    eq(where + " bone count", sk.bones.size(), bones.size());
    for (int i = 0; i < bones.size(); i++) {
      Bone b = sk.bones.get(i);
      List<Object> e = (List<Object>) bones.get(i);
      double[] w = {b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y};
      for (int k = 0; k < 6; k++) num(where + " bone " + b.data.name + "[" + "abcdxy".charAt(k) + "]", w[k], e.get(k), k < 4 ? TOL_ABCD : TOL_XY);
    }
    List<Object> slots = (List<Object>) exp.get("slots");
    eq(where + " slot count", sk.slots.size(), slots.size());
    for (int i = 0; i < slots.size(); i++) {
      Slot s = sk.slots.get(i);
      List<Object> e = (List<Object>) slots.get(i);
      String w = where + " slot " + s.data.name;
      eq(w + " attachment", s.attachmentName, e.get(0));
      nums(w + " color", s.color, (List<Object>) e.get(1), TOL_COLOR, 4);
      if (e.get(2) == null) eq(w + " dark", s.dark == null ? null : "set", null);
      else {
        if (s.dark == null) throw new AssertionError(w + " dark: expected " + e.get(2) + " got null");
        nums(w + " dark", s.dark, (List<Object>) e.get(2), TOL_COLOR, 3);
      }
    }
    List<DrawItem> draw = sk.drawList();
    List<Object> ed = (List<Object>) exp.get("draw");
    if (draw.size() != ed.size()) {
      List<String> got = new ArrayList<>(), want = new ArrayList<>();
      for (DrawItem d : draw) got.add(d.slot.data.name + ":" + d.attachment.name);
      for (Object o : ed) want.add(((Map<String, Object>) o).get("slot") + ":" + ((Map<String, Object>) o).get("attachment"));
      throw new AssertionError(where + " draw list: got " + got + " expected " + want);
    }
    List<DrawItem.ClipRegion> clips = new ArrayList<>();
    for (int i = 0; i < draw.size(); i++) {
      DrawItem d = draw.get(i);
      Map<String, Object> e = (Map<String, Object>) ed.get(i);
      String w = where + " draw[" + i + "] " + d.slot.data.name + "/" + d.attachment.name;
      eq(w + " slot", d.slot.data.name, e.get("slot"));
      eq(w + " attachment", d.attachment.name, e.get("attachment"));
      eq(w + " type", d.kind(), e.get("type"));
      eq(w + " blend", d.blend, e.get("blend"));
      eq(w + " texture", d.texture == null ? null : d.texture.id, e.get("texture"));
      boolean particles = d.particleLook != null;
      nums(w + " vertices", d.vertices, (List<Object>) e.get("vertices"), particles ? TOL_PARTICLE : TOL_VERT, -1);
      nums(w + " uvs", d.uvs, (List<Object>) e.get("uvs"), TOL_VERT, -1);
      List<Object> ei = (List<Object>) e.get("indices");
      eq(w + " index count", d.indices.length, ei.size());
      for (int k = 0; k < ei.size(); k++) if (d.indices[k] != ((Number) ei.get(k)).intValue()) throw new AssertionError(w + " indices: got " + java.util.Arrays.toString(d.indices) + " expected " + ei);
      nums(w + " color", d.color, (List<Object>) e.get("color"), TOL_COLOR, 4);
      if (e.containsKey("dark") != (d.dark != null)) throw new AssertionError(w + " dark presence: got " + (d.dark != null) + " expected " + e.containsKey("dark"));
      if (d.dark != null) nums(w + " dark", d.dark, (List<Object>) e.get("dark"), TOL_COLOR, 3);
      if (e.containsKey("colors") != (d.colors != null)) throw new AssertionError(w + " colors presence");
      if (d.colors != null) nums(w + " colors", d.colors, (List<Object>) e.get("colors"), TOL_COLOR, -1);
      Integer clip = null;
      if (d.clip != null) {
        if (!clips.contains(d.clip)) clips.add(d.clip);
        clip = clips.indexOf(d.clip);
      }
      Object ec = e.get("clip");
      eq(w + " clip", clip, ec == null ? null : ((Number) ec).intValue());
      eq(w + " text", d.text == null ? null : d.text.content, e.get("text"));
    }
    List<Object> ee = (List<Object>) exp.get("events");
    if (ee.size() != rec.events.size()) throw new AssertionError(where + " events: got " + rec.events + " expected " + ee);
    for (int i = 0; i < ee.size(); i++) {
      Map<String, Object> e = (Map<String, Object>) ee.get(i);
      FiredEvent f = rec.events.get(i);
      String w = where + " event[" + i + "] " + f.name;
      eq(w + " name", f.name, e.get("name"));
      num(w + " time", r4(f.time), e.get("time"), TOL_NUM);
      num(w + " int", f.intValue, e.get("int"), 0);
      num(w + " float", f.floatValue, e.get("float"), TOL_NUM);
      eq(w + " string", f.stringValue, e.get("string"));
    }
    List<Object> ea = (List<Object>) exp.get("audio");
    if (ea.size() != rec.audio.size()) throw new AssertionError(where + " audio: got " + rec.audio + " expected " + ea);
    for (int i = 0; i < ea.size(); i++) {
      Map<String, Object> e = (Map<String, Object>) ea.get(i);
      Map<String, Object> g = rec.audio.get(i);
      String w = where + " audio[" + i + "]";
      if (!e.keySet().equals(g.keySet())) throw new AssertionError(w + " keys: got " + g + " expected " + e);
      for (String k : e.keySet()) {
        Object ev = e.get(k), gv = g.get(k);
        if (ev instanceof Number) num(w + " " + k, ((Number) gv).doubleValue(), ev, TOL_NUM);
        else eq(w + " " + k, gv, ev);
      }
    }
    if (exp.containsKey("states")) {
      Map<String, Object> es = (Map<String, Object>) exp.get("states");
      Map<String, String> got = inst.stateMachine.activeStates();
      if (!new LinkedHashMap<String, Object>(got).equals(es)) throw new AssertionError(where + " states: got " + got + " expected " + es);
    }
    rec.events.clear();
    rec.audio.clear();
  }

  private static void eq(String what, Object got, Object want) {
    boolean same = got == null ? want == null : got.equals(want);
    if (!same && got instanceof Number && want instanceof Number) same = ((Number) got).doubleValue() == ((Number) want).doubleValue();
    if (!same) throw new AssertionError(what + ": got " + got + " expected " + want);
  }

  private static void num(String what, double got, Object want, double tol) {
    double w = ((Number) want).doubleValue();
    double g = r4(got);
    if (!(Math.abs(g - w) <= tol + EPS)) throw new AssertionError(what + ": got " + got + " expected " + w + " (tolerance " + tol + ")");
  }

  /** Compare the first n values (n = -1: all, lengths must match). */
  private static void nums(String what, double[] got, List<Object> want, double tol, int n) {
    if (n < 0) {
      if (got.length != want.size()) throw new AssertionError(what + ": got " + got.length + " values, expected " + want.size() + " " + Json.stringify(want));
      n = got.length;
    }
    for (int i = 0; i < n; i++) {
      double w = ((Number) want.get(i)).doubleValue();
      double g = r4(got[i]);
      if (!(Math.abs(g - w) <= tol + EPS))
        throw new AssertionError(what + "[" + i + "]: got " + got[i] + " expected " + w + " (tolerance " + tol + ")\n  got " + Json.stringify(got) + "\n  exp " + Json.stringify(want));
    }
  }
}
