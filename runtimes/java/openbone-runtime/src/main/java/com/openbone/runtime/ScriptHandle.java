package com.openbone.runtime;

/** One loaded script. */
public interface ScriptHandle {
  /** Whether the script defines a global function with this name. */
  boolean has(String fn);

  /** Call a global function; arguments cross as JSON values (Map, List, Double, String, Boolean, null). */
  Object call(String fn, Object... args);

  void dispose();
}
