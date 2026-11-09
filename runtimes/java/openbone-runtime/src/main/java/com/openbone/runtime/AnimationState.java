package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Plays animations on numbered tracks with cross-fading; higher tracks layer on top (runtime/animation-state.ts). */
public final class AnimationState {
  /** Receives animation state events. */
  public interface Listener {
    default void event(FiredEvent e, int track) {}

    default void start(TrackEntry entry, int track) {}

    default void complete(TrackEntry entry, int track) {}

    default void audio(AudioCommand c) {}
  }

  private static final class Queued {
    final int track;
    final TrackEntry entry;
    final double delay, mix;

    Queued(int track, TrackEntry entry, double delay, double mix) {
      this.track = track;
      this.entry = entry;
      this.delay = delay;
      this.mix = mix;
    }
  }

  public final Skeleton skeleton;
  public final List<TrackEntry> tracks = new ArrayList<>();
  private final List<Queued> queue = new ArrayList<>();
  public double defaultMix = 0.2;
  public final AudioDirector audio;
  private final List<Listener> listeners = new CopyOnWriteArrayList<>();

  public AnimationState(Skeleton skeleton) {
    this.skeleton = skeleton;
    audio = new AudioDirector(skeleton.doc, c -> {
      for (Listener l : listeners) l.audio(c);
    });
  }

  public void addListener(Listener l) {
    listeners.add(l);
  }

  public void removeListener(Listener l) {
    listeners.remove(l);
  }

  private void endEntry(TrackEntry e, double fade) {
    if (e != null) audio.stopOwner(e.uid, fade, false);
  }

  private AnimationData resolve(String anim) {
    AnimationData a = skeleton.doc.findAnimation(anim);
    if (a == null) throw new IllegalArgumentException("Animation \"" + anim + "\" not found");
    return a;
  }

  private TrackEntry get(int track) {
    return track < tracks.size() ? tracks.get(track) : null;
  }

  private void put(int track, TrackEntry e) {
    while (tracks.size() <= track) tracks.add(null);
    tracks.set(track, e);
  }

  public TrackEntry setAnimation(int track, String anim, boolean loop) {
    return setAnimation(track, resolve(anim), loop, defaultMix);
  }

  public TrackEntry setAnimation(int track, AnimationData anim, boolean loop, double mix) {
    TrackEntry entry = new TrackEntry(anim, loop);
    TrackEntry cur = get(track);
    endEntry(cur, mix);
    if (cur != null && mix > 0) {
      entry.mixingFrom = cur;
      cur.mixingFrom = null;
      entry.mixDuration = mix;
    }
    put(track, entry);
    queue.removeIf(q -> q.track == track);
    for (Listener l : listeners) l.start(entry, track);
    return entry;
  }

  /** Queue an animation after the current one completes (non-looping) or after {@code delay} seconds. */
  public TrackEntry addAnimation(int track, String anim, boolean loop, double delay) {
    return addAnimation(track, resolve(anim), loop, delay, defaultMix);
  }

  public TrackEntry addAnimation(int track, AnimationData anim, boolean loop, double delay, double mix) {
    TrackEntry entry = new TrackEntry(anim, loop);
    if (get(track) == null) {
      put(track, entry);
      for (Listener l : listeners) l.start(entry, track);
    } else queue.add(new Queued(track, entry, delay, mix));
    return entry;
  }

  public void clearTrack(int track) {
    endEntry(get(track), 0);
    if (track < tracks.size()) tracks.set(track, null);
  }

  /** Stop every track and every sound. */
  public void clearTracks() {
    tracks.clear();
    queue.clear();
    audio.stopAll(0);
  }

  public void update(double dt) {
    audio.update(dt);
    for (int track = 0; track < tracks.size(); track++) {
      TrackEntry e = tracks.get(track);
      if (e == null) continue;
      e.prevTime = e.time > 0 ? e.time : Math.min(e.prevTime, e.time);
      e.time += dt * e.speed;
      if (e.mixingFrom != null) {
        e.mixingFrom.prevTime = e.mixingFrom.time;
        e.mixingFrom.time += dt * e.mixingFrom.speed;
        e.mixTime += dt;
        if (e.mixTime >= e.mixDuration) e.mixingFrom = null;
      }
      if (dt > 0) {
        AudioDirector.playAudioKeys(audio, e.animation, e.prevTime, e.time, e.loop, e.uid);
        for (FiredEvent ev : Animations.eventsBetween(skeleton.doc, e.animation, e.prevTime, e.time, e.loop)) {
          if (ev.audio != null) {
            AudioDirector.PlayOptions o = new AudioDirector.PlayOptions();
            o.volume = ev.volume;
            o.owner = e.uid;
            o.source = "event:" + ev.name;
            audio.play(ev.audio, o);
          }
          for (Listener l : listeners) l.event(ev, track);
        }
      }
      double d = e.duration();
      if (d > 0) {
        double loops = Math.floor(e.time / d);
        if (e.loop ? loops > e.completedLoops : e.prevTime < d && e.time >= d) {
          e.completedLoops = loops;
          for (Listener l : listeners) l.complete(e, track);
          if (!e.loop) endEntry(e, 0);
        }
      }
      Queued q = null;
      for (Queued x : queue)
        if (x.track == track) {
          q = x;
          break;
        }
      if (q != null && (q.delay > 0 ? e.time >= q.delay : e.isComplete() || (e.loop && d > 0 && e.time >= d))) {
        queue.remove(q);
        endEntry(e, q.mix);
        q.entry.mixingFrom = e;
        q.entry.mixDuration = q.mix;
        tracks.set(track, q.entry);
        for (Listener l : listeners) l.start(q.entry, track);
      }
    }
  }

  public void apply() {
    apply(skeleton);
  }

  public void apply(Skeleton sk) {
    for (TrackEntry e : tracks) {
      if (e == null) continue;
      if (e.mixingFrom != null) {
        Animations.apply(sk, e.mixingFrom.animation, e.mixingFrom.localTime(), e.alpha);
        double md = e.mixDuration == 0 || Double.isNaN(e.mixDuration) ? 1 : e.mixDuration;
        Animations.apply(sk, e.animation, e.localTime(), e.alpha * Math.min(1, e.mixTime / md));
      } else Animations.apply(sk, e.animation, e.localTime(), e.alpha);
    }
  }
}
