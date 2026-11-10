package openbone;

/** Point and tangent angle (radians) at a distance along a path. */
class SplineSample {
	public final x:Float;
	public final y:Float;
	public final angle:Float;

	public function new(x:Float, y:Float, angle:Float) {
		this.x = x;
		this.y = y;
		this.angle = angle;
	}
}

/** Cubic bezier path for path attachments, measured by arc length (core/path.ts buildSpline). */
class Spline {
	static inline final STEPS = 32;

	public final closed:Bool;
	public final length:Float;
	public final segments:Int;

	final knots:Int;
	final ctrl:Array<Float>;
	final table:Array<Float>;
	final vertices:Array<Float>;

	/** Knots are `[inX, inY, x, y, outX, outY]` each. */
	public function new(vertices:Array<Float>, closed:Bool) {
		this.vertices = vertices;
		this.closed = closed;
		knots = Std.int(vertices.length / 6);
		var segCount = knots < 2 ? 0 : closed ? knots : knots - 1;
		segments = segCount;
		ctrl = [for (i in 0...(segCount > 1 ? segCount : 1) * 8) 0.0];
		for (s in 0...segCount) {
			var a = s * 6, b = ((s + 1) % knots) * 6, o = s * 8;
			ctrl[o] = vertices[a + 2];
			ctrl[o + 1] = vertices[a + 3];
			ctrl[o + 2] = vertices[a + 4];
			ctrl[o + 3] = vertices[a + 5];
			ctrl[o + 4] = vertices[b];
			ctrl[o + 5] = vertices[b + 1];
			ctrl[o + 6] = vertices[b + 2];
			ctrl[o + 7] = vertices[b + 3];
		}
		table = [for (i in 0...segCount * STEPS + 1) 0.0];
		var total = 0.0;
		for (s in 0...segCount) {
			var o = s * 8;
			var px = ctrl[o], py = ctrl[o + 1];
			for (i in 1...STEPS + 1) {
				var t = i / STEPS;
				var x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
				var y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
				total += MathUtil.hypot(x - px, y - py);
				table[s * STEPS + i] = total;
				px = x;
				py = y;
			}
		}
		length = total;
	}

	static inline function bez(a:Float, b:Float, c:Float, d:Float, t:Float):Float {
		var u = 1 - t;
		return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
	}

	static inline function bezD(a:Float, b:Float, c:Float, d:Float, t:Float):Float {
		var u = 1 - t;
		return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
	}

	function point(s:Int, t:Float):SplineSample {
		var o = s * 8;
		var x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
		var y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
		var dx = bezD(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
		var dy = bezD(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
		if (dx * dx + dy * dy < 1e-12) {
			var t0 = Math.max(0, t - 1e-3), t1 = Math.min(1, t + 1e-3);
			dx = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t1) - bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t0);
			dy = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t1) - bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t0);
			if (dx * dx + dy * dy < 1e-18) {
				dx = ctrl[o + 6] - ctrl[o];
				dy = ctrl[o + 7] - ctrl[o + 1];
			}
		}
		return new SplineSample(x, y, Math.atan2(dy, dx));
	}

	/** Open paths extend straight past their ends; closed paths wrap. */
	public function sample(distance:Float):SplineSample {
		if (segments == 0) {
			var x = knots > 0 ? vertices[2] : 0, y = knots > 0 ? vertices[3] : 0;
			return new SplineSample(x, y, 0);
		}
		var d = distance;
		if (closed && length > 0)
			d = ((d % length) + length) % length;
		else if (d <= 0 || d >= length) {
			var end = d <= 0 ? point(0, 0) : point(segments - 1, 1);
			var over = d <= 0 ? d : d - length;
			return new SplineSample(end.x + Math.cos(end.angle) * over, end.y + Math.sin(end.angle) * over, end.angle);
		}
		var lo = 0, hi = table.length - 1;
		while (hi - lo > 1) {
			var mid = (lo + hi) >> 1;
			if (table[mid] <= d)
				lo = mid;
			else
				hi = mid;
		}
		var span = table[hi] - table[lo];
		var f = span > 0 ? (d - table[lo]) / span : 0;
		var seg = Std.int(Math.min(segments - 1, Math.floor(lo / STEPS)));
		var t = (lo - seg * STEPS + f) / STEPS;
		return point(seg, Math.min(1, t));
	}
}
