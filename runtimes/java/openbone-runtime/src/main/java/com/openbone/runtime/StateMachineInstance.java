package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import com.openbone.runtime.data.EventData;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.runtime.data.ScriptData;
import com.openbone.runtime.data.StateMachineData;
import com.openbone.runtime.data.StateMachineData.Action;
import com.openbone.runtime.data.StateMachineData.Binding;
import com.openbone.runtime.data.StateMachineData.Condition;
import com.openbone.runtime.data.StateMachineData.Input;
import com.openbone.runtime.data.StateMachineData.Layer;
import com.openbone.runtime.data.StateMachineData.Listener;
import com.openbone.runtime.data.StateMachineData.State;
import com.openbone.runtime.data.StateMachineData.Transition;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs a Rive-style state machine over a skeleton: inputs, layered states with cross-fades, pointer listeners, events,
 * bindings and scripts (runtime/state-machine.ts, docs/runtime-spec.md §9).
 */
public final class StateMachineInstance {
  /** Receives state machine events. */
  public interface EventListener {
    default void event(FiredEvent e) {}

    default void stateChange(String layer, String from, String to) {}

    default void inputChange(String name, Object value) {}

    default void log(List<Object> args) {}

    default void error(Throwable error) {}

    default void audio(AudioCommand c) {}
  }

  private static final AtomicInteger STATE_COUNTER = new AtomicInteger();
  private static final double ON_COMPLETE_MIX = 0.1;

  private static final class StateInstance {
    final String uid = "state_" + STATE_COUNTER.incrementAndGet();
    final State data;
    double time, prevTime = -1e-6;
    final List<ScriptHandle> scripts = new ArrayList<>();

    StateInstance(State data) {
      this.data = data;
    }
  }

  private static final class LayerInstance {
    final Layer data;
    StateInstance current, from;
    double mixTime, mixDuration;
    boolean exited;

    LayerInstance(Layer data) {
      this.data = data;
    }
  }

  private static final class PointerEvent {
    final String type;
    final double x, y;

    PointerEvent(String type, double x, double y) {
      this.type = type;
      this.x = x;
      this.y = y;
    }
  }

  public final Skeleton skeleton;
  public final StateMachineData data;
  public final OpenBoneDocument doc;
  /** Input values by input id: Double, Boolean or String (null = undefined). */
  public final Map<String, Object> inputs = new LinkedHashMap<>();
  /** Sounds started by states, audio keys, event audio and listeners. */
  public final AudioDirector audio;
  private final Set<String> fired = new LinkedHashSet<>();
  private final List<LayerInstance> layers = new ArrayList<>();
  private List<PointerEvent> pending = new ArrayList<>();
  private final Set<String> hovered = new HashSet<>(), pressed = new HashSet<>();
  private double pointerX, pointerY;
  private boolean pointerDown;
  private final List<ScriptHandle> scripts = new ArrayList<>();
  private final Map<String, Map<String, Double>> boneOverrides = new LinkedHashMap<>();
  private final Map<String, Map<String, Object>> slotOverrides = new LinkedHashMap<>();
  private final Map<String, Boolean> emitterOverrides = new LinkedHashMap<>();
  private List<FiredEvent> pendingEvents = new ArrayList<>();
  private double elapsed;
  private boolean started;
  private final ScriptHost scriptHost;
  private final Map<String, ScriptHandle> handles = new HashMap<>();
  private final List<EventListener> listeners = new CopyOnWriteArrayList<>();

  public StateMachineInstance(Skeleton skeleton, StateMachineData data, ScriptHost scriptHost) {
    this.skeleton = skeleton;
    this.data = data;
    this.doc = skeleton.doc;
    this.scriptHost = scriptHost;
    audio = new AudioDirector(doc, c -> {
      for (EventListener l : listeners) l.audio(c);
    });
    for (Input i : data.inputs) inputs.put(i.id, i.type.equals("trigger") ? Boolean.FALSE : i.defaultValue);
    for (Layer l : data.layers) layers.add(new LayerInstance(l));
    skeleton.textValues = this::getInput;
  }

  public void addListener(EventListener l) {
    listeners.add(l);
  }

  public void removeListener(EventListener l) {
    listeners.remove(l);
  }

  /** Seconds advanced so far. */
  public double elapsed() {
    return elapsed;
  }

  // ---------------- Inputs ----------------

  private Input input(String ref) {
    for (Input i : data.inputs) if (i.id.equals(ref) || i.name.equals(ref)) return i;
    return null;
  }

  /** Input value by id or name (Double, Boolean or String), or null. */
  public Object getInput(String name) {
    Input i = input(name);
    return i != null ? inputs.get(i.id) : null;
  }

  /** Set an input by id or name (a trigger fires). Strings, bools and numbers are converted like the TypeScript runtime. */
  public void setInput(String name, Object value) {
    Input i = input(name);
    if (i == null) throw new IllegalArgumentException("Input \"" + name + "\" not found");
    if (i.type.equals("trigger")) {
      fire(name);
      return;
    }
    Object v;
    if (i.type.equals("string")) v = JsNum.str(value);
    else if (i.type.equals("bool")) v = value instanceof String ? value.equals("true") : JsNum.truthy(value);
    else {
      double n = JsNum.toNumber(value);
      if (!Double.isFinite(n)) return;
      v = n;
    }
    if (JsNum.strictEquals(inputs.get(i.id), v)) return;
    inputs.put(i.id, v);
    for (EventListener l : listeners) l.inputChange(i.name, v);
  }

  public void setBool(String name, boolean v) {
    setInput(name, v);
  }

  public void setNumber(String name, double v) {
    setInput(name, v);
  }

  public void setString(String name, String v) {
    setInput(name, v);
  }

  /** Show fixed text (or a template) in a slot's text attachment; null restores its own. */
  public void setText(String slot, String text) {
    skeleton.setText(slot, text);
  }

  public void fire(String name) {
    Input i = input(name);
    if (i == null) throw new IllegalArgumentException("Input \"" + name + "\" not found");
    fired.add(i.id);
    for (EventListener l : listeners) l.inputChange(i.name, Boolean.TRUE);
  }

  /** Current state name per layer ("exit" for an exited layer, null for none). */
  public Map<String, String> activeStates() {
    Map<String, String> out = new LinkedHashMap<>();
    for (LayerInstance l : layers) out.put(l.data.name, l.exited ? "exit" : l.current != null ? l.current.data.name : null);
    return out;
  }

  // ---------------- Pointer ----------------

  /** Queue a pointer event ("down", "up" or "move") in skeleton space (y up); processed on the next advance. */
  public void pointer(String type, double x, double y) {
    pending.add(new PointerEvent(type, x, y));
  }

  private void processPointer() {
    List<PointerEvent> evs = pending;
    pending = new ArrayList<>();
    for (PointerEvent p : evs) {
      pointerX = p.x;
      pointerY = p.y;
      pointerDown = p.type.equals("down") || (!p.type.equals("up") && pointerDown);
      for (ScriptHandle s : scripts) {
        Map<String, Object> arg = new LinkedHashMap<>();
        arg.put("type", p.type);
        arg.put("x", p.x);
        arg.put("y", p.y);
        safeCall(s, "onPointer", arg);
      }
      for (Listener li : data.listeners) {
        boolean hit = li.slot != null && !li.slot.isEmpty() ? hit(li.slot, p.x, p.y) : true;
        String key = li.id;
        boolean fire = false;
        switch (li.event) {
          case "move": fire = hit && p.type.equals("move"); break;
          case "down": fire = hit && p.type.equals("down"); break;
          case "up": fire = hit && p.type.equals("up"); break;
          case "click":
            if (p.type.equals("down") && hit) pressed.add(key);
            if (p.type.equals("up")) {
              fire = hit && pressed.contains(key);
              pressed.remove(key);
            }
            break;
          case "enter":
          case "exit": {
            boolean was = hovered.contains(key);
            if (hit && !was) {
              hovered.add(key);
              fire = li.event.equals("enter");
            } else if (!hit && was) {
              hovered.remove(key);
              fire = li.event.equals("exit");
            }
            break;
          }
          default: break;
        }
        if (fire) runActions(li, li.actions);
      }
    }
  }

  private boolean hit(String slotId, double x, double y) {
    Slot slot = skeleton.slotById(slotId);
    return slot != null && skeleton.hitTest(slot, x, y);
  }

  private void runActions(Listener li, List<Action> actions) {
    for (Action a : actions) {
      switch (a.type) {
        case "setInput":
          setInput(a.input, a.value);
          break;
        case "toggleInput":
          setInput(a.input, !JsNum.truthy(inputs.get(a.input)));
          break;
        case "fireTrigger":
          fire(a.input);
          break;
        case "reportEvent": {
          EventData ev = doc.eventById(a.event);
          if (ev != null) {
            if (ev.audio != null && !ev.audio.isEmpty()) {
              AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
              o.volume = ev.volume;
              o.source = "event:" + ev.name;
              audio.play(ev.audio, o);
            }
            pendingEvents.add(new FiredEvent(ev.name, ev.id, elapsed, ev.intValue, ev.floatValue, ev.stringValue, null, null, ""));
          }
          break;
        }
        case "playSound": {
          AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
          o.volume = a.volume;
          o.source = "listener:" + li.name;
          audio.play(a.sound, o);
          break;
        }
        case "stopSound":
          audio.stopSound(a.sound, a.fade);
          break;
        case "runScript": {
          ScriptData script = doc.scriptById(a.script);
          ScriptHandle handle = script != null ? scriptFor(script.id) : null;
          if (handle != null) safeCall(handle, a.fn);
          break;
        }
        case "setEmitter":
          setEmitter(a.slot, a.emitting);
          break;
        case "emitParticles":
          skeleton.emitParticles(a.slot, a.count);
          break;
        default:
          break;
      }
    }
  }

  /** Switch a slot's particle emitter; switching it on restarts its cycle so bursts replay. */
  public void setEmitter(String slotRef, boolean emitting) {
    Slot slot = skeleton.findSlot(slotRef);
    if (slot == null) return;
    emitterOverrides.put(slot.data.id, emitting);
    if (emitting) skeleton.restartEmitter(slot.data.id);
  }

  // ---------------- Scripts ----------------

  private final ScriptApi api = this::apiCall;

  @SuppressWarnings("unchecked")
  private Object apiCall(String method, List<Object> args) {
    Object a0 = args.size() > 0 ? args.get(0) : null;
    Object a1 = args.size() > 1 ? args.get(1) : null;
    switch (method) {
      case "time":
        return elapsed;
      case "input": {
        Object v = getInput(JsNum.str(a0));
        return v != null ? v : Json.Undefined.INSTANCE;
      }
      case "setInput":
        setInput(JsNum.str(a0), a1);
        return Json.Undefined.INSTANCE;
      case "fire":
        fire(JsNum.str(a0));
        return Json.Undefined.INSTANCE;
      case "emit": {
        String name = JsNum.str(a0);
        Map<String, Object> payload = a1 instanceof Map ? (Map<String, Object>) a1 : new HashMap<>();
        EventData ev = null;
        for (EventData e : doc.events)
          if (e.name.equals(name) || e.id.equals(name)) {
            ev = e;
            break;
          }
        if (ev != null && ev.audio != null && !ev.audio.isEmpty()) {
          AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
          o.volume = ev.volume;
          o.source = "event:" + ev.name;
          audio.play(ev.audio, o);
        }
        Object pi = payload.get("int"), pf = payload.get("float"), ps = payload.get("string");
        pendingEvents.add(new FiredEvent(name, ev != null ? ev.id : name, elapsed,
            pi != null ? JsNum.toNumber(pi) : ev != null ? ev.intValue : 0,
            pf != null ? JsNum.toNumber(pf) : ev != null ? ev.floatValue : 0,
            ps != null ? JsNum.str(ps) : ev != null ? ev.stringValue : "", null, null, ""));
        return Json.Undefined.INSTANCE;
      }
      case "bone": {
        Bone b = skeleton.findBone(JsNum.str(a0));
        if (b == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("x", b.x);
        m.put("y", b.y);
        m.put("rotation", b.rotation);
        m.put("scaleX", b.scaleX);
        m.put("scaleY", b.scaleY);
        m.put("worldX", b.world.x);
        m.put("worldY", b.world.y);
        m.put("worldRotation", b.worldRotation());
        return m;
      }
      case "setBone": {
        Bone b = skeleton.findBone(JsNum.str(a0));
        if (b != null && a1 instanceof Map) {
          Map<String, Double> o = boneOverrides.computeIfAbsent(b.data.id, k -> new LinkedHashMap<>());
          for (Map.Entry<String, Object> e : ((Map<String, Object>) a1).entrySet()) o.put(e.getKey(), JsNum.toNumber(e.getValue()));
        }
        return Json.Undefined.INSTANCE;
      }
      case "slot": {
        Slot s = skeleton.findSlot(JsNum.str(a0));
        if (s != null && a1 instanceof Map) slotOverrides.computeIfAbsent(s.data.id, k -> new LinkedHashMap<>()).putAll((Map<String, Object>) a1);
        return Json.Undefined.INSTANCE;
      }
      case "pointer": {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("x", pointerX);
        m.put("y", pointerY);
        m.put("down", pointerDown);
        return m;
      }
      case "log":
        for (EventListener l : listeners) l.log(args);
        return Json.Undefined.INSTANCE;
      default:
        return Json.Undefined.INSTANCE;
    }
  }

  private ScriptHandle scriptFor(String id) {
    if (scriptHost == null) return null;
    ScriptHandle h = handles.get(id);
    if (h == null) {
      ScriptData s = doc.scriptById(id);
      if (s == null) return null;
      try {
        h = scriptHost.load(s, api);
      } catch (Throwable e) {
        error(e);
        return null;
      }
      handles.put(id, h);
    }
    return h;
  }

  private void error(Throwable e) {
    for (EventListener l : listeners) l.error(e);
  }

  private void safeCall(ScriptHandle h, String fn, Object... args) {
    try {
      if (h.has(fn)) h.call(fn, args);
    } catch (Throwable e) {
      error(e);
    }
  }

  private void start() {
    started = true;
    for (String id : data.scripts) {
      ScriptHandle h = scriptFor(id);
      if (h != null) {
        scripts.add(h);
        safeCall(h, "onStart");
      }
    }
    for (LayerInstance l : layers) {
      State entry = null;
      for (State s : l.data.states)
        if (s.id.equals(l.data.entry)) {
          entry = s;
          break;
        }
      if (entry != null) enter(l, entry, 0);
    }
  }

  private void stateSounds(State s, String on, String owner) {
    for (StateMachineData.Sound x : s.sounds) {
      if (!x.on.equals(on)) continue;
      if (x.action.equals("stop")) audio.stopSound(x.sound, null);
      else {
        AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
        o.volume = x.volume;
        o.owner = owner;
        o.tag = owner != null ? "hook:" + x.sound : null;
        o.source = "state:" + s.name;
        audio.play(x.sound, o);
      }
    }
  }

  private void enter(LayerInstance l, State state, double mix) {
    StateInstance prev = l.current;
    if (prev != null) {
      for (ScriptHandle h : prev.scripts) disposeQuietly(h);
      audio.stopOwner(prev.uid, mix, false);
      stateSounds(prev.data, "exit", null);
    }
    if (state.type.equals("exit")) {
      l.exited = true;
      l.from = prev;
      l.current = null;
      l.mixTime = 0;
      l.mixDuration = mix;
    } else {
      StateInstance inst = new StateInstance(state);
      l.from = mix > 0 ? prev : null;
      l.current = inst;
      l.mixTime = 0;
      l.mixDuration = mix;
      l.exited = false;
      stateSounds(state, "enter", inst.uid);
      for (StateMachineData.Emitter e : state.emitters) setEmitter(e.slot, e.emitting);
      for (StateMachineData.StateInput x : state.inputs) if (input(x.input) != null) setInput(x.input, x.value);
      for (String id : state.scripts) {
        ScriptData s = doc.scriptById(id);
        if (s == null || scriptHost == null) continue;
        try {
          ScriptHandle h = scriptHost.load(s, api);
          inst.scripts.add(h);
          safeCall(h, "onStart");
        } catch (Throwable e) {
          error(e);
        }
      }
    }
    String from = prev != null ? prev.data.name : null;
    for (EventListener li : listeners) li.stateChange(l.data.name, from, state.name);
  }

  private static void disposeQuietly(ScriptHandle h) {
    try {
      h.dispose();
    } catch (Throwable ignored) {
      // ignore
    }
  }

  // ---------------- Transitions ----------------

  private boolean conditionPasses(Condition c) {
    Input input = null;
    for (Input i : data.inputs)
      if (i.id.equals(c.input)) {
        input = i;
        break;
      }
    if (input == null) return false;
    if (input.type.equals("trigger")) return fired.contains(input.id);
    Object v = inputs.get(input.id);
    Object want = c.value;
    switch (c.op) {
      case "==":
        if (input.type.equals("string")) return JsNum.str(v).equals(JsNum.str(want));
        return JsNum.strictEquals(v, want) || (v instanceof Double && want instanceof Double && Math.abs((Double) v - (Double) want) < 1e-9);
      case "!=":
        if (input.type.equals("string")) return !JsNum.str(v).equals(JsNum.str(want));
        return !JsNum.strictEquals(v, want);
      case ">": return JsNum.toNumber(v) > JsNum.toNumber(want);
      case "<": return JsNum.toNumber(v) < JsNum.toNumber(want);
      case ">=": return JsNum.toNumber(v) >= JsNum.toNumber(want);
      case "<=": return JsNum.toNumber(v) <= JsNum.toNumber(want);
      default: return false;
    }
  }

  private double progress(StateInstance s) {
    BlendPair pair = blendPair(s.data);
    AnimationData anim = pair != null ? (pair.t >= 0.5 ? pair.hi : pair.lo) : doc.animationById(s.data.animation);
    double d = anim != null ? anim.duration() : 0;
    return d > 0 ? s.time / d : 1;
  }

  private boolean canTake(Transition t, StateInstance s) {
    boolean any = t.from.equals(StateMachineData.ANY_STATE);
    boolean toSelf = s != null && t.to.equals(s.data.id);
    if (!any && toSelf && t.conditions.isEmpty()) return false;
    if (any && toSelf) return false;
    Double exitTime = t.exitTime != null ? t.exitTime : t.conditions.isEmpty() ? Double.valueOf(1) : null;
    if (exitTime != null && s != null && progress(s) < exitTime) return false;
    for (Condition c : t.conditions) if (!conditionPasses(c)) return false;
    return true;
  }

  private Transition evaluate(LayerInstance l) {
    if (l.exited) return null;
    StateInstance cur = l.current;
    List<Transition> candidates = new ArrayList<>();
    for (Transition t : l.data.transitions) if (t.from.equals(StateMachineData.ANY_STATE) || (cur != null && t.from.equals(cur.data.id))) candidates.add(t);
    candidates.sort((a, b) -> Boolean.compare(a.from.equals(StateMachineData.ANY_STATE), b.from.equals(StateMachineData.ANY_STATE)));
    for (Transition t : candidates) {
      if (!canTake(t, cur)) continue;
      State to = stateById(l, t.to);
      if (to == null) continue;
      enter(l, to, t.duration);
      return t;
    }
    String next = cur != null ? cur.data.onComplete : null;
    if (cur != null && next != null && !next.isEmpty() && progress(cur) >= 1) {
      State to = stateById(l, next);
      if (to != null) enter(l, to, ON_COMPLETE_MIX);
    }
    return null;
  }

  private static State stateById(LayerInstance l, String id) {
    for (State s : l.data.states) if (s.id.equals(id)) return s;
    return null;
  }

  private void settle(LayerInstance l) {
    for (int hop = 0; hop < 4; hop++) {
      Transition t = evaluate(l);
      if (t == null) return;
      for (Condition c : t.conditions) fired.remove(c.input);
    }
  }

  // ---------------- Apply ----------------

  private static final class BlendPair {
    AnimationData lo, hi;
    double t;
  }

  private BlendPair blendPair(State d) {
    if (!d.type.equals("blend1d") || d.blend.isEmpty()) return null;
    Object raw = inputs.get(d.blendInput != null ? d.blendInput : "");
    double v = JsNum.toNumber(raw != null ? raw : (Object) 0.0);
    List<StateMachineData.BlendEntry> entries = new ArrayList<>(d.blend);
    entries.sort((a, b) -> {
      double x = a.value - b.value;
      return x < 0 ? -1 : x > 0 ? 1 : 0;
    });
    StateMachineData.BlendEntry lo = entries.get(0), hi = entries.get(0);
    double t = 0;
    if (v >= entries.get(entries.size() - 1).value) lo = hi = entries.get(entries.size() - 1);
    else
      for (int i = 0; i < entries.size() - 1; i++)
        if (v >= entries.get(i).value && v <= entries.get(i + 1).value) {
          lo = entries.get(i);
          hi = entries.get(i + 1);
          double span = hi.value - lo.value;
          t = (v - lo.value) / (span == 0 || Double.isNaN(span) ? 1 : span);
          break;
        }
    BlendPair p = new BlendPair();
    p.lo = doc.animationById(lo.animation);
    p.hi = doc.animationById(hi.animation);
    p.t = t;
    return p;
  }

  /** The animations a state is playing now (a blend state's current pair). */
  private List<AnimationData> stateAnimations(StateInstance s) {
    State d = s.data;
    List<AnimationData> out = new ArrayList<>();
    if (d.type.equals("animation")) {
      AnimationData anim = doc.animationById(d.animation);
      if (anim != null) out.add(anim);
    } else if (d.type.equals("blend1d")) {
      BlendPair pair = blendPair(d);
      if (pair != null) {
        if (pair.lo != null) out.add(pair.lo);
        if (pair.hi != null) out.add(pair.hi);
      }
    }
    return out;
  }

  private void applyState(StateInstance s, double alpha) {
    applyState(s, alpha, null, 0);
  }

  /**
   * Pose a state at weight {@code alpha}. With {@code into} (the state being faded to) and its outgoing weight
   * {@code outAlpha}, the blending values none of {@code into} key are applied at {@code outAlpha} instead (spec §5.1a).
   */
  private void applyState(StateInstance s, double alpha, List<AnimationData> into, double outAlpha) {
    State d = s.data;
    if (d.type.equals("animation")) {
      AnimationData anim = doc.animationById(d.animation);
      if (anim != null) Animations.apply(skeleton, anim, Animations.localTime(anim, s.time, d.loop), alpha, into == null ? null : new MixOut(into, outAlpha));
    } else if (d.type.equals("blend1d")) {
      BlendPair pair = blendPair(d);
      if (pair == null) return;
      if (pair.lo != null) Animations.apply(skeleton, pair.lo, Animations.localTime(pair.lo, s.time, d.loop), alpha, into == null ? null : new MixOut(into, outAlpha));
      if (pair.hi != null && pair.hi != pair.lo && pair.t > 0)
        Animations.apply(skeleton, pair.hi, Animations.localTime(pair.hi, s.time, d.loop), alpha * pair.t, into == null ? null : new MixOut(into, outAlpha * pair.t));
    }
  }

  private void collectEvents(StateInstance s) {
    State d = s.data;
    AnimationData anim = null;
    if (d.type.equals("animation")) anim = doc.animationById(d.animation);
    else if (d.type.equals("blend1d")) {
      BlendPair pair = blendPair(d);
      anim = pair != null ? (pair.t >= 0.5 ? pair.hi : pair.lo) : null;
    }
    if (anim == null) return;
    AudioDirector.playAudioKeys(audio, anim, s.prevTime, s.time, d.loop, s.uid);
    for (FiredEvent ev : Animations.eventsBetween(doc, anim, s.prevTime, s.time, d.loop)) {
      if (ev.audio != null) {
        AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
        o.volume = ev.volume;
        o.owner = s.uid;
        o.source = "event:" + ev.name;
        audio.play(ev.audio, o);
      }
      pendingEvents.add(ev);
    }
  }

  /** Step the machine by dt seconds and pose the skeleton (spec §9.1). */
  public void advance(double dt) {
    if (!started) start();
    elapsed += dt;
    audio.update(dt);
    processPointer();
    for (ScriptHandle s : new ArrayList<>(scripts)) safeCall(s, "onUpdate", dt);
    for (LayerInstance l : layers) if (l.current != null) for (ScriptHandle h : new ArrayList<>(l.current.scripts)) safeCall(h, "onUpdate", dt);

    for (LayerInstance l : layers) settle(l);
    fired.clear();

    for (LayerInstance l : layers) {
      for (StateInstance s : new StateInstance[] {l.current, l.from}) {
        if (s == null) continue;
        s.prevTime = s.time > 0 ? s.time : Math.min(s.prevTime, s.time);
        s.time += dt * s.data.speed;
      }
      if (l.current != null && dt > 0) collectEvents(l.current);
      if (l.from != null) {
        l.mixTime += dt;
        if (l.mixTime >= l.mixDuration) l.from = null;
      }
    }

    Skeleton sk = skeleton;
    sk.setToSetupPose();
    for (LayerInstance l : layers) {
      double mixA = l.mixDuration > 0 ? Math.min(1, l.mixTime / l.mixDuration) : 1;
      if (l.from != null) {
        // Fading to a state: what it doesn't key fades from the old state's value to the pose underneath.
        if (l.current != null) applyState(l.from, 1, stateAnimations(l.current), 1 - mixA);
        else applyState(l.from, l.exited ? 1 - mixA : 1);
      }
      if (l.current != null) applyState(l.current, l.from != null ? mixA : 1);
    }
    for (Map.Entry<String, Map<String, Double>> e : boneOverrides.entrySet()) {
      Bone b = sk.boneById(e.getKey());
      if (b != null) for (Map.Entry<String, Double> p : e.getValue().entrySet()) b.set(p.getKey(), p.getValue());
    }
    for (Map.Entry<String, Map<String, Object>> e : slotOverrides.entrySet()) {
      Slot s = sk.slotById(e.getKey());
      if (s == null) continue;
      Map<String, Object> o = e.getValue();
      Object color = o.get("color");
      if (JsNum.truthy(color)) s.color = MathUtil.parseHex(JsNum.str(color));
      if (o.containsKey("attachment")) {
        Object a = o.get("attachment");
        s.attachmentName = a == null ? null : JsNum.str(a);
      }
    }
    for (Map.Entry<String, Object> e : inputs.entrySet()) if (e.getValue() instanceof Double) sk.inputValues.put(e.getKey(), (Double) e.getValue());
    for (Map.Entry<String, Boolean> e : emitterOverrides.entrySet()) {
      ParticleEmitter.Values cur = sk.particleValues.get(e.getKey());
      ParticleEmitter.Values v = cur != null ? cur.copy() : new ParticleEmitter.Values();
      v.emitting = e.getValue();
      sk.particleValues.put(e.getKey(), v);
    }
    applyBindings();
    sk.update(dt);
    sk.updateWorldTransform();

    List<FiredEvent> evs = pendingEvents;
    pendingEvents = new ArrayList<>();
    for (FiredEvent e : evs) {
      for (EventListener l : listeners) l.event(e);
      Map<String, Object> em = e.toMap();
      for (ScriptHandle h : new ArrayList<>(scripts)) safeCall(h, "onEvent", em);
      for (LayerInstance l : layers) if (l.current != null) for (ScriptHandle h : new ArrayList<>(l.current.scripts)) safeCall(h, "onEvent", em);
    }
  }

  /** Drive bound properties from their inputs (after animations and script overrides). */
  public void applyBindings() {
    Skeleton sk = skeleton;
    for (Binding b : data.bindings) {
      Object raw = inputs.get(b.input);
      if (raw == null) continue;
      double n = JsNum.toNumber(raw);
      if (!Double.isFinite(n)) continue;
      double t = Template.bindingT(n, b.inMin, b.inMax);
      if (b.target.equals("bone")) {
        Bone bone = sk.boneById(b.object);
        if (bone != null) bone.set(b.property, lerpNum(b, t));
      } else if (b.target.equals("slot")) {
        Slot slot = sk.slotById(b.object);
        if (slot == null) continue;
        if (b.property.equals("alpha")) slot.color = new double[] {slot.color[0], slot.color[1], slot.color[2], lerpNum(b, t)};
        else if (b.property.equals("color")) {
          double[] lo = MathUtil.parseHex(JsNum.str(b.outMin)), hi = MathUtil.parseHex(JsNum.str(b.outMax));
          double[] c = new double[4];
          for (int k = 0; k < 4; k++) c[k] = lo[k] + (hi[k] - lo[k]) * t;
          slot.color = c;
        }
      } else {
        Skeleton.ConstraintValues v = sk.constraintValues.get(b.object);
        if (v != null) v.put(b.property, lerpNum(b, t));
      }
    }
  }

  private static double lerpNum(Binding b, double t) {
    double lo = JsNum.toNumber(b.outMin), hi = JsNum.toNumber(b.outMax);
    return lo + (hi - lo) * t;
  }

  /** Clear persistent script overrides. */
  public void clearOverrides() {
    boneOverrides.clear();
    slotOverrides.clear();
  }

  /** Stop every sound and release scripts. */
  public void dispose() {
    audio.stopAll(0);
    for (ScriptHandle h : handles.values()) disposeQuietly(h);
    for (LayerInstance l : layers) if (l.current != null) for (ScriptHandle h : l.current.scripts) disposeQuietly(h);
    handles.clear();
  }
}
