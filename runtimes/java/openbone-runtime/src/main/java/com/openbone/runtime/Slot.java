package com.openbone.runtime;

import com.openbone.runtime.data.SlotData;
import java.util.HashMap;
import java.util.Map;

/** A slot: what a bone shows (attachment), its tint and per-attachment deform / sequence state. */
public final class Slot {
  public final SlotData data;
  public final Bone bone;
  /** RGBA tint (0..1, not premultiplied). */
  public double[] color = {1, 1, 1, 1};
  /** Two-colour tint dark colour (alpha unused), or null. */
  public double[] dark;
  public String attachmentName;
  /** Mesh/path deform offsets by attachment name. */
  public final Map<String, double[]> deform = new HashMap<>();
  /** Keyed sequence frame counters by attachment name. */
  public final Map<String, Double> sequenceFrames = new HashMap<>();

  public Slot(SlotData data, Bone bone) {
    this.data = data;
    this.bone = bone;
    setToSetupPose();
  }

  public String name() {
    return data.name;
  }

  public void setToSetupPose() {
    color = MathUtil.parseHex(data.color);
    dark = data.dark != null ? MathUtil.parseHex(data.dark) : null;
    attachmentName = data.attachment;
    deform.clear();
    sequenceFrames.clear();
  }

  @Override
  public String toString() {
    return data.name;
  }
}
