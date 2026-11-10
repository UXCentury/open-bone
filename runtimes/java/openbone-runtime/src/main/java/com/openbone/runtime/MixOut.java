package com.openbone.runtime;

import com.openbone.runtime.data.AnimationData;
import java.util.List;

/**
 * How an animation being faded out is applied during a cross-fade: its blending timelines that none of {@link #into}
 * key use {@link #alpha} (the outgoing weight, 1 - mix) instead of the full weight, so they ease back to the pose
 * underneath (the setup pose on the first track / layer) instead of holding and snapping when the fade ends.
 */
public final class MixOut {
  public final List<AnimationData> into;
  public final double alpha;

  public MixOut(List<AnimationData> into, double alpha) {
    this.into = into;
    this.alpha = alpha;
  }
}
