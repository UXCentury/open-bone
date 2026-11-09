package com.openbone.runtime.data;

public class MeshAttachment extends Attachment {
  public String image, color = "#ffffffff";
  public double[] uvs, vertices;
  public int[] triangles;
  /** Per vertex: its bone influences, or null for an unweighted mesh. */
  public VertexWeight[][] weights;
  public int hull;
  /** Linked mesh info, or null. */
  public Linked linked;

  public MeshAttachment() {
    super("mesh");
  }

  public static class VertexWeight {
    public String bone;
    public double x, y, weight;
  }

  public static class Linked {
    public String mesh, slot, skin;
    public boolean deform;
  }
}
