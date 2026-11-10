package openbone;

#if js
import openbone.Json;
import openbone.ScriptHost;
import openbone.data.Model;

/**
 * Script host for the JS target: runs state machine scripts on the JavaScript engine the program itself runs on
 * (node or a browser), through the same JSON boundary as the reference QuickJS host (docs/runtime-spec.md §11).
 * Scripts are not sandboxed or time-limited: only load documents you trust.
 */
class JsScriptHost implements ScriptHost {
	public function new() {}

	public function load(script:ScriptData, api:ScriptApi):ScriptHandle {
		var bridge = function(method:String, argsJson:String):Dynamic {
			var args:Array<Dynamic> = Json.parse(argsJson);
			var r:Dynamic = api.call(method, args);
			if (r == Undefined.INSTANCE)
				return js.Lib.undefined;
			return Json.stringify(r);
		};
		// Function bodies are sloppy-mode, so the lookup's direct eval sees the script's top-level functions.
		var body = ScriptPrelude.PRELUDE + script.code
			+ "\n;return function (n) { if (!/^[A-Za-z_$][\\w$]*$/.test(n)) return undefined; try { const f = eval(n); return typeof f === 'function' ? f : undefined; } catch (e) { return undefined; } };";
		var factory:Dynamic = js.Syntax.code("new Function('__ob', {0})", body);
		var lookup:Dynamic = factory(bridge);
		return new JsScriptHandle(lookup);
	}
}

private class JsScriptHandle implements ScriptHandle {
	var lookup:Dynamic;

	public function new(lookup:Dynamic) {
		this.lookup = lookup;
	}

	public function has(fn:String):Bool {
		return lookup != null && lookup(fn) != null;
	}

	public function call(fn:String, args:Array<Dynamic>):Dynamic {
		var f:Dynamic = lookup != null ? lookup(fn) : null;
		if (f == null)
			return null;
		// arguments and results cross as JSON, like the reference host
		var jsArgs:Dynamic = js.Syntax.code("JSON.parse({0})", Json.stringify(args));
		var r:Dynamic = js.Syntax.code("{0}.apply(undefined, {1})", f, jsArgs);
		if (js.Syntax.typeof(r) == "undefined")
			return null;
		return Json.parse(js.Syntax.code("JSON.stringify({0})", r));
	}

	public function dispose():Void {
		lookup = null;
	}
}
#end
