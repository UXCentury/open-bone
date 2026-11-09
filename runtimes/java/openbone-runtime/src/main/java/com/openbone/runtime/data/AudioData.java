package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

public class AudioData {
  public double master = 1;
  public boolean muted;
  public final List<Asset> assets = new ArrayList<>();
  public final List<Bus> buses = new ArrayList<>();
  public final List<SoundData> sounds = new ArrayList<>();

  public static class Asset {
    public String id, name, src;
    public double duration;
  }

  public static class Bus {
    public String id, name;
    public double volume = 1;
    public boolean muted;
  }
}
