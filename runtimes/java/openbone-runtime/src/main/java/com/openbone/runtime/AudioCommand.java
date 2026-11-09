package com.openbone.runtime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A sound command for an audio backend: {@code play}, {@code stop} or {@code fade}. The runtime never plays audio; it
 * emits these (apply the document's bus and master volumes yourself).
 */
public final class AudioCommand {
  /** "play", "stop" or "fade". */
  public final String type;
  /** Playing instance id; stop/fade refer to the id of an earlier play. */
  public final String id;
  // play
  public String sound, asset, bus, source;
  public double volume, rate, fadeIn;
  public boolean loop;
  // stop
  public double fade;
  // fade (volume above is the target)
  public double duration;

  AudioCommand(String type, String id) {
    this.type = type;
    this.id = id;
  }

  /** Same fields as the TypeScript AudioCommand object. */
  public Map<String, Object> toMap() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("type", type);
    m.put("id", id);
    switch (type) {
      case "play":
        m.put("sound", sound);
        m.put("asset", asset);
        m.put("bus", bus);
        m.put("volume", volume);
        m.put("rate", rate);
        m.put("loop", loop);
        m.put("fadeIn", fadeIn);
        m.put("source", source);
        break;
      case "stop":
        m.put("fade", fade);
        break;
      default:
        m.put("volume", volume);
        m.put("duration", duration);
    }
    return m;
  }

  @Override
  public String toString() {
    return "AudioCommand" + toMap();
  }
}
