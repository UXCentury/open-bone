package com.openbone.runtime.data;

public class PathAttachment extends Attachment {
  public double[] vertices = new double[0];
  public MeshAttachment.VertexWeight[][] weights;
  public boolean closed;
  public String color = "#ff8800ff";

  public PathAttachment() {
    super("path");
  }
}
