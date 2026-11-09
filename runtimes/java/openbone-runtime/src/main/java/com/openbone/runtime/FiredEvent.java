package com.openbone.runtime;

import java.util.LinkedHashMap;
import java.util.Map;

/** An event reported by an animation key, a listener or a script. */
public final class FiredEvent {
  public final String name, id;
  /** Key's local time for animation events; state machine elapsed time for listener and script events. */
  public final double time;
  public final double intValue, floatValue;
  public final String stringValue;
  /** Sound the event plays, or null; and its volume multiplier, or null. */
  public final String audio;
  public final Double volume;
  /** Animation name ("" for listener and script events). */
  public final String animation;

  public FiredEvent(String name, String id, double time, double intValue, double floatValue, String stringValue, String audio, Double volume, String animation) {
    this.name = name;
    this.id = id;
    this.time = time;
    this.intValue = intValue;
    this.floatValue = floatValue;
    this.stringValue = stringValue;
    this.audio = audio;
    this.volume = volume;
    this.animation = animation;
  }

  /** As scripts see it ({@code onEvent(e)}). */
  public Map<String, Object> toMap() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("name", name);
    m.put("id", id);
    m.put("time", time);
    m.put("int", intValue);
    m.put("float", floatValue);
    m.put("string", stringValue);
    if (audio != null) m.put("audio", audio);
    if (volume != null) m.put("volume", volume);
    m.put("animation", animation);
    return m;
  }

  @Override
  public String toString() {
    return "FiredEvent" + toMap();
  }
}
