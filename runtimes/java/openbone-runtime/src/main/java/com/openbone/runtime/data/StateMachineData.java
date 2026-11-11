package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

/** A Rive-style state machine: inputs, layers of states and transitions, pointer listeners, bindings and scripts. */
public class StateMachineData {
  public String id, name;
  public final List<Input> inputs = new ArrayList<>();
  public final List<Binding> bindings = new ArrayList<>();
  public final List<Layer> layers = new ArrayList<>();
  public final List<Listener> listeners = new ArrayList<>();
  public final List<String> scripts = new ArrayList<>();

  public static final String ANY_STATE = "@any";

  public static class Input {
    public String id, name;
    /** "bool", "number", "trigger" or "string". */
    public String type;
    /** Double, Boolean or String; null if absent. */
    public Object defaultValue;
    /** Bool inputs: the input owns a bus's mute (true mutes it); {@link #mutes} null = the master. */
    public boolean ownsMute;
    /** The bus id this input mutes (null with {@link #ownsMute} = every sound). */
    public String mutes;
  }

  public static class Binding {
    public String id, input, target, object, property;
    public double inMin, inMax;
    /** Double or hex String. */
    public Object outMin, outMax;
  }

  public static class Layer {
    public String id, name, entry;
    public final List<State> states = new ArrayList<>();
    public final List<Transition> transitions = new ArrayList<>();
  }

  public static class State {
    public String id, name;
    /** "animation", "blend1d" or "exit". */
    public String type = "animation";
    public String animation, blendInput, onComplete;
    public boolean loop = true;
    public double speed = 1;
    public final List<BlendEntry> blend = new ArrayList<>();
    public final List<String> scripts = new ArrayList<>();
    public final List<Sound> sounds = new ArrayList<>();
    public final List<Emitter> emitters = new ArrayList<>();
    public final List<StateInput> inputs = new ArrayList<>();
  }

  public static class BlendEntry {
    public String animation;
    public double value;
  }

  public static class Sound {
    public String sound;
    /** "enter" or "exit". */
    public String on;
    /** "play" or "stop". */
    public String action;
    public Double volume;
  }

  public static class Emitter {
    public String slot;
    public boolean emitting;
  }

  public static class StateInput {
    public String input;
    public Object value;
  }

  public static class Transition {
    public String id, from, to;
    public final List<Condition> conditions = new ArrayList<>();
    public double duration;
    /** Null when absent. */
    public Double exitTime;
  }

  public static class Condition {
    public String input, op;
    public Object value;
  }

  public static class Listener {
    public String id, name, slot;
    /** "down", "up", "enter", "exit", "move" or "click". */
    public String event;
    public final List<Action> actions = new ArrayList<>();
  }

  /** A listener action; which fields are set depends on {@link #type}. */
  public static class Action {
    public String type, input, event, script, fn, sound, slot;
    public Object value;
    public Double volume, fade;
    public boolean emitting;
    public double count;
    /** setMute: the bus id (null = the master). */
    public String bus;
    /** setMute: true / false, or null to toggle. */
    public Boolean muted;
  }
}
