package com.openbone.runtime;

import com.openbone.runtime.data.ScriptData;

/**
 * Pluggable JavaScript engine for state machine scripts. The core has no engine; use {@code QuickJsScriptHost} from
 * openbone-scripting (QuickJS, the engine the TypeScript reference uses) or write your own.
 */
public interface ScriptHost {
  /**
   * JavaScript defining the global {@code ob} (and {@code console.log}) over a host function
   * {@code __ob(method, argsJson)} that returns the result as JSON text or undefined. Hosts evaluate it before the script.
   */
  String PRELUDE =
      "const ob = Object.freeze(Object.fromEntries([\"time\",\"input\",\"setInput\",\"fire\",\"emit\",\"bone\",\"setBone\",\"slot\",\"pointer\",\"log\"].map(m => [m, (...a) => {\n"
          + "  const r = __ob(m, JSON.stringify(a));\n"
          + "  return r === undefined || r === null ? undefined : JSON.parse(r);\n"
          + "}])));\n"
          + "const console = { log: (...a) => ob.log(...a) };\n";

  ScriptHandle load(ScriptData script, ScriptApi api) throws Exception;
}
