package com.openbone.runtime;

import com.openbone.runtime.data.AudioData;
import com.openbone.runtime.data.OpenBoneDocument;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The engine-neutral half of sound playback: turns {@link AudioCommand}s into calls on an {@link Output} that makes
 * the noise (libGDX {@code Sound}, Android {@code SoundPool}, …), with the document's bus and master gain, voice
 * bookkeeping and fades stepped in {@link #update(double)} (call it every frame with real seconds).
 *
 * <p>The gain of a voice is {@code command volume × bus volume (0 if muted) × master (0 if muted) × volume}. A bus or the
 * master is muted by the last {@code mix} command for it (a setMute action, e.g. a mute button), else by the document;
 * a mix applies to the playing voices at once and to later sounds. A {@code fade} command gives the sound's new volume; the voice keeps its bus and master gain. One-shots are
 * released after the asset's duration (÷ rate, plus a quarter second), or when the output reports {@link #voiceFinished(int)}.
 *
 * <p>Not thread-safe: use it from the thread that advances the instance.
 */
public final class AudioMixer {
  /** What plays the voices. Voice numbers are chosen by the mixer. */
  public interface Output {
    /** Start {@code asset} as voice {@code voice} at linear {@code gain}; false when it cannot be played. */
    boolean start(int voice, AudioData.Asset asset, double gain, double rate, boolean loop);

    /** Set a playing voice's linear gain. */
    void setGain(int voice, double gain);

    /** Stop a voice now and release it. */
    void stop(int voice);
  }

  /** A playing voice. */
  public static final class Voice {
    public final int handle;
    public final String bus;
    /** The sound's own volume: the command's, then the last fade's target. */
    public double soundVolume;
    /** The gain last given to the output. */
    public double gain;
    /** Fading out to stop (no longer reachable by its command id). */
    public boolean stopping;
    double from, to, t, duration; // gain ramp (duration 0 = none)
    double life; // seconds left for a one-shot, < 0 = until stopped

    Voice(int handle, String bus) {
      this.handle = handle;
      this.bus = bus;
    }

    /** Whether a gain ramp (fade-in, fade or stop fade) is running. */
    public boolean ramping() {
      return duration > 0;
    }

    /** The gain the voice is ramping to (its current gain when not ramping). */
    public double target() {
      return duration > 0 ? to : gain;
    }
  }

  private final AudioData audio;
  private final Output output;
  private final Map<String, Voice> voices = new LinkedHashMap<>();
  private final List<Voice> stopping = new ArrayList<>();
  /** Seconds a one-shot is kept after its asset's duration before it is released. */
  static final double EXPIRY_SLACK = 0.25;
  private int nextHandle = 1;
  private double volume = 1;
  /** Mix overrides: bus id ("" = master) → muted. */
  private final Map<String, Boolean> mutes = new LinkedHashMap<>();

  public AudioMixer(AudioData audio, Output output) {
    this.audio = audio;
    this.output = output;
  }

  public AudioMixer(OpenBoneDocument doc, Output output) {
    this(doc.audio, output);
  }

  /** The document's master volume: 0 when the master is muted, 1 when the document has no audio settings. */
  public double master() {
    if (muted(null)) return 0;
    return audio == null ? 1 : audio.master;
  }

  /** Whether a bus (null = the master) is muted: by a {@code mix} command, else by the document. */
  public boolean muted(String bus) {
    Boolean m = mutes.get(bus != null ? bus : "");
    if (m != null) return m;
    if (audio == null) return false;
    if (bus == null) return audio.muted;
    for (AudioData.Bus b : audio.buses) if (b.id.equals(bus)) return b.muted;
    return false;
  }

  /** {@code master × bus volume × volume} (0 when the bus is muted; an unknown or null bus counts as 1). */
  public double busGain(String bus) {
    double gain = master() * volume;
    if (bus != null && audio != null)
      for (AudioData.Bus b : audio.buses)
        if (b.id.equals(bus)) {
          gain *= muted(bus) ? 0 : b.volume;
          break;
        }
    return gain;
  }

  public double getVolume() {
    return volume;
  }

  /** Extra gain on everything this mixer plays; applies to the playing voices at once. */
  public void setVolume(double v) {
    volume = v;
    regain();
  }

  /** Give every playing voice its gain again (after the volume or a mute changed). */
  private void regain() {
    for (Voice voice : voices.values()) {
      double target = voice.soundVolume * busGain(voice.bus);
      if (voice.ramping()) voice.to = target;
      else apply(voice, target);
    }
  }

  /** The playing voice of a command id, or null. */
  public Voice voice(String id) {
    return voices.get(id);
  }

  /** Voices playing or fading out. */
  public int voiceCount() {
    return voices.size() + stopping.size();
  }

  /** Handle one audio command (give it everything {@link OpenBoneInstance.Listener#audio} receives). */
  public void handle(AudioCommand c) {
    switch (c.type) {
      case "play": play(c); break;
      case "stop": {
        Voice v = voices.remove(c.id);
        if (v == null) return;
        if (c.fade > 0) {
          v.stopping = true;
          ramp(v, 0, c.fade);
          stopping.add(v);
        } else output.stop(v.handle);
        break;
      }
      case "fade": {
        Voice v = voices.get(c.id);
        if (v == null) return;
        v.soundVolume = c.volume;
        double target = c.volume * busGain(v.bus);
        if (c.duration > 0) ramp(v, target, c.duration);
        else {
          v.duration = 0;
          apply(v, target);
        }
        break;
      }
      case "mix":
        mutes.put(c.bus != null ? c.bus : "", c.muted);
        regain();
        break;
      default: break;
    }
  }

  private void play(AudioCommand c) {
    Voice old = voices.remove(c.id);
    if (old != null) output.stop(old.handle);
    AudioData.Asset asset = null;
    if (audio != null) for (AudioData.Asset a : audio.assets) if (a.id.equals(c.asset)) asset = a;
    if (asset == null) return;
    double target = c.volume * busGain(c.bus);
    double rate = c.rate > 0 ? c.rate : 0.01;
    Voice v = new Voice(nextHandle++, c.bus);
    v.soundVolume = c.volume;
    v.gain = c.fadeIn > 0 ? 0 : target;
    // A little slack: durations are estimates, and releasing a voice early would cut its tail.
    v.life = !c.loop && asset.duration > 0 ? asset.duration / rate + EXPIRY_SLACK : -1;
    if (!output.start(v.handle, asset, v.gain, rate, c.loop)) return;
    if (c.fadeIn > 0) ramp(v, target, c.fadeIn);
    voices.put(c.id, v);
  }

  private static void ramp(Voice v, double to, double duration) {
    v.from = v.gain;
    v.to = to;
    v.t = 0;
    v.duration = duration;
  }

  private void apply(Voice v, double gain) {
    if (gain == v.gain) return;
    v.gain = gain;
    output.setGain(v.handle, gain);
  }

  /** Step fades and expire finished one-shots by {@code dt} real seconds. */
  public void update(double dt) {
    for (Iterator<Voice> it = voices.values().iterator(); it.hasNext(); ) {
      Voice v = it.next();
      if (expired(v, dt)) {
        output.stop(v.handle);
        it.remove();
      } else step(v, dt);
    }
    for (Iterator<Voice> it = stopping.iterator(); it.hasNext(); ) {
      Voice v = it.next();
      if (expired(v, dt)) {
        output.stop(v.handle);
        it.remove();
        continue;
      }
      step(v, dt);
      if (!v.ramping()) {
        output.stop(v.handle);
        it.remove();
      }
    }
  }

  private static boolean expired(Voice v, double dt) {
    if (v.life < 0) return false;
    v.life -= dt;
    return v.life <= 0;
  }

  private void step(Voice v, double dt) {
    if (!v.ramping()) return;
    v.t += dt;
    double k = Math.min(1, v.t / v.duration);
    apply(v, v.from + (v.to - v.from) * k);
    if (k >= 1) v.duration = 0;
  }

  /** The output reports that a voice ended by itself (e.g. a one-shot reached its end). */
  public void voiceFinished(int handle) {
    voices.values().removeIf(v -> v.handle == handle);
    stopping.removeIf(v -> v.handle == handle);
  }

  /** Stop every voice now. */
  public void stopAll() {
    for (Voice v : voices.values()) output.stop(v.handle);
    for (Voice v : stopping) output.stop(v.handle);
    voices.clear();
    stopping.clear();
  }
}
