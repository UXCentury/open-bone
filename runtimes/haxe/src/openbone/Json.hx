package openbone;

/**
 * JSON object with insertion-ordered keys (JSON.parse keeps the file's key order for non-index keys, and the runtime
 * depends on it in a few places, so maps from haxe.Json, whose field order varies by target, are not used).
 */
class JObject {
	public final keys:Array<String> = [];

	final map:Map<String, Dynamic> = new Map();

	public function new() {}

	public inline function exists(k:String):Bool {
		return map.exists(k);
	}

	public function get(k:String):Dynamic {
		return map.get(k);
	}

	public function set(k:String, v:Dynamic):Void {
		if (!map.exists(k))
			keys.push(k);
		map.set(k, v);
	}
}

/** Marker for a JavaScript `undefined` field (left out when written, like JSON.stringify). */
class Undefined {
	public static final INSTANCE = new Undefined();

	function new() {}
}

/**
 * Minimal JSON reader/writer. Values: `JObject` (insertion ordered), `Array<Dynamic>`, `Float`, `String`, `Bool`,
 * `null`. Numbers are written like JavaScript's `JSON.stringify` (shortest round-trip form).
 */
class Json {
	final s:String;
	var p:Int = 0;

	function new(s:String) {
		this.s = s;
	}

	public static function parse(text:String):Dynamic {
		var j = new Json(text);
		j.ws();
		var v = j.value();
		j.ws();
		if (j.p != j.s.length)
			throw j.err("Unexpected trailing characters");
		return v;
	}

	function err(msg:String):String {
		return msg + " at offset " + p;
	}

	inline function code(i:Int):Int {
		return StringTools.fastCodeAt(s, i);
	}

	function ws():Void {
		while (p < s.length) {
			var c = code(p);
			if (c == " ".code || c == "\n".code || c == "\r".code || c == "\t".code)
				p++;
			else
				break;
		}
	}

	function peek():Int {
		return p < s.length ? code(p) : 0;
	}

	function next():Int {
		if (p >= s.length)
			throw err("Unexpected end of JSON");
		return code(p++);
	}

	function value():Dynamic {
		if (p >= s.length)
			throw err("Unexpected end of JSON");
		var c = code(p);
		switch (c) {
			case "{".code:
				p++;
				var m = new JObject();
				ws();
				if (peek() == "}".code) {
					p++;
					return m;
				}
				while (true) {
					ws();
					if (peek() != "\"".code)
						throw err("Expected key");
					var k = string();
					ws();
					if (next() != ":".code)
						throw err("Expected :");
					ws();
					m.set(k, value());
					ws();
					var n = next();
					if (n == "}".code)
						return m;
					if (n != ",".code)
						throw err("Expected , or }");
				}
			case "[".code:
				p++;
				var a:Array<Dynamic> = [];
				ws();
				if (peek() == "]".code) {
					p++;
					return a;
				}
				while (true) {
					ws();
					a.push(value());
					ws();
					var n = next();
					if (n == "]".code)
						return a;
					if (n != ",".code)
						throw err("Expected , or ]");
				}
			case "\"".code:
				return string();
			case "t".code:
				lit("true");
				return true;
			case "f".code:
				lit("false");
				return false;
			case "n".code:
				lit("null");
				return null;
			default:
				return number();
		}
		return null;
	}

	function lit(w:String):Void {
		if (s.substr(p, w.length) != w)
			throw err("Unexpected token");
		p += w.length;
	}

	function number():Float {
		var start = p;
		if (peek() == "-".code)
			p++;
		while (p < s.length) {
			var c = code(p);
			if ((c >= "0".code && c <= "9".code) || c == ".".code || c == "e".code || c == "E".code || c == "+".code || c == "-".code)
				p++;
			else
				break;
		}
		if (start == p)
			throw err("Unexpected character");
		var v = JsNum.parse(s.substring(start, p));
		if (Math.isNaN(v))
			throw err("Bad number");
		return v;
	}

	function string():String {
		if (next() != "\"".code)
			throw err("Expected string");
		var b:StringBuf = null;
		var start = p;
		while (true) {
			if (p >= s.length)
				throw err("Unterminated string");
			var c = code(p++);
			if (c == "\"".code)
				return b == null ? s.substring(start, p - 1) : b.toString();
			if (c == "\\".code) {
				if (b == null) {
					b = new StringBuf();
					b.add(s.substring(start, p - 1));
				}
				var e = next();
				switch (e) {
					case "n".code:
						b.addChar("\n".code);
					case "t".code:
						b.addChar("\t".code);
					case "r".code:
						b.addChar("\r".code);
					case "b".code:
						b.addChar(8);
					case "f".code:
						b.addChar(12);
					case "u".code:
						if (p + 4 > s.length)
							throw err("Bad escape");
						var u = Std.parseInt("0x" + s.substr(p, 4));
						p += 4;
						// surrogate pairs: combine into one code point (targets with UTF-8 strings need it)
						if (u >= 0xD800 && u <= 0xDBFF && p + 6 <= s.length && s.substr(p, 2) == "\\u") {
							var lo = Std.parseInt("0x" + s.substr(p + 2, 4));
							if (lo >= 0xDC00 && lo <= 0xDFFF) {
								p += 6;
								u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
							}
						}
						b.addChar(u);
					default:
						b.addChar(e);
				}
			} else if (b != null)
				b.addChar(c);
		}
	}

	// ---------------- Writing ----------------

	/** JSON text of a value (JObject, arrays, numbers, strings, booleans, null). */
	public static function stringify(v:Dynamic):String {
		var b = new StringBuf();
		write(b, v);
		return b.toString();
	}

	static function write(b:StringBuf, v:Dynamic):Void {
		if (v == null)
			b.add("null");
		else if (Std.isOfType(v, String))
			quote(b, v);
		else if (Std.isOfType(v, Bool))
			b.add(v ? "true" : "false");
		else if (Std.isOfType(v, Float) || Std.isOfType(v, Int)) {
			var d:Float = v;
			b.add(Math.isFinite(d) ? JsNum.toString(d) : "null");
		} else if (Std.isOfType(v, JObject)) {
			var o:JObject = v;
			b.add("{");
			var first = true;
			for (k in o.keys) {
				var x = o.get(k);
				if (x == Undefined.INSTANCE)
					continue;
				if (!first)
					b.add(",");
				first = false;
				quote(b, k);
				b.add(":");
				write(b, x);
			}
			b.add("}");
		} else if (Std.isOfType(v, Array)) {
			var l:Array<Dynamic> = v;
			b.add("[");
			for (i in 0...l.length) {
				if (i > 0)
					b.add(",");
				var x = l[i];
				write(b, x == Undefined.INSTANCE ? null : x);
			}
			b.add("]");
		} else if (v == Undefined.INSTANCE)
			b.add("null");
		else
			quote(b, Std.string(v));
	}

	static function quote(b:StringBuf, s:String):Void {
		b.add("\"");
		for (i in 0...s.length) {
			var c = StringTools.fastCodeAt(s, i);
			switch (c) {
				case "\"".code:
					b.add("\\\"");
				case "\\".code:
					b.add("\\\\");
				case "\n".code:
					b.add("\\n");
				case "\r".code:
					b.add("\\r");
				case "\t".code:
					b.add("\\t");
				case 8:
					b.add("\\b");
				case 12:
					b.add("\\f");
				default:
					if (c < 0x20)
						b.add("\\u" + StringTools.hex(c, 4).toLowerCase());
					else
						b.add(s.charAt(i));
			}
		}
		b.add("\"");
	}
}
