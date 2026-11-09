package com.openbone.runtime.data;

/** Base of every attachment kind; {@link #type} is the file's type string ("region", "mesh"…). */
public abstract class Attachment {
  public String type, name;

  protected Attachment(String type) {
    this.type = type;
  }
}
