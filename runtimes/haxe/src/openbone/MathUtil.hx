package openbone;

import openbone.data.Model;

/** 2D affine transform `[a b; c d | x y]`: maps local (lx, ly) to (a·lx + b·ly + x, c·lx + d·ly + y). */
class Affine {
	public var a:Float;
	public var b:Float;
	public var c:Float;
	public var d:Float;
	public var x:Float;
	public var y:Float;

	public function new(a = 1.0, b = 0.0, c = 0.0, d = 1.0, x = 0.0, y = 0.0) {
		this.a = a;
		this.b = b;
		this.c = c;
		this.d = d;
		this.x = x;
		this.y = y;
	}

	public function copy():Affine {
		return new Affine(a, b, c, d, x, y);
	}

	public function set(m:Affine):Void {
		a = m.a;
		b = m.b;
		c = m.c;
		d = m.d;
		x = m.x;
		y = m.y;
	}

	public static function multiply(p:Affine, l:Affine):Affine {
		return new Affine(p.a * l.a + p.b * l.c, p.a * l.b + p.b * l.d, p.c * l.a + p.d * l.c, p.c * l.b + p.d * l.d, p.a * l.x + p.b * l.y + p.x,
			p.c * l.x + p.d * l.y + p.y);
	}

	public function invert():Affine {
		var det = a * d - b * c;
		if (det == 0)
			det = 1e-9;
		var ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
		return new Affine(ia, ib, ic, id, -(ia * x + ib * y), -(ic * x + id * y));
	}

	public inline function applyX(lx:Float, ly:Float):Float {
		return a * lx + b * ly + x;
	}

	public inline function applyY(lx:Float, ly:Float):Float {
		return c * lx + d * ly + y;
	}

	/** Rotation of the X axis in degrees. */
	public function rotation():Float {
		return Math.atan2(c, a) * MathUtil.RAD;
	}

	public function scaleX():Float {
		return MathUtil.hypot(a, c);
	}

	public function scaleY():Float {
		return MathUtil.hypot(b, d);
	}

	public function toString():String {
		return "[" + a + ", " + b + ", " + c + ", " + d + " | " + x + ", " + y + "]";
	}
}

/** A bone's local pose values. */
class LocalTransform {
	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;
	public var shearX = 0.0;
	public var shearY = 0.0;

	public function new() {}

	public function set(o:LocalTransform):Void {
		x = o.x;
		y = o.y;
		rotation = o.rotation;
		scaleX = o.scaleX;
		scaleY = o.scaleY;
		shearX = o.shearX;
		shearY = o.shearY;
	}
}

/** core/math.ts: matrices, inherit modes, angles, colours, hit tests. */
class MathUtil {
	public static inline final DEG = 0.017453292519943295; // Math.PI / 180
	public static inline final RAD = 57.29577951308232; // 180 / Math.PI

	/** `Math.hypot(a, b)` (two arguments). */
	public static inline function hypot(a:Float, b:Float):Float {
		return Math.sqrt(a * a + b * b);
	}

	public static function localMatrix(x:Float, y:Float, rotation:Float, scaleX:Float, scaleY:Float, shearX:Float, shearY:Float):Affine {
		var rx = (rotation + shearX) * DEG;
		var ry = (rotation + 90 + shearY) * DEG;
		return new Affine(Math.cos(rx) * scaleX, Math.cos(ry) * scaleY, Math.sin(rx) * scaleX, Math.sin(ry) * scaleY, x, y);
	}

	/** World matrix of a bone from its parent's (null = none) and its local pose, by inherit mode. */
	public static function boneWorldOf(parent:Affine, t:LocalTransform, inherit:Inherit):Affine {
		return boneWorld(parent, t.x, t.y, t.rotation, t.scaleX, t.scaleY, t.shearX, t.shearY, inherit);
	}

	public static function boneWorld(parent:Affine, x:Float, y:Float, rotation:Float, scaleX:Float, scaleY:Float, shearX:Float, shearY:Float,
			inherit:Inherit):Affine {
		var l = localMatrix(x, y, rotation, scaleX, scaleY, shearX, shearY);
		if (parent == null)
			return l;
		var wx = parent.applyX(x, y), wy = parent.applyY(x, y);
		switch (inherit) {
			case OnlyTranslation:
				l.x = wx;
				l.y = wy;
				return l;
			case NoRotation:
				var sx = hypot(parent.a, parent.c);
				var sy = hypot(parent.b, parent.d);
				return new Affine(l.a * sx, l.b * sy, l.c * sx, l.d * sy, wx, wy);
			case NoScale:
				var sx = hypot(parent.a, parent.c);
				if (sx == 0)
					sx = 1;
				var sy = hypot(parent.b, parent.d);
				if (sy == 0)
					sy = 1;
				var p = new Affine(parent.a / sx, parent.b / sy, parent.c / sx, parent.d / sy, 0, 0);
				var m = Affine.multiply(p, l);
				m.x = wx;
				m.y = wy;
				return m;
			default:
				return Affine.multiply(parent, l);
		}
	}

	/** Local values putting a bone at `childWorld` under `parentWorld`; shear X kept from `keep`. */
	public static function localFromWorld(parentWorld:Affine, childWorld:Affine, inherit:Inherit, keep:LocalTransform):Void {
		var inv = parentWorld.invert();
		var x = inv.applyX(childWorld.x, childWorld.y), y = inv.applyY(childWorld.x, childWorld.y);
		if (inherit != Normal) {
			keep.x = x;
			keep.y = y;
			return;
		}
		var m = Affine.multiply(inv, childWorld);
		var rotation = Math.atan2(m.c, m.a) * RAD - keep.shearX;
		var scaleX = hypot(m.a, m.c);
		var scaleY = hypot(m.b, m.d);
		var shearY = wrapDeg(Math.atan2(m.d, m.b) * RAD - 90 - rotation);
		keep.x = x;
		keep.y = y;
		keep.rotation = wrapDeg(rotation);
		keep.scaleX = scaleX;
		keep.scaleY = scaleY;
		keep.shearY = shearY;
	}

	/** Wrap degrees into (-180, 180] (JS `%` semantics). */
	public static function wrapDeg(d:Float):Float {
		d = d % 360;
		if (d > 180)
			d -= 360;
		else if (d <= -180)
			d += 360;
		return d;
	}

	public static inline function lerp(a:Float, b:Float, t:Float):Float {
		return a + (b - a) * t;
	}

	public static inline function lerpAngle(a:Float, b:Float, t:Float):Float {
		return a + wrapDeg(b - a) * t;
	}

	public static inline function clamp(v:Float, lo:Float, hi:Float):Float {
		return v < lo ? lo : v > hi ? hi : v;
	}

	/** `Math.sign(det) || 1`. */
	public static function detSign(m:Affine):Float {
		var det = m.a * m.d - m.b * m.c;
		return det > 0 ? 1 : det < 0 ? -1 : 1;
	}

	/** `x || 1` for a number. */
	public static inline function orOne(v:Float):Float {
		return v == 0 || Math.isNaN(v) ? 1 : v;
	}

	// ---------------- Colours ----------------

	/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" to RGBA 0..1 (not premultiplied). */
	public static function parseHex(hex:String):Array<Float> {
		var h = hex == null ? "" : hex;
		var i = h.indexOf("#");
		if (i >= 0)
			h = h.substr(0, i) + h.substr(i + 1);
		if (h.length == 3 || h.length == 4) {
			var b = new StringBuf();
			for (k in 0...h.length) {
				b.add(h.charAt(k));
				b.add(h.charAt(k));
			}
			h = b.toString();
		}
		return [hexByte(h, 0), hexByte(h, 2), hexByte(h, 4), h.length >= 8 ? hexByte(h, 6) : 1];
	}

	/** `parseInt(h.slice(i, i + 2), 16) / 255` with parseInt's prefix rules (NaN when no digit). */
	static function hexByte(h:String, i:Int):Float {
		if (i >= h.length)
			return Math.NaN;
		var s = StringTools.trim(h.substring(i, Std.int(Math.min(h.length, i + 2))));
		var v = 0, n = 0;
		for (k in 0...s.length) {
			var c = s.charCodeAt(k);
			var dgt = c >= "0".code && c <= "9".code ? c - "0".code : c >= "a".code && c <= "f".code ? c - "a".code + 10 : c >= "A".code
				&& c <= "F".code ? c - "A".code + 10 : -1;
			if (dgt < 0)
				break;
			v = v * 16 + dgt;
			n++;
		}
		return n == 0 ? Math.NaN : v / 255.0;
	}

	public static function lerpColor(a:Array<Float>, b:Array<Float>, t:Float):Array<Float> {
		return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
	}

	public static function mulColor(a:Array<Float>, b:Array<Float>):Array<Float> {
		return [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
	}

	/** Even-odd point in polygon (flat x,y). */
	public static function pointInPolygon(px:Float, py:Float, poly:Array<Float>):Bool {
		var inside = false;
		var n = Std.int(poly.length / 2);
		var j = n - 1;
		for (i in 0...n) {
			var xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
			if ((yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
				inside = !inside;
			j = i;
		}
		return inside;
	}
}
