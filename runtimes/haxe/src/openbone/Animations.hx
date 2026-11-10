package openbone;

import openbone.AudioDirector;
import openbone.MathUtil;
import openbone.ParticleEmitter;
import openbone.Skeleton;
import openbone.data.Model;

private class Located {
	public var a:Key;
	public var b:Key;
	public var t = 0.0;

	public function new() {}
}

/** Timeline sampling and application (runtime/animation.ts). */
class Animations {
	static function locate(keys:Array<Key>, time:Float):Located {
		var l = new Located();
		if (time <= keys[0].time) {
			l.a = keys[0];
			return l;
		}
		var last = keys[keys.length - 1];
		if (time >= last.time) {
			l.a = last;
			return l;
		}
		var lo = 0, hi = keys.length - 1;
		while (hi - lo > 1) {
			var mid = (lo + hi) >> 1;
			if (keys[mid].time <= time)
				lo = mid;
			else
				hi = mid;
		}
		l.a = keys[lo];
		l.b = keys[hi];
		var span = l.b.time - l.a.time;
		var f = (time - l.a.time) / MathUtil.orOne(span);
		l.t = l.a.curve.apply(f);
		return l;
	}

	static inline function num(v:Dynamic):Float {
		return JsNum.toNumber(v);
	}

	public static function sampleNumber(keys:Array<Key>, time:Float):Float {
		var l = locate(keys, time);
		if (l.b == null || l.a.curve.isStepped())
			return num(l.a.value);
		return MathUtil.lerp(num(l.a.value), num(l.b.value), l.t);
	}

	static function floats(v:Dynamic):Array<Float> {
		return Std.isOfType(v, Array) ? (v : Array<Float>) : [];
	}

	public static function sampleArray(keys:Array<Key>, time:Float):Array<Float> {
		var l = locate(keys, time);
		var av = floats(l.a.value);
		if (l.b == null || l.a.curve.isStepped())
			return av;
		var bv = floats(l.b.value);
		var n = av.length > bv.length ? av.length : bv.length;
		return [
			for (i in 0...n)
				MathUtil.lerp(i < av.length ? av[i] : 0, i < bv.length ? bv[i] : 0, l.t)
		];
	}

	public static function sampleStep(keys:Array<Key>, time:Float):Dynamic {
		return locate(keys, time).a.value;
	}

	/** Local playback time for a total elapsed time. */
	public static function localTime(anim:AnimationData, total:Float, loop:Bool):Float {
		var d = anim.getDuration();
		if (d <= 0)
			return 0;
		if (loop)
			return ((total % d) + d) % d;
		return Math.min(Math.max(total, 0), d);
	}

	/** Pose the skeleton with an animation at local time `time`, mixed over the current pose by `alpha`. */
	public static function apply(sk:Skeleton, anim:AnimationData, time:Float, alpha:Float, ?mixOut:MixOut):Void {
		applyTimelines(sk, anim, anim.timelines, time, alpha, mixOut);
	}

	/** True for timelines whose values blend (a mix fades them); false for the ones that switch at keys. */
	static function blends(tl:Timeline):Bool {
		return switch (tl.target) {
			case "bone": tl.property != "inherit";
			case "slot": tl.property == "color" || tl.property == "dark";
			case "ik": tl.property != "bend" && tl.property != "stretch" && tl.property != "compress";
			case "transform" | "path" | "physics" | "deform": true;
			case "particles": tl.property == "rate";
			default: false;
		}
	}

	/** Whether any of `anims` has a keyed timeline for the same value as `tl` (same target, id, property and attachment). */
	public static function keyedBy(anims:Array<AnimationData>, tl:Timeline):Bool {
		for (a in anims)
			for (o in a.timelines)
				if (o.keys.length > 0 && o.target == tl.target && o.id == tl.id && o.property == tl.property && o.attachment == tl.attachment)
					return true;
		return false;
	}

	public static function applyTimelines(sk:Skeleton, anim:AnimationData, timelines:Array<Timeline>, time:Float, full:Float, ?mixOut:MixOut):Void {
		if (full <= 0)
			return;
		if (full >= 0.5 || sk.animationTime == null)
			sk.animationTime = time;
		for (tl in timelines) {
			if (tl.keys.length == 0)
				continue;
			var alpha = mixOut != null && blends(tl) && !keyedBy(mixOut.into, tl) ? mixOut.alpha : full;
			if (alpha <= 0)
				continue;
			switch (tl.target) {
				case "bone":
					var bone = sk.boneById(tl.id);
					if (bone == null)
						continue;
					if (tl.property == "inherit") {
						if (alpha >= 0.5)
							bone.inherit = Inherit.parse(JsNum.str(sampleStep(tl.keys, time)));
						continue;
					}
					var v = sampleNumber(tl.keys, time);
					var prop = tl.property;
					var cur = bone.get(prop);
					bone.set(prop, alpha >= 1 ? v : prop == "rotation" ? MathUtil.lerpAngle(cur, v, alpha) : MathUtil.lerp(cur, v, alpha));
				case "slot":
					var slot = sk.slotById(tl.id);
					if (slot == null)
						continue;
					if (tl.property == "color" || tl.property == "dark") {
						var l = locate(tl.keys, time);
						var ca = MathUtil.parseHex(l.a.value);
						var v = l.b == null || l.a.curve.isStepped() ? ca : MathUtil.lerpColor(ca, MathUtil.parseHex(l.b.value), l.t);
						if (tl.property == "color")
							slot.color = alpha >= 1 ? v : MathUtil.lerpColor(slot.color, v, alpha);
						else
							slot.dark = alpha >= 1 ? v : MathUtil.lerpColor(slot.dark != null ? slot.dark : [0, 0, 0, 1], v, alpha);
					} else if (alpha >= 0.5) {
						var v:Dynamic = sampleStep(tl.keys, time);
						slot.attachmentName = v == null ? null : JsNum.str(v);
					}
				case "ik" | "transform" | "path" | "physics":
					var values = sk.constraintValues.get(tl.id);
					if (values == null)
						continue;
					var prop = tl.property;
					if (tl.target == "ik" && (prop == "bend" || prop == "stretch" || prop == "compress")) {
						if (alpha >= 0.5)
							values.put(prop, num(sampleStep(tl.keys, time)));
					} else
						values.put(prop, MathUtil.lerp(values.getOr(prop, 0), sampleNumber(tl.keys, time), alpha));
				case "particles":
					var slot = sk.slotById(tl.id);
					if (slot == null)
						continue;
					var cur = sk.particleValues.get(tl.id);
					if (cur == null)
						cur = new ParticleValues();
					if (tl.property == "emitting") {
						if (alpha >= 0.5) {
							var v:Dynamic = sampleStep(tl.keys, time);
							cur.emitting = v == null ? null : JsNum.truthy(v);
						}
					} else {
						var att = sk.getAttachment(slot);
						var base:Float = cur.rate != null ? (cur.rate : Float) : Std.isOfType(att, ParticlesAttachment) ? (cast att : ParticlesAttachment).rate : 0;
						cur.rate = MathUtil.lerp(base, sampleNumber(tl.keys, time), alpha);
					}
					sk.particleValues.set(tl.id, cur);
				case "deform":
					var slot = sk.slotById(tl.id);
					if (slot == null)
						continue;
					var v = sampleArray(tl.keys, time);
					var cur = slot.deform.get(tl.attachment);
					var out:Array<Float>;
					if (cur != null && alpha < 1)
						out = [for (i in 0...v.length) MathUtil.lerp(i < cur.length ? cur[i] : 0, v[i], alpha)];
					else if (alpha < 1)
						out = [for (i in 0...v.length) v[i] * alpha];
					else
						out = v.copy();
					slot.deform.set(tl.attachment, out);
				case "sequence":
					var slot = sk.slotById(tl.id);
					if (slot == null)
						continue;
					if (alpha >= 0.5)
						slot.sequenceFrames.set(tl.attachment, sampleNumber(tl.keys, time));
				case "drawOrder":
					if (alpha < 0.5)
						continue;
					var ov:Dynamic = sampleStep(tl.keys, time);
					var order:Array<String> = Std.isOfType(ov, Array) ? (ov : Array<String>) : [];
					var listed:Array<Slot> = [];
					for (id in order) {
						var s = id == null ? null : sk.slotById(id);
						if (s != null)
							listed.push(s);
					}
					var out:Array<Slot> = [for (i in 0...sk.slots.length) null];
					for (i in 0...out.length)
						if (listed.indexOf(sk.slots[i]) < 0)
							out[i] = sk.slots[i];
					var next = 0;
					var i = 0;
					while (i < out.length && next < listed.length) {
						if (out[i] == null)
							out[i] = listed[next++];
						i++;
					}
					sk.drawOrder = [for (s in out) if (s != null) s];
				default:
			}
		}
	}

	/** Event keys crossed when total time moves from prev (exclusive) to next (inclusive). */
	public static function eventsBetween(doc:OpenBoneDocument, anim:AnimationData, prev:Float, next:Float, loop:Bool):Array<FiredEvent> {
		var out:Array<FiredEvent> = [];
		if (anim.events.length == 0 || next <= prev)
			return out;
		var d = anim.getDuration();
		for (k in anim.events) {
			var ev = doc.eventById(k.event);
			if (ev == null)
				continue;
			if (!loop || d <= 0) {
				if (k.time > prev && k.time <= next)
					out.push(fire(k, ev, anim));
				continue;
			}
			var c = Math.ffloor(prev / d), lastC = Math.ffloor(next / d);
			while (c <= lastC) {
				var at = c * d + k.time;
				if (at > prev && at <= next)
					out.push(fire(k, ev, anim));
				c++;
			}
		}
		return out;
	}

	static function fire(k:EventKey, ev:EventData, anim:AnimationData):FiredEvent {
		return new FiredEvent(ev.name, ev.id, k.time, k.intValue != null ? (k.intValue : Float) : ev.intValue,
			k.floatValue != null ? (k.floatValue : Float) : ev.floatValue, k.stringValue != null ? k.stringValue : ev.stringValue,
			ev.audio != null && ev.audio.length > 0 ? ev.audio : null, ev.volume, anim.name);
	}
}
