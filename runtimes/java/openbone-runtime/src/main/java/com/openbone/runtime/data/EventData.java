package com.openbone.runtime.data;

public class EventData {
  public String id, name;
  public double intValue, floatValue;
  public String stringValue = "";
  /** Sound (or audio asset) played when it fires, or null. */
  public String audio;
  public Double volume;
}
