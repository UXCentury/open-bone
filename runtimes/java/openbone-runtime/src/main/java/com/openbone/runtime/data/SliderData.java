package com.openbone.runtime.data;

/** Scrubs an animation from a driver: a bone's local property or a number input. */
public class SliderData {
  public String id, name, animation, bone, property, input;
  public double from, to, mix = 1;
  public Double timeFrom, timeTo;
  public boolean loop, additive;
}
