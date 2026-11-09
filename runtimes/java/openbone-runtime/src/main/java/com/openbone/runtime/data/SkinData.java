package com.openbone.runtime.data;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class SkinData {
  public String id, name;
  /** Slot id → attachment name → attachment (insertion ordered, as in the file). */
  public final Map<String, Map<String, Attachment>> attachments = new LinkedHashMap<>();
  /** Skin bones / skin constraints (ids), or null. */
  public List<String> bones, constraints;

  public Attachment get(String slotId, String name) {
    Map<String, Attachment> m = attachments.get(slotId);
    return m == null ? null : m.get(name);
  }
}
