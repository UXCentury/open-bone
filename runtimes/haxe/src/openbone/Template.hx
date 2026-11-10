package openbone;

/**
 * Text templates: `{name}`, `{name:0.00}`, `{{` / `}}` (core/template.ts). The patterns of the reference regular
 * expressions are matched by hand so every target behaves the same.
 */
class Template {
	/**
	 * Format a number with an Excel-like pattern ("0.00", "#,##0", "+0%", "$#,##0.00"), as
	 * `^([^#0]*?)(\+?)([#0,]+)(?:\.([0#]+))?(%?)(.*)$` (dot-all) splits it.
	 */
	public static function formatNumber(value:Float, pattern:String):String {
		var n = pattern.length;
		inline function ch(i:Int):String
			return i < n ? pattern.charAt(i) : "";
		// lazy prefix: the shortest one (no '#' or '0' in it) after which the rest matches
		var start = -1;
		var L = 0;
		while (L <= n) {
			var q = L;
			if (ch(q) == "+")
				q++;
			var c = ch(q);
			if (c == "#" || c == "0" || c == ",") {
				start = L;
				break;
			}
			var cl = ch(L);
			if (cl == "" || cl == "#" || cl == "0")
				break;
			L++;
		}
		if (start < 0)
			return plain(value) + pattern;
		var prefix = pattern.substr(0, start);
		var q = start;
		var plus = "";
		if (ch(q) == "+") {
			plus = "+";
			q++;
		}
		var i0 = q;
		while (ch(q) == "#" || ch(q) == "0" || ch(q) == ",")
			q++;
		var intPart = pattern.substring(i0, q);
		var frac = "";
		if (ch(q) == "." && (ch(q + 1) == "0" || ch(q + 1) == "#")) {
			var f0 = q + 1;
			q = f0;
			while (ch(q) == "0" || ch(q) == "#")
				q++;
			frac = pattern.substring(f0, q);
		}
		var pct = "";
		if (ch(q) == "%") {
			pct = "%";
			q++;
		}
		var suffix = pattern.substr(q);

		var v = pct != "" ? value * 100 : value;
		if (!Math.isFinite(v))
			return prefix + JsNum.toString(v) + pct + suffix;
		var minFrac = 0;
		while (minFrac < frac.length && frac.charAt(minFrac) == "0")
			minFrac++;
		var maxFrac = frac.length;
		var neg = v < 0;
		v = Math.abs(v);
		var s = JsNum.toFixed(v, maxFrac);
		if (maxFrac > minFrac) {
			var end = s.length;
			var keep = s.length - (maxFrac - minFrac);
			while (end > keep && s.charAt(end - 1) == "0")
				end--;
			s = s.substr(0, end);
			if (StringTools.endsWith(s, "."))
				s = s.substr(0, s.length - 1);
		}
		var dot = s.indexOf(".");
		var ip = dot < 0 ? s : s.substr(0, dot);
		var fp:String = dot < 0 ? null : s.substr(dot + 1);
		var minInt = 0;
		for (k in 0...intPart.length)
			if (intPart.charAt(k) == "0")
				minInt++;
		if (ip.length < minInt) {
			var b = new StringBuf();
			for (k in ip.length...minInt)
				b.add("0");
			ip = b.toString() + ip;
		} else if (minInt == 0 && ip == "0" && fp != null && fp.length > 0)
			ip = "";
		if (intPart.indexOf(",") >= 0)
			ip = thousands(ip);
		var all = ip + (fp == null ? "" : fp);
		var zero = true;
		for (k in 0...all.length) {
			var c = all.charCodeAt(k);
			if (c >= "1".code && c <= "9".code) {
				zero = false;
				break;
			}
		}
		var sign = neg && !zero ? "-" : plus != "" && !neg ? "+" : "";
		return prefix + sign + ip + (fp != null && fp.length > 0 ? "." + fp : "") + pct + suffix;
	}

	/** `s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")` for a string of digits. */
	static function thousands(s:String):String {
		// insert before every position p (not at a word boundary) where the digits from p to the end of the digit run
		// come in whole groups of three
		var b = new StringBuf();
		var n = s.length;
		inline function isDigit(i:Int):Bool {
			var c = s.charCodeAt(i);
			return c >= "0".code && c <= "9".code;
		}
		inline function isWord(i:Int):Bool {
			if (i < 0 || i >= n)
				return false;
			var c = s.charCodeAt(i);
			return (c >= "0".code && c <= "9".code) || (c >= "a".code && c <= "z".code) || (c >= "A".code && c <= "Z".code) || c == "_".code;
		}
		for (p in 0...n) {
			if (p > 0 && isWord(p - 1) == isWord(p)) {
				// \B holds; lookahead: (\d{3})+ then not a digit
				var run = 0;
				var k = p;
				while (k < n && isDigit(k)) {
					run++;
					k++;
				}
				if (run >= 3 && run % 3 == 0)
					b.add(",");
			}
			b.add(s.charAt(p));
		}
		return b.toString();
	}

	/** Default text for a value: numbers keep up to 6 decimals without trailing zeros. */
	public static function plain(v:Dynamic):String {
		if (JsNum.isNum(v)) {
			var d:Float = v;
			return Math.isFinite(d) ? JsNum.toString(Std.parseFloat(JsNum.toFixed(d, 6))) : JsNum.toString(d);
		}
		return JsNum.str(v);
	}

	public static function formatValue(v:Dynamic, pattern:String):String {
		if (JsNum.isNum(v) && pattern != null && pattern.length > 0)
			return formatNumber(v, pattern);
		return plain(v);
	}

	/**
	 * Fill a template; `lookup` returns null for unknown names (left as written). Tokens as
	 * `/\{\{|\}\}|\{([^{}:]+)(?::([^{}]*))?\}/g` finds them.
	 */
	public static function format(template:String, lookup:String->Dynamic):String {
		if (template.indexOf("{") < 0 && template.indexOf("}") < 0)
			return template;
		var out = new StringBuf();
		var n = template.length;
		var i = 0;
		while (i < n) {
			var c = template.charAt(i);
			if (c == "{" && i + 1 < n && template.charAt(i + 1) == "{") {
				out.add("{");
				i += 2;
				continue;
			}
			if (c == "}" && i + 1 < n && template.charAt(i + 1) == "}") {
				out.add("}");
				i += 2;
				continue;
			}
			if (c == "{") {
				// name: one or more of [^{}:]
				var k = i + 1;
				while (k < n) {
					var x = template.charAt(k);
					if (x == "{" || x == "}" || x == ":")
						break;
					k++;
				}
				if (k > i + 1 && k < n) {
					var name = template.substring(i + 1, k);
					var pattern:String = null;
					var close = -1;
					if (template.charAt(k) == "}")
						close = k;
					else if (template.charAt(k) == ":") {
						var j = k + 1;
						while (j < n && template.charAt(j) != "{" && template.charAt(j) != "}")
							j++;
						if (j < n && template.charAt(j) == "}") {
							pattern = template.substring(k + 1, j);
							close = j;
						}
					}
					if (close >= 0) {
						var whole = template.substring(i, close + 1);
						var v = lookup(StringTools.trim(name));
						out.add(v == null ? whole : formatValue(v, pattern));
						i = close + 1;
						continue;
					}
				}
			}
			out.add(c);
			i++;
		}
		return out.toString();
	}

	/** Linear map of v from [inMin, inMax] to [0, 1], clamped. */
	public static function bindingT(v:Float, inMin:Float, inMax:Float):Float {
		if (inMax == inMin)
			return v >= inMax ? 1 : 0;
		var t = (v - inMin) / (inMax - inMin);
		return t < 0 ? 0 : t > 1 ? 1 : t;
	}
}
