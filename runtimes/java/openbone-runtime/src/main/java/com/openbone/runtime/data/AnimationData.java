package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class AnimationData {
  public String id, name;
  public double duration;
  public final List<Timeline> timelines = new ArrayList<>();
  public final List<EventKey> events = new ArrayList<>();
  public final List<AudioKey> audio = new ArrayList<>();

  /** Explicit duration if > 0, else the last key time of any timeline, event or audio key. */
  public double duration() {
    if (duration > 0) return duration;
    double t = 0;
    for (Timeline tl : timelines) for (Key k : tl.keys) t = Math.max(t, k.time);
    for (EventKey e : events) t = Math.max(t, e.time);
    for (AudioKey k : audio) t = Math.max(t, k.time);
    return t;
  }

  public static class EventKey {
    public double time;
    public String event;
    /** Payload overrides, or null to use the event's. */
    public Double intValue, floatValue;
    public String stringValue;
  }

  public static class AudioKey {
    public double time;
    public String sound;
    public Double volume, rate;
    public Boolean loop;
  }
}
