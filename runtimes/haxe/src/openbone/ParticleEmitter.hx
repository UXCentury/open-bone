package openbone;

import haxe.Int32;
import openbone.MathUtil;
import openbone.data.Model;

/** Seedable PRNG (mulberry32), identical on every platform. */
class Rng {
	var s:Int32;

	public function new(seed:Int) {
		s = seed;
	}

	public function next():Float {
		s = s + (0x6d2b79f5 : Int32);
		var t:Int32 = s;
		t = (t ^ (t >>> 15)) * (t | 1);
		t ^= t + (t ^ (t >>> 7)) * (t | 61);
		var u:Int = (t ^ (t >>> 14));
		return (u < 0 ? u + 4294967296.0 : u) / 4294967296.0;
	}

	public function range(r:Array<Float>):Float {
		return r[0] == r[1] ? r[0] : r[0] + (r[1] - r[0]) * next();
	}

	public function between(a:Float, b:Float):Float {
		return a + (b - a) * next();
	}
}

/** One live particle (world space, or slot-bone space for local emitters). */
class Particle {
	public var x = 0.0;
	public var y = 0.0;
	public var vx = 0.0;
	public var vy = 0.0;
	public var age = 0.0;
	public var life = 0.0;
	public var size0 = 0.0;
	public var size1 = 0.0;
	public var rot0 = 0.0;
	public var rot1 = 0.0;
	public var spin = 0.0;

	public function new() {}
}

/** Live keyable values; null fields fall back to the attachment's. */
class ParticleValues {
	public var emitting:Null<Bool>;
	public var rate:Null<Float>;

	public function new() {}

	public function copy():ParticleValues {
		var v = new ParticleValues();
		v.emitting = emitting;
		v.rate = rate;
		return v;
	}
}

/** Quads TL, TR, BR, BL with unit uvs and per-vertex RGBA (float32 values held in doubles). */
class ParticleGeometry {
	public var count = 0;
	public var vertices:Array<Float>;
	public var uvs:Array<Float>;
	public var colors:Array<Float>;
	public var indices:Array<Int>;

	public function new() {}
}

/**
 * Simulation state of one particles attachment on one slot (runtime/particles.ts). Advanced in fixed steps; the result
 * depends only on the seed and the sequence of (bone transform, values) per step.
 */
class ParticleEmitter {
	/** Fixed simulation step (seconds). */
	public static inline final STEP = 1.0 / 60;

	/** Most steps taken in one realtime frame. */
	public static inline final MAX_STEPS = 30;

	static inline final MAX_PREWARM_STEPS = 600;
	static inline final EPS = 1e-9;

	/** FNV-1a over UTF-16 code units, unsigned 32-bit (returned in an Int). */
	public static function hashString(s:String):Int {
		var h:Int32 = 0x811c9dc5;
		for (u in utf16Units(s))
			h = (h ^ u) * (0x01000193 : Int32);
		return h;
	}

	/** UTF-16 code units of a string, whatever the target's string encoding. */
	static function utf16Units(s:String):Array<Int> {
		var out:Array<Int> = [];
		#if (js || java || cs || flash || hl)
		for (i in 0...s.length)
			out.push(StringTools.fastCodeAt(s, i));
		#else
		for (i in 0...s.length) {
			var c = s.charCodeAt(i);
			if (c >= 0x10000) {
				c -= 0x10000;
				out.push(0xD800 + (c >> 10));
				out.push(0xDC00 + (c & 0x3ff));
			} else
				out.push(c);
		}
		#end
		return out;
	}

	/** ECMAScript ToInt32. */
	public static function toInt32(v:Float):Int {
		if (!Math.isFinite(v))
			return 0;
		var t = v < 0 ? Math.fceil(v) : Math.ffloor(v);
		var m = t % 4294967296.0;
		if (m < 0)
			m += 4294967296.0;
		if (m >= 2147483648.0)
			m -= 4294967296.0;
		return Std.int(m);
	}

	public final data:ParticlesAttachment;
	public final particles:Array<Particle> = [];
	public var cycle = 0.0;
	public var steps = 0;

	/** Particles requested by emitParticles(), spawned on the next step. */
	public var pending = 0.0;

	var acc = 0.0;
	var wasEmitting = false;
	final rng:Rng;
	var lastX = Math.NaN;
	var lastY = Math.NaN;

	public function new(data:ParticlesAttachment, salt:Int) {
		this.data = data;
		rng = new Rng(toInt32(data.seed) ^ salt);
	}

	public inline function alive():Int {
		return particles.length;
	}

	/** Restart the emitter cycle (bursts at time 0 fire again on the next step). */
	public function restart():Void {
		cycle = 0;
		acc = 0;
		wasEmitting = false;
	}

	public function step(h:Float, m:Affine, values:ParticleValues):Void {
		var d = data;
		var emitting = values != null && values.emitting != null ? (values.emitting : Bool) : d.emitting;
		var rate = values != null && values.rate != null ? (values.rate : Float) : d.rate;
		if (steps == 0 && emitting && d.prewarm && d.loop) {
			var n = Std.int(Math.min(MAX_PREWARM_STEPS, Math.ceil(d.duration / h - 1e-6)));
			lastX = m.x;
			lastY = m.y;
			for (i in 0...n)
				advance(h, m, true, rate);
		}
		advance(h, m, emitting, rate);
		steps++;
	}

	function advance(h:Float, m:Affine, emitting:Bool, rate:Float):Void {
		var d = data;
		var damp = d.drag > 0 ? Math.exp(-d.drag * h) : 1;
		var g = d.gravity * h;
		var w = 0;
		var ps = particles;
		for (i in 0...ps.length) {
			var p = ps[i];
			p.age += h;
			if (p.age >= p.life)
				continue;
			p.vy -= g;
			p.vx *= damp;
			p.vy *= damp;
			p.x += p.vx * h;
			p.y += p.vy * h;
			ps[w++] = p;
		}
		ps.resize(w);

		if (emitting && !wasEmitting) {
			cycle = 0;
			acc = 0;
		}
		wasEmitting = emitting;
		var active = emitting && (d.loop || cycle < d.duration);
		var streamed = 0.0;
		var burst = pending;
		pending = 0;
		if (active) {
			acc += Math.max(0, rate) * h;
			streamed = Math.ffloor(acc);
			acc -= streamed;
			var start = cycle, end = start + h;
			var wraps = end >= d.duration - EPS;
			var rest = end - d.duration;
			for (b in d.bursts) {
				if (b.time > d.duration + EPS)
					continue;
				if (b.time >= start - EPS && b.time < end - EPS)
					burst += b.count;
				else if (wraps && d.loop && b.time < rest - EPS)
					burst += b.count;
			}
			cycle = wraps ? (d.loop ? Math.max(0, rest) : d.duration) : end;
		}
		var room = Math.max(0, d.maxParticles - ps.length);
		var nb = Math.min(burst, room);
		var ns = Math.min(streamed, room - nb);
		var lx = Math.isNaN(lastX) ? m.x : lastX;
		var ly = Math.isNaN(lastY) ? m.y : lastY;
		var i = 0;
		while (i < nb) {
			spawn(m, 0, m.x, m.y);
			i++;
		}
		i = 0;
		while (i < ns) {
			var k = (i + 1) / ns;
			spawn(m, (1 - k) * h, MathUtil.lerp(lx, m.x, k), MathUtil.lerp(ly, m.y, k));
			i++;
		}
		lastX = m.x;
		lastY = m.y;
	}

	function spawn(m:Affine, preAge:Float, ox:Float, oy:Float):Void {
		var d = data;
		var r = rng;
		var rot = d.rotation * MathUtil.DEG;
		var half = (d.angle / 2) * MathUtil.DEG;
		var f = 0.0, s = 0.0;
		var dir = rot + r.between(-half, half);
		switch (d.shape) {
			case "circle":
				var a = r.next() * Math.PI * 2;
				var rad = Math.sqrt(r.next()) * d.radius;
				f = Math.cos(a) * rad;
				s = Math.sin(a) * rad;
				dir = rot + a;
			case "box":
				s = r.between(-d.width / 2, d.width / 2);
				f = r.between(-d.height / 2, d.height / 2);
			case "cone":
				s = r.between(-d.radius, d.radius);
				if (d.radius > 0)
					dir = rot + (s / d.radius) * half;
			default:
		}
		var cos = Math.cos(rot), sin = Math.sin(rot);
		var x = d.x + f * cos - s * sin;
		var y = d.y + f * sin + s * cos;
		var speed = r.range(d.speed);
		var vx = Math.cos(dir) * speed, vy = Math.sin(dir) * speed;
		if (d.space == "world") {
			var wx = m.a * x + m.b * y + ox, wy = m.c * x + m.d * y + oy;
			x = wx;
			y = wy;
			var tx = m.a * vx + m.b * vy, ty = m.c * vx + m.d * vy;
			var len = MathUtil.hypot(tx, ty);
			vx = len > 1e-9 ? (tx / len) * speed : 0;
			vy = len > 1e-9 ? (ty / len) * speed : 0;
		}
		var p = new Particle();
		p.x = x;
		p.y = y;
		p.vx = vx;
		p.vy = vy;
		p.life = Math.max(1e-3, r.range(d.lifetime));
		p.size0 = r.range(d.startSize);
		p.size1 = r.range(d.endSize);
		p.rot0 = r.range(d.startRotation);
		p.rot1 = r.range(d.endRotation);
		p.spin = r.range(d.angularVelocity);
		if (preAge > 0) {
			p.age = preAge;
			p.vy -= d.gravity * preAge;
			p.x += p.vx * preAge;
			p.y += p.vy * preAge;
		}
		if (p.age < p.life)
			particles.push(p);
	}

	/** Colour of the gradient at life fraction t. */
	public static function gradientColor(stops:Array<ColorStop>, t:Float):Array<Float> {
		if (stops.length == 0)
			return [1, 1, 1, 1];
		var sorted = stops;
		var unsorted = false;
		for (i in 1...stops.length)
			if (stops[i].t < stops[i - 1].t)
				unsorted = true;
		if (stops.length > 1 && unsorted) {
			sorted = stops.copy();
			haxe.ds.ArraySort.sort(sorted, (a, b) -> {
				var x = a.t - b.t;
				return x < 0 ? -1 : x > 0 ? 1 : 0;
			});
		}
		if (t <= sorted[0].t)
			return MathUtil.parseHex(sorted[0].color);
		var last = sorted[sorted.length - 1];
		if (t >= last.t)
			return MathUtil.parseHex(last.color);
		for (i in 1...sorted.length) {
			var b = sorted[i];
			if (t <= b.t) {
				var a = sorted[i - 1];
				var span = b.t - a.t;
				return MathUtil.lerpColor(MathUtil.parseHex(a.color), MathUtil.parseHex(b.color), (t - a.t) / (span == 0 ? 1 : span));
			}
		}
		return MathUtil.parseHex(last.color);
	}

	/** Quads `frac` seconds after the last step; `m` is the slot bone's world matrix, `tint` the slot colour. */
	public function geometry(frac:Float, m:Affine, tint:Array<Float>):ParticleGeometry {
		var d = data;
		var ps = particles;
		var n = Std.int(Math.min(ps.length, 16383));
		var vertices:Array<Float> = [], colors:Array<Float> = [], uvs:Array<Float> = [];
		var indices:Array<Int> = [];
		var local = d.space == "local";
		var sizeScale = local ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
		var k = 0;
		for (i in 0...n) {
			var p = ps[i];
			var age = Math.min(p.age + frac, p.life);
			var t = age / p.life;
			var x = p.x + p.vx * frac, y = p.y + p.vy * frac, vx = p.vx, vy = p.vy;
			if (local) {
				var wx = m.a * x + m.b * y + m.x, wy = m.c * x + m.d * y + m.y;
				x = wx;
				y = wy;
				var tx = m.a * vx + m.b * vy;
				vy = m.c * vx + m.d * vy;
				vx = tx;
			}
			var size = Math.max(0, MathUtil.lerp(p.size0, p.size1, t)) * sizeScale;
			var c = gradientColor(d.colors, t);
			var a = c[3] * tint[3];
			if (size <= 0 || a <= 0)
				continue;
			var ux:Float, uy:Float, hw:Float;
			if (d.look == "spark") {
				var sp = MathUtil.hypot(vx, vy);
				var len = size / 2 + (sp * d.stretch) / 2;
				var ang = sp > 1e-6 ? Math.atan2(vy, vx) : (MathUtil.lerp(p.rot0, p.rot1, t) + p.spin * age) * MathUtil.DEG;
				ux = Math.cos(ang) * len;
				uy = Math.sin(ang) * len;
				hw = size / 2;
			} else {
				var ang = (MathUtil.lerp(p.rot0, p.rot1, t) + p.spin * age) * MathUtil.DEG;
				ux = (Math.cos(ang) * size) / 2;
				uy = (Math.sin(ang) * size) / 2;
				hw = size / 2;
			}
			var ul = MathUtil.hypot(ux, uy);
			if (ul == 0 || Math.isNaN(ul))
				ul = 1;
			var vx2 = (-uy / ul) * hw, vy2 = (ux / ul) * hw;
			vertices.push(JsNum.f32(x - ux + vx2));
			vertices.push(JsNum.f32(y - uy + vy2));
			vertices.push(JsNum.f32(x + ux + vx2));
			vertices.push(JsNum.f32(y + uy + vy2));
			vertices.push(JsNum.f32(x + ux - vx2));
			vertices.push(JsNum.f32(y + uy - vy2));
			vertices.push(JsNum.f32(x - ux - vx2));
			vertices.push(JsNum.f32(y - uy - vy2));
			for (u in [0.0, 0, 1, 0, 1, 1, 0, 1])
				uvs.push(u);
			var r = JsNum.f32(c[0] * tint[0]), gg = JsNum.f32(c[1] * tint[1]), b = JsNum.f32(c[2] * tint[2]), af = JsNum.f32(a);
			for (j in 0...4) {
				colors.push(r);
				colors.push(gg);
				colors.push(b);
				colors.push(af);
			}
			var base = k * 4;
			indices.push(base);
			indices.push(base + 1);
			indices.push(base + 2);
			indices.push(base);
			indices.push(base + 2);
			indices.push(base + 3);
			k++;
		}
		var geo = new ParticleGeometry();
		geo.count = k;
		geo.vertices = vertices;
		geo.uvs = uvs;
		geo.colors = colors;
		geo.indices = indices;
		return geo;
	}
}
