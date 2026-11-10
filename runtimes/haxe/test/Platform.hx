import haxe.io.Bytes;

/** The few host services the test programs need, on sys targets (eval, hl, cpp…) and on node. */
class Platform {
	public static function readBytes(path:String):Bytes {
		#if js
		var buf:Dynamic = fs().readFileSync(path);
		var ab:js.lib.ArrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		return Bytes.ofData(ab);
		#else
		return sys.io.File.getBytes(path);
		#end
	}

	public static function readText(path:String):String {
		#if js
		return fs().readFileSync(path, "utf8");
		#else
		return sys.io.File.getContent(path);
		#end
	}

	public static function listDir(path:String):Array<String> {
		#if js
		return fs().readdirSync(path);
		#else
		return sys.FileSystem.readDirectory(path);
		#end
	}

	public static function exists(path:String):Bool {
		#if js
		return fs().existsSync(path);
		#else
		return sys.FileSystem.exists(path);
		#end
	}

	public static function println(s:String):Void {
		#if js
		js.Syntax.code("console.log({0})", s);
		#else
		Sys.println(s);
		#end
	}

	public static function args():Array<String> {
		#if js
		var argv:Array<String> = js.Syntax.code("process.argv");
		return argv.slice(2);
		#else
		return Sys.args();
		#end
	}

	public static function env(name:String):String {
		#if js
		return js.Syntax.code("process.env[{0}]", name);
		#else
		return Sys.getEnv(name);
		#end
	}

	public static function exit(code:Int):Void {
		#if js
		js.Syntax.code("process.exit({0})", code);
		#else
		Sys.exit(code);
		#end
	}

	public static function now():Float {
		#if js
		return js.Syntax.code("Date.now()") / 1000;
		#else
		return Sys.time();
		#end
	}

	/** "eval", "js", "hl", "cpp"… */
	public static function target():String {
		#if interp
		return "eval";
		#elseif js
		return "js";
		#elseif hl
		return "hl";
		#elseif cpp
		return "cpp";
		#elseif jvm
		return "jvm";
		#elseif python
		return "python";
		#elseif neko
		return "neko";
		#else
		return "other";
		#end
	}

	#if js
	static function fs():Dynamic {
		return js.Lib.require("fs");
	}
	#end
}
