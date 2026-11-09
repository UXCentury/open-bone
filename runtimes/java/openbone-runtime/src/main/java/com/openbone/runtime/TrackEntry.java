package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import java.util.concurrent.atomic.AtomicInteger;

/** An animation playing on a track of an {@link AnimationState}. */
public final class TrackEntry {
  private static final AtomicInteger COUNTER = new AtomicInteger();
  /** Owner id for the sounds this entry starts. */
  public final String uid = "entry_" + COUNTER.incrementAndGet();
  public final AnimationData animation;
  public final boolean loop;
  /** Total elapsed time (seconds, unwrapped). */
  public double time;
  public double prevTime = -1e-6;
  public double speed = 1, alpha = 1;
  public TrackEntry mixingFrom;
  public double mixTime, mixDuration;
  public double completedLoops;

  public TrackEntry(AnimationData animation, boolean loop) {
    this.animation = animation;
    this.loop = loop;
  }

  public double duration() {
    return animation.duration();
  }

  public double localTime() {
    return Animations.localTime(animation, time, loop);
  }

  public boolean isComplete() {
    return !loop && time >= duration();
  }
}
