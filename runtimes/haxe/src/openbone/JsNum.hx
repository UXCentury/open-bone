package openbone;

/**
 * JavaScript number semantics the runtime depends on (string forms, toFixed, toPrecision, Number(), truthiness,
 * Math.fround). On the JS target the engine's own functions are used; elsewhere they are computed exactly from the
 * binary value of the double (big-integer decimal expansion), so every target gives the same strings.
 */
class JsNum {
	/** `String(n)`: shortest round-trip form, "1e21" style exponents, no trailing ".0". */
	public static function toString(v:Float):String {
		#if js
		return js.Syntax.code("String({0})", v);
		#else
		if (Math.isNaN(v))
			return "NaN";
		if (v == Math.POSITIVE_INFINITY)
			return "Infinity";
		if (v == Math.NEGATIVE_INFINITY)
			return "-Infinity";
		if (v == 0)
			return "0";
		if (v < 0)
			return "-" + toString(-v);
		var digits:String = null;
		var exp = 0; // value = 0.digits × 10^exp
		var ex = expand(v);
		for (prec in 1...18) {
			var r = roundDigits(ex.digits, prec);
			// r.digits × 10^(len(ex.digits) - prec + r.carry - ex.scale)
			var e10 = ex.digits.length - prec + r.carry - ex.scale;
			var cand = Std.parseFloat(r.digits + "e" + e10);
			if (cand == v || prec == 17) {
				digits = r.digits;
				exp = e10 + digits.length;
				break;
			}
		}
		var end = digits.length;
		while (end > 1 && digits.charAt(end - 1) == "0")
			end--;
		digits = digits.substr(0, end);
		var k = digits.length;
		var n = exp;
		var b = new StringBuf();
		if (k <= n && n <= 21) {
			b.add(digits);
			for (i in 0...n - k)
				b.add("0");
		} else if (0 < n && n <= 21) {
			b.add(digits.substr(0, n));
			b.add(".");
			b.add(digits.substr(n));
		} else if (-6 < n && n <= 0) {
			b.add("0.");
			for (i in 0...-n)
				b.add("0");
			b.add(digits);
		} else {
			b.add(digits.charAt(0));
			if (k > 1) {
				b.add(".");
				b.add(digits.substr(1));
			}
			b.add("e");
			b.add(n - 1 >= 0 ? "+" : "-");
			b.add(Std.string(Std.int(Math.abs(n - 1))));
		}
		return b.toString();
		#end
	}

	/** `n.toFixed(digits)`: exact decimal value, ties rounded up (away from zero). */
	public static function toFixed(v:Float, digits:Int):String {
		#if js
		return js.Syntax.code("({0}).toFixed({1})", v, digits);
		#else
		if (!Math.isFinite(v))
			return toString(v);
		if (Math.abs(v) >= 1e21)
			return toString(v);
		var neg = v < 0;
		var a = Math.abs(v);
		var ds:String;
		if (a == 0)
			ds = "0";
		else {
			var ex = expand(a);
			ds = ex.digits;
			if (digits >= ex.scale) {
				for (i in 0...digits - ex.scale)
					ds += "0";
			} else {
				var cut = ex.scale - digits;
				if (cut >= ds.length) {
					// value < 10^-digits·(something): rounds to 0 or 1 unit
					var first = cut == ds.length ? ds.charCodeAt(0) - "0".code : 0;
					ds = first >= 5 ? "1" : "0";
				} else {
					var keep = ds.substr(0, ds.length - cut);
					var up = ds.charCodeAt(ds.length - cut) - "0".code >= 5;
					ds = up ? increment(keep) : keep;
				}
			}
		}
		// ds is the integer value × 10^digits
		while (ds.length < digits + 1)
			ds = "0" + ds;
		var s = digits > 0 ? ds.substr(0, ds.length - digits) + "." + ds.substr(ds.length - digits) : ds;
		return neg ? "-" + s : s;
		#end
	}

	/** `Number(n.toPrecision(p))`. */
	public static function roundPrecision(v:Float, precision:Int):Float {
		#if js
		return js.Syntax.code("Number(({0}).toPrecision({1}))", v, precision);
		#else
		if (!Math.isFinite(v) || v == 0)
			return v;
		var neg = v < 0;
		var ex = expand(Math.abs(v));
		if (ex.digits.length <= precision)
			return v;
		var r = roundDigits(ex.digits, precision);
		var e10 = ex.digits.length - precision + r.carry - ex.scale;
		var out = Std.parseFloat(r.digits + "e" + e10);
		return neg ? -out : out;
		#end
	}

	/** `Number(string)`. */
	public static function parse(s:String):Float {
		var t = StringTools.trim(s);
		if (t == "")
			return 0;
		if (t == "Infinity" || t == "+Infinity")
			return Math.POSITIVE_INFINITY;
		if (t == "-Infinity")
			return Math.NEGATIVE_INFINITY;
		if (t.length > 2 && t.charAt(0) == "0") {
			var x = t.charAt(1).toLowerCase();
			var base = x == "x" ? 16 : x == "o" ? 8 : x == "b" ? 2 : 0;
			if (base > 0) {
				var r = 0.0;
				for (i in 2...t.length) {
					var c = t.charAt(i).toLowerCase().charCodeAt(0);
					var d = c >= "0".code && c <= "9".code ? c - "0".code : c >= "a".code && c <= "z".code ? c - "a".code + 10 : 99;
					if (d >= base)
						return Math.NaN;
					r = r * base + d;
				}
				return r;
			}
		}
		// [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
		var i = 0, n = t.length;
		inline function c(k:Int):Int
			return k < n ? StringTools.fastCodeAt(t, k) : 0;
		inline function isD(x:Int):Bool
			return x >= "0".code && x <= "9".code;
		if (c(i) == "+".code || c(i) == "-".code)
			i++;
		var intDigits = 0, fracDigits = 0;
		while (isD(c(i))) {
			i++;
			intDigits++;
		}
		if (c(i) == ".".code) {
			i++;
			while (isD(c(i))) {
				i++;
				fracDigits++;
			}
		}
		if (intDigits + fracDigits == 0)
			return Math.NaN;
		if (c(i) == "e".code || c(i) == "E".code) {
			i++;
			if (c(i) == "+".code || c(i) == "-".code)
				i++;
			var ed = 0;
			while (isD(c(i))) {
				i++;
				ed++;
			}
			if (ed == 0)
				return Math.NaN;
		}
		if (i != n)
			return Math.NaN;
		return Std.parseFloat(t);
	}

	/** `Number(value)` for an input value (Float, Bool, String, null = undefined). */
	public static function toNumber(v:Dynamic):Float {
		if (v == null)
			return Math.NaN;
		if (Std.isOfType(v, Bool))
			return v ? 1 : 0;
		if (Std.isOfType(v, String))
			return parse(v);
		if (Std.isOfType(v, Float) || Std.isOfType(v, Int))
			return (v : Float);
		return Math.NaN;
	}

	public static inline function isNum(v:Dynamic):Bool {
		return v != null && !Std.isOfType(v, Bool) && (Std.isOfType(v, Float) || Std.isOfType(v, Int));
	}

	/** `String(value)`. */
	public static function str(v:Dynamic):String {
		if (v == null)
			return "undefined";
		if (Std.isOfType(v, Bool))
			return v ? "true" : "false";
		if (isNum(v))
			return toString((v : Float));
		if (Std.isOfType(v, String))
			return v;
		return Std.string(v);
	}

	/** JavaScript truthiness. */
	public static function truthy(v:Dynamic):Bool {
		if (v == null)
			return false;
		if (Std.isOfType(v, Bool))
			return v;
		if (isNum(v)) {
			var d:Float = v;
			return d != 0 && !Math.isNaN(d);
		}
		if (Std.isOfType(v, String))
			return (v : String).length > 0;
		return true;
	}

	/** Strict equality (`===`) of two input values. */
	public static function strictEquals(a:Dynamic, b:Dynamic):Bool {
		if (a == null || b == null)
			return a == null && b == null;
		var na = isNum(a), nb = isNum(b);
		if (na && nb)
			return (a : Float) == (b : Float);
		if (na || nb)
			return false;
		if (Std.isOfType(a, Bool) && Std.isOfType(b, Bool))
			return (a : Bool) == (b : Bool);
		if (Std.isOfType(a, String) && Std.isOfType(b, String))
			return (a : String) == (b : String);
		return a == b;
	}

	/** `Math.round`: halves round up. */
	public static function round(v:Float):Float {
		if (!Math.isFinite(v))
			return v;
		var r = Math.ffloor(v);
		return v - r >= 0.5 ? r + 1 : r;
	}

	/** Round to float32 (`Math.fround`): round to nearest, ties to even. */
	public static function f32(v:Float):Float {
		#if js
		return js.Syntax.code("Math.fround({0})", v);
		#else
		if (v == 0 || !Math.isFinite(v))
			return v;
		var a = Math.abs(v);
		var e = ilog2(a);
		if (e > 127) {
			// at or above 2^128 overflows; just below rounds to max float or infinity
			return v < 0 ? Math.NEGATIVE_INFINITY : Math.POSITIVE_INFINITY;
		}
		var qe = e < -126 ? -149 : e - 23; // exponent of the float32 unit in the last place
		var q = scale2(a, -qe); // exact
		var fl = Math.ffloor(q);
		var diff = q - fl;
		var r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : (fl % 2 == 0 ? fl : fl + 1);
		var out = scale2(r, qe);
		if (out >= scale2(1, 128)) // rounded past the largest float32
			out = Math.POSITIVE_INFINITY;
		return v < 0 ? -out : out;
		#end
	}

	/** float32 from its IEEE bits. */
	public static function floatFromBits(bits:Int):Float {
		var sign = (bits >>> 31) != 0 ? -1.0 : 1.0;
		var exp = (bits >>> 23) & 0xff;
		var man = bits & 0x7fffff;
		if (exp == 0xff)
			return man != 0 ? Math.NaN : sign * Math.POSITIVE_INFINITY;
		if (exp == 0)
			return sign * scale2(man, -149);
		return sign * scale2(man + 8388608.0, exp - 150);
	}

	/** float64 from its IEEE bits (low and high 32-bit words). */
	public static function doubleFromBits(lo:Int, hi:Int):Float {
		var sign = (hi >>> 31) != 0 ? -1.0 : 1.0;
		var exp = (hi >>> 20) & 0x7ff;
		var manHi:Float = hi & 0xfffff;
		var manLo:Float = lo < 0 ? lo + 4294967296.0 : lo;
		var man = manHi * 4294967296.0 + manLo;
		if (exp == 0x7ff)
			return man != 0 ? Math.NaN : sign * Math.POSITIVE_INFINITY;
		if (exp == 0)
			return sign * scale2(man, -1074);
		return sign * scale2(man + 4503599627370496.0, exp - 1075);
	}

	// ---------------- exact helpers ----------------

	/** floor(log2(a)) for a finite a > 0. */
	static function ilog2(a:Float):Int {
		var e = Std.int(Math.floor(Math.log(a) / Math.log(2)));
		while (scale2(1, e) > a)
			e--;
		while (scale2(1, e + 1) <= a)
			e++;
		return e;
	}

	/** a × 2^k, exact while the result is representable (applied in steps so 2^k itself never overflows). */
	static function scale2(a:Float, k:Int):Float {
		while (k > 500) {
			a *= Math.pow(2, 500);
			k -= 500;
		}
		while (k < -500) {
			a *= Math.pow(2, -500);
			k += 500;
		}
		return a * Math.pow(2, k);
	}

	/** Exact decimal expansion of a finite a > 0: a = digits × 10^-scale. */
	static function expand(a:Float):{digits:String, scale:Int} {
		var e = ilog2(a);
		var e2 = e - 52;
		if (e2 < -1074)
			e2 = -1074;
		var m = scale2(a, -e2); // integer < 2^53
		// limbs base 1e7, little endian
		var limbs:Array<Float> = [];
		while (m > 0) {
			var r = m % 1e7;
			limbs.push(r);
			m = (m - r) / 1e7;
		}
		var scale = 0;
		if (e2 > 0) {
			var k = e2;
			while (k > 0) {
				var s = k > 20 ? 20 : k;
				mulSmall(limbs, Math.pow(2, s));
				k -= s;
			}
		} else if (e2 < 0) {
			var k = -e2;
			scale = k;
			while (k > 0) {
				var s = k > 9 ? 9 : k;
				mulSmall(limbs, Math.pow(5, s));
				k -= s;
			}
		}
		var b = new StringBuf();
		var i = limbs.length - 1;
		b.add(Std.string(Std.int(limbs[i])));
		while (--i >= 0) {
			var part = Std.string(Std.int(limbs[i]));
			for (z in part.length...7)
				b.add("0");
			b.add(part);
		}
		return {digits: b.toString(), scale: scale};
	}

	static function mulSmall(limbs:Array<Float>, f:Float):Void {
		var carry = 0.0;
		for (i in 0...limbs.length) {
			var x = limbs[i] * f + carry;
			var r = x % 1e7;
			limbs[i] = r;
			carry = (x - r) / 1e7;
		}
		while (carry > 0) {
			var r = carry % 1e7;
			limbs.push(r);
			carry = (carry - r) / 1e7;
		}
	}

	/** Round a digit string to `prec` significant digits, ties up; carry = 1 when it gained a digit (999 → 1000 → "100"). */
	static function roundDigits(d:String, prec:Int):{digits:String, carry:Int} {
		if (d.length <= prec) {
			var s = d;
			while (s.length < prec)
				s += "0";
			return {digits: s, carry: 0};
		}
		var keep = d.substr(0, prec);
		if (d.charCodeAt(prec) - "0".code >= 5) {
			var inc = increment(keep);
			if (inc.length > prec)
				return {digits: inc.substr(0, prec), carry: 1};
			return {digits: inc, carry: 0};
		}
		return {digits: keep, carry: 0};
	}

	static function increment(s:String):String {
		var chars = [for (i in 0...s.length) s.charCodeAt(i) - "0".code];
		var i = chars.length - 1;
		while (i >= 0) {
			if (chars[i] < 9) {
				chars[i]++;
				break;
			}
			chars[i] = 0;
			i--;
		}
		var b = new StringBuf();
		if (i < 0)
			b.add("1");
		for (c in chars)
			b.add(Std.string(c));
		return b.toString();
	}
}
