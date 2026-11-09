package com.openbone.runtime.data;

/** Keys for one property of one target ("bone", "slot", "ik", "transform", "path", "physics", "sequence", "particles", "deform", "drawOrder"). */
public class Timeline {
  public String target, id, property;
  /** Attachment name for deform and sequence timelines. */
  public String attachment;
  public Key[] keys = new Key[0];
}
