package com.openbone.runtime.data;

public class SlotData {
  public String id, name, bone, color = "#ffffff", attachment;
  /** "normal", "additive", "multiply" or "screen". */
  public String blend = "normal";
  /** Two-colour tint dark colour, or null. */
  public String dark;
}
