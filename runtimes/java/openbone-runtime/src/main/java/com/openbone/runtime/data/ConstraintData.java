package com.openbone.runtime.data;

/** Base of the four constraint kinds. */
public abstract class ConstraintData {
  public String id, name;
  /** Position in the update order (see Skeleton constraint order), or null for the default position. */
  public Double order;

  /** "ik", "transform", "path" or "physics". */
  public abstract String kind();
}
