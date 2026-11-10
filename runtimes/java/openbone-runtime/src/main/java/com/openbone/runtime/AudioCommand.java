package com.openbone.runtime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A sound command for an audio backend: {@code play}, {@code stop}, {@code fade} or {@code mix}. The runtime never
 * plays audio; it emits these. {@link AudioMixer} applies the document's bus and master volumes and fades for an engine's output
 * (the libGDX and Android modules play them through it).
 */
public final class AudioCommand {
  /** "play", "stop", "fade" or "mix". */
  public final String type;
  /** Playing instance id; stop/fade refer to the id of an earlier play. Null for mix. */
  public final String id;
  // play
  public String sound, asset, bus, source;
  public double volume, rate, fadeIn;
  public boolean loop;
  // stop
  public double fade;
  // fade (volume above is the target)
  public double duration;
  // mix: {@code bus} above (null = the master) muted or unmuted by a setMute action
  public boolean muted;

  AudioCommand(String type, String id) {
    this.type = type;
    this.id = id;
  }

  /** A {@code play} command (for driving an {@link AudioMixer} yourself, e.g. in tests). */
  public static AudioCommand play(String id, String asset, String bus, double volume, double rate, boolean loop, double fadeIn) {
    AudioCommand c = new AudioCommand("play", id);
    c.sound = asset;
    c.asset = asset;
    c.bus = bus;
    c.volume = volume;
    c.rate = rate;
    c.loop = loop;
    c.fadeIn = fadeIn;
    c.source = "host";
    return c;
  }

  /** A {@code stop} command with a fade-out in seconds. */
  public static AudioCommand stop(String id, double fade) {
    AudioCommand c = new AudioCommand("stop", id);
    c.fade = fade;
    return c;
  }

  /** A {@code fade} command: the sound's new volume over {@code duration} seconds. */
  public static AudioCommand fade(String id, double volume, double duration) {
    AudioCommand c = new AudioCommand("fade", id);
    c.volume = volume;
    c.duration = duration;
    return c;
  }

  /** A {@code mix} command: mute or unmute a bus (null = the master) on top of the document's mix. */
  public static AudioCommand mix(String bus, boolean muted) {
    AudioCommand c = new AudioCommand("mix", null);
    c.bus = bus;
    c.muted = muted;
    return c;
  }

  /** Same fields as the TypeScript AudioCommand object. */
  public Map<String, Object> toMap() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("type", type);
    if (type.equals("mix")) {
      m.put("bus", bus);
      m.put("muted", muted);
      return m;
    }
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
