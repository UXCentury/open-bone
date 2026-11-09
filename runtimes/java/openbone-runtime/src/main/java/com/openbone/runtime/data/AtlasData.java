package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

/** A texture atlas: pages (images) and the region of each packed image. */
public class AtlasData {
  public final List<Page> pages = new ArrayList<>();
  public final List<Region> regions = new ArrayList<>();
  /** A solid white block on a page (shapes and square particles sample its centre), or null. */
  public White white;
  public double padding, scale = 1;
  public boolean premultipliedAlpha, stripWhitespace, polygons;

  public static class Page {
    public String id, name, src;
    public double width, height;
  }

  public static class Region {
    public String image, page;
    public double x, y, width, height, offsetX, offsetY, originalWidth, originalHeight;
    public boolean rotated;
    /** Outline in original-image pixels (flat x,y, y-down), or null. */
    public double[] polygon;

    public boolean isTrimmed() {
      return offsetX != 0 || offsetY != 0 || width != originalWidth || height != originalHeight;
    }
  }

  public static class White {
    public String page;
    public double x, y, width, height;
  }
}
