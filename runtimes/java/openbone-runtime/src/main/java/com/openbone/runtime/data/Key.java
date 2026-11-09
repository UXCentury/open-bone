package com.openbone.runtime.data;

/**
 * One timeline key. {@code value} is a Double (numbers), String (colours, attachment names, inherit modes), Boolean
 * (switches), null, double[] (deform offsets) or String[] (draw order slot ids).
 */
public class Key {
  public double time;
  public Object value;
  public Curve curve = Curve.LINEAR;
}
