package openbone;

import openbone.data.Model;

/**
 * The `ob` object scripts see. Hosts call `call` with a method name and the JSON-decoded arguments (JObject, arrays,
 * Float, String, Bool, null) and pass the result back JSON-encoded; `Undefined.INSTANCE` stands for `undefined`.
 * Methods: time, input, setInput, fire, emit, bone, setBone, slot, pointer, log.
 */
interface ScriptApi {
	function call(method:String, args:Array<Dynamic>):Dynamic;
}

/** One loaded script. */
interface ScriptHandle {
	/** Whether the script defines a global function with this name. */
	function has(fn:String):Bool;

	/** Call a global function; arguments cross as JSON values (JObject, arrays, Float, String, Bool, null). */
	function call(fn:String, args:Array<Dynamic>):Dynamic;

	function dispose():Void;
}

/**
 * Pluggable JavaScript engine for state machine scripts (docs/runtime-spec.md §11). The runtime itself has no engine:
 * pass `null` to skip scripts, use `openbone.JsScriptHost` on the JS target, or write a host for your engine.
 */
interface ScriptHost {
	function load(script:ScriptData, api:ScriptApi):ScriptHandle;
}

class ScriptPrelude {
	/**
	 * JavaScript defining the global `ob` (and `console.log`) over a host function `__ob(method, argsJson)` that
	 * returns the result as JSON text or undefined. Hosts evaluate it before the script.
	 */
	public static inline final PRELUDE = "const ob = Object.freeze(Object.fromEntries([\"time\",\"input\",\"setInput\",\"fire\",\"emit\",\"bone\",\"setBone\",\"slot\",\"pointer\",\"log\"].map(m => [m, (...a) => {\n"
		+ "  const r = __ob(m, JSON.stringify(a));\n"
		+ "  return r === undefined || r === null ? undefined : JSON.parse(r);\n"
		+ "}])));\n"
		+ "const console = { log: (...a) => ob.log(...a) };\n";
}
