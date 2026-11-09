package com.openbone.runtime;

import java.util.List;

/**
 * The {@code ob} object scripts see. Hosts call {@link #call} with a method name and the JSON-decoded arguments, and
 * return the result JSON-encoded (null result = {@code undefined}). Methods: time, input, setInput, fire, emit, bone,
 * setBone, slot, pointer, log.
 */
public interface ScriptApi {
  String[] METHODS = {"time", "input", "setInput", "fire", "emit", "bone", "setBone", "slot", "pointer", "log"};

  /** Run an API method; args/result are JSON values (Map, List, Double, String, Boolean, null); return {@link Json.Undefined#INSTANCE} for undefined. */
  Object call(String method, List<Object> args);
}
