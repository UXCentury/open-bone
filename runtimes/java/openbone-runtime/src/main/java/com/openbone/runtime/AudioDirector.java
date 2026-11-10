package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import com.openbone.runtime.data.AudioData;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.runtime.data.SoundData;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/** Tracks what is playing and turns play/stop requests into {@link AudioCommand}s (runtime/audio.ts). */
public final class AudioDirector {
  private static final AtomicInteger COUNTER = new AtomicInteger();
  private static final double UNKNOWN_LENGTH = 10;

  public static final class Playing {
    public final String id;
    public final SoundData sound;
    public final String owner, tag;
    public final boolean loop;
    public double volume;
    public final double startedAt, endsAt;

    Playing(String id, SoundData sound, String owner, String tag, boolean loop, double volume, double startedAt, double endsAt) {
      this.id = id;
      this.sound = sound;
      this.owner = owner;
      this.tag = tag;
      this.loop = loop;
      this.volume = volume;
      this.startedAt = startedAt;
      this.endsAt = endsAt;
    }
  }

  /** Options for {@link #play}; null fields use the sound's settings. */
  public static final class PlayOptions {
    public Double volume, rate;
    public Boolean loop;
    public String owner, tag, source;
  }

  public final Map<String, Playing> playing = new LinkedHashMap<>();
  public double time;
  private final OpenBoneDocument doc;
  private final Consumer<AudioCommand> out;
  /** Mutes set while playing (bus id, "" = master), on top of the document's mix. */
  private final Map<String, Boolean> mutes = new LinkedHashMap<>();

  public AudioDirector(OpenBoneDocument doc, Consumer<AudioCommand> out) {
    this.doc = doc;
    this.out = out;
  }

  public void update(double dt) {
    time += dt;
    playing.values().removeIf(p -> p.endsAt <= time);
  }

  /** Start a sound (id or name; an audio asset plays with defaults). Returns the instance id, or null. */
  public String play(String ref, PlayOptions o) {
    SoundData sound = doc.resolveSound(ref);
    if (sound == null) return null;
    if (o == null) o = new PlayOptions();
    boolean loop = o.loop != null ? o.loop : sound.loop;
    String owner = o.owner, tag = o.tag;
    if (loop && tag != null)
      for (Playing p : playing.values()) if (p.loop && eq(p.owner, owner) && eq(p.tag, tag)) return p.id;
    double rate = o.rate != null ? o.rate : sound.rate;
    double volume = sound.volume * (o.volume != null ? o.volume : 1);
    double len = 0;
    if (doc.audio != null)
      for (AudioData.Asset a : doc.audio.assets)
        if (a.id.equals(sound.asset)) {
          len = a.duration;
          break;
        }
    String id = "play_" + Integer.toString(COUNTER.incrementAndGet(), 36);
    playing.put(id, new Playing(id, sound, owner, tag, loop, volume, time, loop ? Double.POSITIVE_INFINITY : time + (len > 0 ? len / rate : UNKNOWN_LENGTH)));
    AudioCommand c = new AudioCommand("play", id);
    c.sound = sound.id;
    c.asset = sound.asset;
    c.bus = sound.bus;
    c.volume = volume;
    c.rate = rate;
    c.loop = loop;
    c.fadeIn = sound.fadeIn;
    c.source = o.source != null ? o.source : "";
    out.accept(c);
    return id;
  }

  private static boolean eq(String a, String b) {
    return a == null ? b == null : a.equals(b);
  }

  /** Stop one instance (fade null = its sound's fadeOut). */
  public void stop(String id, Double fade) {
    Playing p = playing.remove(id);
    if (p == null) return;
    AudioCommand c = new AudioCommand("stop", id);
    c.fade = fade != null ? fade : p.sound.fadeOut;
    out.accept(c);
  }

  /** Stop every playing instance of a sound. */
  public void stopSound(String ref, Double fade) {
    SoundData s = doc.resolveSound(ref);
    if (s == null) return;
    for (Playing p : new ArrayList<>(playing.values())) if (p.sound.id.equals(s.id)) stop(p.id, fade);
  }

  /** Stop an owner's looping sounds (or all of them), fading at least the sound's fadeOut. */
  public void stopOwner(String owner, double fade, boolean all) {
    for (Playing p : new ArrayList<>(playing.values()))
      if (eq(p.owner, owner) && (all || p.loop)) stop(p.id, Math.max(fade, p.sound.fadeOut));
  }

  /** Ramp an instance to a new volume. */
  public void fade(String id, double volume, double duration) {
    Playing p = playing.get(id);
    if (p == null) return;
    p.volume = volume;
    AudioCommand c = new AudioCommand("fade", id);
    c.volume = volume;
    c.duration = duration;
    out.accept(c);
  }

  public void stopAll(double fade) {
    for (String id : new ArrayList<>(playing.keySet())) stop(id, fade);
  }

  /** Whether a bus (null = the master) is muted now: a setMute override, else the document's flag. */
  public boolean isMuted(String bus) {
    Boolean m = mutes.get(bus != null ? bus : "");
    if (m != null) return m;
    if (doc.audio == null) return false;
    if (bus == null) return doc.audio.muted;
    for (AudioData.Bus b : doc.audio.buses) if (b.id.equals(bus)) return b.muted;
    return false;
  }

  /** Mute, unmute or toggle ({@code muted} null) a bus (null = the master); emits a {@code mix} command. Returns the new state. */
  public boolean setMute(String bus, Boolean muted) {
    boolean next = muted != null ? muted : !isMuted(bus);
    mutes.put(bus != null ? bus : "", next);
    out.accept(AudioCommand.mix(bus, next));
    return next;
  }

  /** Audio keys crossed from total time prev (exclusive) to next (inclusive), with their key index. */
  public static List<int[]> audioKeysBetween(AnimationData anim, double prev, double next, boolean loop) {
    List<int[]> out = new ArrayList<>();
    List<AnimationData.AudioKey> keys = anim.audio;
    if (keys.isEmpty() || next <= prev) return out;
    double d = anim.duration();
    for (int index = 0; index < keys.size(); index++) {
      AnimationData.AudioKey key = keys.get(index);
      if (!loop || d <= 0) {
        if (key.time > prev && key.time <= next) out.add(new int[] {index});
        continue;
      }
      for (double c = Math.floor(prev / d); c <= Math.floor(next / d); c++) {
        double at = c * d + key.time;
        if (at > prev && at <= next) out.add(new int[] {index});
      }
    }
    return out;
  }

  /** Start the audio keys an animation crossed, owned by {@code owner}. */
  public static void playAudioKeys(AudioDirector dir, AnimationData anim, double prev, double next, boolean loop, String owner) {
    for (int[] k : audioKeysBetween(anim, prev, next, loop)) {
      AnimationData.AudioKey key = anim.audio.get(k[0]);
      PlayOptions o = new PlayOptions();
      o.volume = key.volume;
      o.rate = key.rate;
      o.loop = key.loop;
      o.owner = owner;
      o.tag = anim.id + "#" + k[0];
      o.source = "key:" + anim.name;
      dir.play(key.sound, o);
    }
  }
}
