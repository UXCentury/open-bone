package openbone;

import haxe.ds.ObjectMap;
import openbone.DrawItem;
import openbone.MathUtil;
import openbone.ParticleEmitter;
import openbone.Spline;
import openbone.data.Model;

/** Live constraint values by property name. */
class ConstraintValues {
	final map:Map<String, Float> = new Map();

	public function new() {}

	public function getOr(prop:String, def:Float):Float {
		var v = map.get(prop);
		return v != null ? v : def;
	}

	public function get(prop:String):Null<Float> {
		return map.get(prop);
	}

	public function put(prop:String, v:Float):Void {
		map.set(prop, v);
	}
}

/** Linear map from 0..1 image uvs to page uvs. */
class UvMap {
	final ou:Float;
	final ov:Float;
	final su:Float;
	final sv:Float;
	final rotated:Bool;

	public function new(ou:Float, ov:Float, su:Float, sv:Float, rotated:Bool) {
		this.ou = ou;
		this.ov = ov;
		this.su = su;
		this.sv = sv;
		this.rotated = rotated;
	}

	public static function of(r:AtlasRegion, page:AtlasPage):UvMap {
		if (r.rotated)
			return new UvMap((r.x + r.height + r.offsetY) / page.width, (r.y - r.offsetX) / page.height, r.originalHeight / page.width,
				r.originalWidth / page.height, true);
		return new UvMap((r.x - r.offsetX) / page.width, (r.y - r.offsetY) / page.height, r.originalWidth / page.width, r.originalHeight / page.height,
			false);
	}

	public function remap(uvs:Array<Float>):Array<Float> {
		var out:Array<Float> = [for (i in 0...uvs.length) 0.0];
		var i = 0;
		while (i + 1 < uvs.length) {
			var u = uvs[i], v = uvs[i + 1];
			out[i] = JsNum.f32(rotated ? ou - v * su : ou + u * su);
			out[i + 1] = JsNum.f32(rotated ? ov + u * sv : ov + v * sv);
			i += 2;
		}
		return out;
	}
}

private class Packed {
	public var page:TextureRef;
	public var rect:Array<Float>;
	public var map:UvMap;
	public var regionUvs:Array<Float>;
	public var trim:Array<Float>;
	public var polyImage:Array<Float>;
	public var polyUvs:Array<Float>;
	public var polyIndices:Array<Int>;

	public function new() {}
}

private class White {
	public var page:TextureRef;
	public var u = 0.0;
	public var v = 0.0;

	public function new() {}
}

private class PhysicsParticle {
	public var x:Float;
	public var y:Float;
	public var vx = 0.0;
	public var vy = 0.0;
	public var px:Float;
	public var py:Float;

	public function new(x:Float, y:Float) {
		this.x = x;
		this.y = y;
		px = x;
		py = y;
	}
}

private class PhysicsState {
	public var origin:PhysicsParticle;
	public var tip:PhysicsParticle;
	public var lastOx = 0.0;
	public var lastOy = 0.0;
	public var lastTx = 0.0;
	public var lastTy = 0.0;
	public var time = 0.0;
	public var steps = 0.0;

	public function new() {}
}

private class Cached {
	public final key:String;
	public final indices:Array<Int>;

	public function new(key:String, indices:Array<Int>) {
		this.key = key;
		this.indices = indices;
	}
}

/**
 * Pose state of one document: bones, slots, skin, constraint values, physics and particles; produces the draw list.
 * Port of runtime/skeleton.ts (docs/runtime-spec.md §2–§8).
 */
class Skeleton {
	public static final REGION_UVS:Array<Float> = [0, 0, 1, 0, 1, 1, 0, 1];
	public static final REGION_INDICES:Array<Int> = [0, 1, 2, 0, 2, 3];
	static inline final MAX_PHYSICS_STEPS = 8;
	static final PROPS = ["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"];

	public final doc:OpenBoneDocument;
	public final bones:Array<Bone> = [];
	public final slots:Array<Slot> = [];
	public var drawOrder:Array<Slot> = [];
	public var skin:SkinData;

	/** Live (keyable) constraint values by constraint id. */
	public final constraintValues:Map<String, ConstraintValues> = new Map();

	/** Placement of the skeleton (applied to root bones). */
	public var x = 0.0;

	public var y = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;

	/** Seconds passed to update(); drives sequences when no animation is applied. */
	public var clock = 0.0;

	/** Local time of the dominant animation applied this frame, or null. */
	public var animationTime:Null<Float>;

	/** Live number input values by input id (set by the state machine). */
	public final inputValues:Map<String, Float> = new Map();

	/** "realtime" (advance by update()) or "seek" (only through seekParticles). */
	public var particleClock = "realtime";

	/** Keyable emitter values by slot id. */
	public final particleValues:Map<String, ParticleValues> = new Map();

	/** Values for text templates by input name. */
	public var textValues:String->Dynamic;

	/** Text shown instead of an attachment's own, by slot id. */
	public final textOverrides:Map<String, String> = new Map();

	final boneMap:Map<String, Bone> = new Map();
	final slotMap:Map<String, Slot> = new Map();
	final images:Map<String, ImageAsset> = new Map();
	final packed:Map<String, Packed> = new Map();
	var white:White;
	final physicsState:Map<String, PhysicsState> = new Map();
	final inputDefaults:Map<String, Float> = new Map();
	final inputDefaultsByName:Map<String, Dynamic> = new Map();
	var pendingDt = 0.0;
	var setupCache:Map<String, Affine>;
	final emitters:Map<String, ParticleEmitter> = new Map();
	var particlePending = 0.0;
	var particleFrac = 0.0;
	var particleSteps = 0;
	final pendingBursts:Map<String, Float> = new Map();
	var activeComputed = false;
	var activeFor:SkinData;
	final inactiveConstraints:Map<String, Bool> = new Map();
	final shapeCache = new ObjectMap<Attachment, Cached>();
	final clipCache = new ObjectMap<Attachment, Cached>();

	public function new(doc:OpenBoneDocument) {
		this.doc = doc;
		textValues = name -> inputDefaultsByName.get(name);
		for (bd in doc.skeleton.bones) {
			var b = new Bone(bd);
			if (bd.parent != null) {
				b.parent = boneMap.get(bd.parent);
				if (b.parent != null)
					b.parent.children.push(b);
			}
			bones.push(b);
			boneMap.set(bd.id, b);
		}
		for (sd in doc.skeleton.slots) {
			var bone = boneMap.get(sd.bone);
			if (bone == null)
				continue;
			var s = new Slot(sd, bone);
			slots.push(s);
			slotMap.set(sd.id, s);
		}
		for (img in doc.images)
			images.set(img.id, img);
		var pages = new Map<String, AtlasPage>();
		if (doc.atlas != null) {
			for (p in doc.atlas.pages)
				pages.set(p.id, p);
			for (r in doc.atlas.regions) {
				var page = pages.get(r.page);
				if (page == null || !images.exists(r.image))
					continue;
				var pk = new Packed();
				pk.page = new TextureRef(page.id, page.width, page.height);
				pk.map = UvMap.of(r, page);
				pk.trim = r.isTrimmed() ? [
					r.offsetX / r.originalWidth,
					r.offsetY / r.originalHeight,
					(r.offsetX + r.width) / r.originalWidth,
					(r.offsetY + r.height) / r.originalHeight
				] : null;
				var quad = pk.trim != null ? f32([pk.trim[0], pk.trim[1], pk.trim[2], pk.trim[1], pk.trim[2], pk.trim[3], pk.trim[0], pk.trim[3]]) : REGION_UVS;
				pk.rect = [r.x, r.y, r.rotated ? r.height : r.width, r.rotated ? r.width : r.height];
				if (r.polygon != null && r.polygon.length >= 6) {
					var image:Array<Float> = [for (i in 0...r.polygon.length) 0.0];
					var i = 0;
					while (i + 1 < image.length) {
						image[i] = JsNum.f32(r.polygon[i] / r.originalWidth);
						image[i + 1] = JsNum.f32(r.polygon[i + 1] / r.originalHeight);
						i += 2;
					}
					var n = Std.int(image.length / 2);
					var indices:Array<Int> = [];
					for (k in 0...n - 2) {
						indices.push(0);
						indices.push(k + 1);
						indices.push(k + 2);
					}
					pk.polyImage = image;
					pk.polyUvs = pk.map.remap(image);
					pk.polyIndices = indices;
				}
				pk.regionUvs = pk.map.remap(quad);
				packed.set(r.image, pk);
			}
			var w = doc.atlas.white;
			var wp = w != null ? pages.get(w.page) : null;
			if (w != null && wp != null) {
				white = new White();
				white.page = new TextureRef(wp.id, wp.width, wp.height);
				white.u = (w.x + w.width / 2) / wp.width;
				white.v = (w.y + w.height / 2) / wp.height;
			}
		}
		for (sm in doc.stateMachines)
			for (i in sm.inputs) {
				if (JsNum.isNum(i.defaultValue))
					inputDefaults.set(i.id, i.defaultValue);
				if (i.type != "trigger" && i.defaultValue != null && !inputDefaultsByName.exists(i.name))
					inputDefaultsByName.set(i.name, i.defaultValue);
			}
		updateActive();
		setToSetupPose();
		updateWorldTransform();
	}

	static function f32(a:Array<Float>):Array<Float> {
		for (i in 0...a.length)
			a[i] = JsNum.f32(a[i]);
		return a;
	}

	public function findBone(ref:String):Bone {
		var b = boneMap.get(ref);
		if (b != null)
			return b;
		for (x in bones)
			if (x.data.name == ref)
				return x;
		return null;
	}

	public function findSlot(ref:String):Slot {
		var s = slotMap.get(ref);
		if (s != null)
			return s;
		for (x in slots)
			if (x.data.name == ref)
				return x;
		return null;
	}

	public inline function boneById(id:String):Bone {
		return boneMap.get(id);
	}

	public inline function slotById(id:String):Slot {
		return slotMap.get(id);
	}

	/** Set the skin by id or name (null or unknown = none) and recompute skin bones / constraints. */
	public function setSkin(ref:String):Void {
		var found:SkinData = null;
		if (ref != null && ref.length > 0)
			for (s in doc.skeleton.skins)
				if (s.id == ref || s.name == ref) {
					found = s;
					break;
				}
		if (found == skin && activeComputed && activeFor == found)
			return;
		skin = found;
		updateActive();
	}

	/** Default update order: ik, transform, path, physics; sorted by `order` when any constraint has one. */
	public function constraintOrder():Array<ConstraintData> {
		var list:Array<ConstraintData> = [];
		for (c in doc.skeleton.ik)
			list.push(c);
		for (c in doc.skeleton.transform)
			list.push(c);
		for (c in doc.skeleton.path)
			list.push(c);
		for (c in doc.skeleton.physics)
			list.push(c);
		var any = false;
		for (c in list)
			if (c.order != null)
				any = true;
		if (!any)
			return list;
		var idx = [for (i in 0...list.length) i];
		haxe.ds.ArraySort.sort(idx, (a, b) -> {
			var ka:Float = list[a].order != null ? (list[a].order : Float) : a;
			var kb:Float = list[b].order != null ? (list[b].order : Float) : b;
			var d = ka - kb;
			if (d < 0)
				return -1;
			if (d > 0)
				return 1;
			return a < b ? -1 : a > b ? 1 : 0;
		});
		return [for (i in idx) list[i]];
	}

	/** Recompute which bones and constraints are active for the current skin. */
	public function updateActive():Void {
		activeComputed = true;
		activeFor = skin;
		var reqBones = new Map<String, Bool>(), reqCons = new Map<String, Bool>();
		var anyReqBones = false;
		for (s in doc.skeleton.skins) {
			if (s.bones != null)
				for (b in s.bones) {
					reqBones.set(b, true);
					anyReqBones = true;
				}
			if (s.constraints != null)
				for (c in s.constraints)
					reqCons.set(c, true);
		}
		var active:Map<String, Bool> = null;
		if (anyReqBones) {
			var mine = new Map<String, Bool>();
			if (skin != null && skin.bones != null)
				for (b in skin.bones)
					mine.set(b, true);
			active = new Map();
			for (b in doc.skeleton.bones) {
				if (b.parent != null && !active.exists(b.parent))
					continue;
				if (!reqBones.exists(b.id) || mine.exists(b.id))
					active.set(b.id, true);
			}
		}
		for (b in bones)
			b.active = active == null || active.exists(b.data.id);
		inactiveConstraints.clear();
		var mineC = new Map<String, Bool>();
		if (skin != null && skin.constraints != null)
			for (c in skin.constraints)
				mineC.set(c, true);
		for (c in constraintOrder()) {
			var skip = reqCons.exists(c.id) && !mineC.exists(c.id);
			if (!skip && active != null) {
				if (Std.isOfType(c, PhysicsConstraintData))
					skip = off((cast c : PhysicsConstraintData).bone);
				else if (Std.isOfType(c, PathConstraintData)) {
					var p:PathConstraintData = cast c;
					for (id in p.bones)
						skip = skip || off(id);
					var ts = slotMap.get(p.target);
					skip = skip || off(ts != null ? ts.bone.data.id : "");
				} else {
					var bs:Array<String> = Std.isOfType(c, IkConstraintData) ? (cast c : IkConstraintData).bones : (cast c : TransformConstraintData).bones;
					var target:String = Std.isOfType(c, IkConstraintData) ? (cast c : IkConstraintData).target : (cast c : TransformConstraintData).target;
					for (id in bs)
						skip = skip || off(id);
					skip = skip || off(target);
				}
			}
			if (skip)
				inactiveConstraints.set(c.id, true);
		}
	}

	function off(id:String):Bool {
		var b = boneMap.get(id);
		return b != null && !b.active;
	}

	public function isConstraintActive(id:String):Bool {
		return !inactiveConstraints.exists(id);
	}

	public function setToSetupPose():Void {
		for (b in bones)
			b.setToSetupPose();
		for (s in slots)
			s.setToSetupPose();
		drawOrder = slots.copy();
		animationTime = null;
		constraintValues.clear();
		particleValues.clear();
		for (c in doc.skeleton.ik)
			constraintValues.set(c.id, setupValues(c));
		for (c in doc.skeleton.transform)
			constraintValues.set(c.id, setupValues(c));
		for (c in doc.skeleton.path)
			constraintValues.set(c.id, setupValues(c));
		for (c in doc.skeleton.physics)
			constraintValues.set(c.id, setupValues(c));
	}

	static function setupValues(c:ConstraintData):ConstraintValues {
		var v = new ConstraintValues();
		if (Std.isOfType(c, IkConstraintData)) {
			var k:IkConstraintData = cast c;
			v.put("mix", k.mix);
			v.put("softness", k.softness);
			v.put("bend", k.bendPositive ? 1 : -1);
			v.put("stretch", k.stretch ? 1 : 0);
			v.put("compress", k.compress ? 1 : 0);
		} else if (Std.isOfType(c, TransformConstraintData)) {
			var t:TransformConstraintData = cast c;
			v.put("mix", 1);
			v.put("mixRotate", t.mixRotate);
			v.put("mixTranslate", t.mixTranslate);
			v.put("mixScale", t.mixScale);
			v.put("mixShear", t.mixShear);
		} else if (Std.isOfType(c, PathConstraintData)) {
			var p:PathConstraintData = cast c;
			v.put("position", p.position);
			v.put("spacing", p.spacing);
			v.put("mixRotate", p.mixRotate);
			v.put("mixX", p.mixX);
			v.put("mixY", p.mixY);
		} else {
			var p:PhysicsConstraintData = cast c;
			v.put("mix", p.mix);
			v.put("inertia", p.inertia);
			v.put("strength", p.strength);
			v.put("damping", p.damping);
			v.put("mass", p.mass);
			v.put("gravity", p.gravity);
			v.put("wind", p.wind);
		}
		return v;
	}

	function values(c:ConstraintData):ConstraintValues {
		var v = constraintValues.get(c.id);
		if (v == null) {
			v = setupValues(c);
			constraintValues.set(c.id, v);
		}
		return v;
	}

	/** Advance simulated time (physics, particles, sequences). Call once per frame before updateWorldTransform. */
	public function update(dt:Float):Void {
		if (dt > 0) {
			pendingDt += dt;
			clock += dt;
			particlePending += dt;
		}
	}

	// ---------------- Particles ----------------

	/** Forget every particle; emitters restart (and prewarm) on their next step. */
	public function resetParticles():Void {
		emitters.clear();
		pendingBursts.clear();
		particlePending = 0;
		particleFrac = 0;
		particleSteps = 0;
	}

	public function particleTime():Float {
		return particleSteps * ParticleEmitter.STEP + particleFrac;
	}

	/** Deterministically bring particles to time t; `pose(time)` poses the skeleton at a time. */
	public function seekParticles(t:Float, pose:Float->Void):Void {
		particleClock = "seek";
		particlePending = 0;
		var target = Std.int(Math.max(0, Math.floor(t / ParticleEmitter.STEP + 1e-6)));
		if (target < particleSteps)
			resetParticles();
		while (particleSteps < target) {
			pose(particleSteps * ParticleEmitter.STEP);
			stepParticles(ParticleEmitter.STEP);
			particleSteps++;
		}
		particleFrac = Math.max(0, Math.min(ParticleEmitter.STEP, t - target * ParticleEmitter.STEP));
	}

	/** Turn a slot's emitter on/off from outside the timeline (kept until the next setToSetupPose). */
	public function setEmitting(slotRef:String, emitting:Bool):Void {
		var slot = findSlot(slotRef);
		if (slot == null)
			return;
		var cur = particleValues.get(slot.data.id);
		var v = cur != null ? cur.copy() : new ParticleValues();
		v.emitting = emitting;
		particleValues.set(slot.data.id, v);
	}

	/** Restart a slot's emitter cycle (its bursts fire again). */
	public function restartEmitter(slotRef:String):Void {
		var slot = findSlot(slotRef);
		if (slot == null)
			return;
		var em = emitters.get(slot.data.id);
		if (em != null)
			em.restart();
	}

	/** Spawn `count` particles from a slot's emitter on the next step. */
	public function emitParticles(slotRef:String, count:Float):Void {
		var slot = findSlot(slotRef);
		if (slot != null && count > 0) {
			var cur = pendingBursts.get(slot.data.id);
			pendingBursts.set(slot.data.id, (cur != null ? (cur : Float) : 0.0) + count);
		}
	}

	/** The emitter simulating a slot's current particles attachment, or null. */
	public function emitter(slotRef:String):ParticleEmitter {
		var slot = findSlot(slotRef);
		var em = slot != null ? emitters.get(slot.data.id) : null;
		return em != null && em.data == getAttachment(slot) ? em : null;
	}

	function stepParticles(h:Float):Void {
		for (slot in slots) {
			if (!slot.bone.active)
				continue;
			var att = getAttachment(slot);
			var id = slot.data.id;
			if (!Std.isOfType(att, ParticlesAttachment)) {
				emitters.remove(id);
				continue;
			}
			var em = emitters.get(id);
			if (em == null || em.data != att) {
				em = new ParticleEmitter(cast att, ParticleEmitter.hashString(slot.data.name));
				emitters.set(id, em);
			}
			var burst = pendingBursts.get(id);
			if (burst != null && burst != 0)
				em.pending += burst;
			em.step(h, slot.bone.world, particleValues.get(id));
		}
		pendingBursts.clear();
	}

	function advanceParticles(dt:Float):Void {
		var acc = particleFrac + dt;
		var n = Math.ffloor(acc / ParticleEmitter.STEP + 1e-6);
		var steps = Std.int(Math.min(n, ParticleEmitter.MAX_STEPS));
		for (i in 0...steps)
			stepParticles(ParticleEmitter.STEP);
		particleSteps += steps;
		particleFrac = Math.max(0, Math.min(ParticleEmitter.STEP, acc - n * ParticleEmitter.STEP));
	}

	/** Forget physics motion: the next frame starts at rest on the animated pose. */
	public function resetPhysics():Void {
		physicsState.clear();
		pendingDt = 0;
	}

	public function unitScaleX():Float {
		return (doc.skeleton.referenceScale != null ? (doc.skeleton.referenceScale : Float) : 100.0) / 100 * scaleX;
	}

	public function unitScaleY():Float {
		return (doc.skeleton.referenceScale != null ? (doc.skeleton.referenceScale : Float) : 100.0) / 100 * scaleY;
	}

	function rootMatrix():Affine {
		return new Affine(scaleX, 0, 0, scaleY, x, y);
	}

	/** Solve world transforms, then the active constraints in update order. */
	public function updateWorldTransform():Void {
		applySliders();
		var root = rootMatrix();
		for (b in bones) {
			if (!b.active)
				continue;
			b.resetApplied();
			b.updateWorld(root);
		}
		var dt = pendingDt;
		pendingDt = 0;
		for (c in constraintOrder()) {
			if (inactiveConstraints.exists(c.id))
				continue;
			switch (c.kind) {
				case "ik":
					applyIk(cast c, values(c));
				case "transform":
					applyTransform(cast c, values(c));
				case "path":
					applyPath(cast c, values(c));
				default:
					applyPhysics(cast c, values(c), dt);
			}
		}
		var pdt = particlePending;
		particlePending = 0;
		if (particleClock == "realtime" && pdt > 0)
			advanceParticles(pdt);
	}

	// ---------------- Sliders ----------------

	function applySliders():Void {
		var list = doc.skeleton.sliders;
		if (list.length == 0)
			return;
		var savedTime = animationTime;
		for (sl in list) {
			if (sl.mix <= 0)
				continue;
			var anim = doc.animationById(sl.animation);
			if (anim == null)
				continue;
			var v:Null<Float> = null;
			if (sl.bone != null && sl.bone.length > 0) {
				var b = boneMap.get(sl.bone);
				if (b != null)
					v = b.get(sl.property != null && sl.property.length > 0 ? sl.property : "rotation");
			} else if (sl.input != null && sl.input.length > 0) {
				var iv = inputValues.get(sl.input);
				if (iv == null)
					iv = inputDefaults.get(sl.input);
				v = iv != null ? iv : 0.0;
			}
			if (v == null)
				continue;
			var vv:Float = v;
			var span = sl.to - sl.from;
			var f = span == 0 ? 0 : (vv - sl.from) / span;
			f = sl.loop ? f - Math.floor(f) : Math.min(1, Math.max(0, f));
			var t0:Float = sl.timeFrom != null ? (sl.timeFrom : Float) : 0.0;
			var t1:Float = sl.timeTo != null ? (sl.timeTo : Float) : anim.getDuration();
			var t = t0 + f * (t1 - t0);
			if (!sl.additive) {
				Animations.apply(this, anim, t, sl.mix);
				continue;
			}
			var before:Array<Array<Float>> = [];
			var inherits:Array<Inherit> = [];
			for (i in 0...bones.length) {
				before.push([for (k in 0...7) bones[i].get(PROPS[k])]);
				inherits.push(bones[i].inherit);
			}
			for (b in bones)
				b.setToSetupPose();
			var boneTl:Array<Timeline> = [], other:Array<Timeline> = [];
			var keysInherit = new Map<String, Bool>();
			for (tl in anim.timelines) {
				if (tl.target == "bone") {
					boneTl.push(tl);
					if (tl.property == "inherit")
						keysInherit.set(tl.id, true);
				} else
					other.push(tl);
			}
			Animations.applyTimelines(this, anim, boneTl, t, 1);
			for (i in 0...bones.length) {
				var b = bones[i];
				for (k in 0...7) {
					var p = PROPS[k];
					var delta = p == "rotation" ? MathUtil.wrapDeg(b.get(p) - b.data.get(p)) : b.get(p) - b.data.get(p);
					b.set(p, before[i][k] + delta * sl.mix);
				}
			}
			for (i in 0...bones.length) {
				var b = bones[i];
				if (sl.mix < 0.5 || !keysInherit.exists(b.data.id))
					b.inherit = inherits[i];
			}
			if (other.length > 0)
				Animations.applyTimelines(this, anim, other, t, sl.mix);
		}
		animationTime = savedTime;
	}

	// ---------------- IK ----------------

	function applyIk(c:IkConstraintData, v:ConstraintValues):Void {
		var mix = v.getOr("mix", Math.NaN);
		if (mix <= 0)
			return;
		var bendPositive = v.getOr("bend", c.bendPositive ? 1 : -1) > 0;
		var stretch = v.getOr("stretch", c.stretch ? 1 : 0) > 0;
		var compress = v.getOr("compress", c.compress ? 1 : 0) > 0;
		var uniform = c.uniform;
		var target = boneMap.get(c.target);
		var bs:Array<Bone> = [];
		for (id in c.bones) {
			var b = boneMap.get(id);
			if (b != null)
				bs.push(b);
		}
		if (target == null || bs.length == 0)
			return;
		var root = rootMatrix();
		var tx = target.world.x, ty = target.world.y;
		if (bs.length == 1) {
			var b = bs[0];
			var pw = b.parent != null ? b.parent.world : root;
			var inv = pw.invert();
			var dx = tx - b.world.x, dy = ty - b.world.y;
			var lx = inv.a * dx + inv.b * dy, ly = inv.c * dx + inv.d * dy;
			var want = Math.atan2(ly, lx) * MathUtil.RAD - b.applied.shearX;
			b.applied.rotation += MathUtil.wrapDeg(want - b.applied.rotation) * mix;
			b.updateWorld(root);
			var len = b.data.length * b.world.scaleX();
			if ((stretch || compress) && len > 1e-6) {
				var k = MathUtil.hypot(dx, dy) / len;
				if ((k > 1 && stretch) || (k < 1 && compress)) {
					var s = 1 + (k - 1) * mix;
					b.world.a *= s;
					b.world.c *= s;
					if (uniform) {
						b.world.b *= s;
						b.world.d *= s;
					}
					b.syncApplied(root);
				}
			}
			b.updateSubtree(root, false);
			return;
		}
		var p = bs[0], ch = bs[1];
		var px = p.world.x, py = p.world.y;
		var l1 = MathUtil.hypot(ch.world.x - px, ch.world.y - py);
		var l2 = ch.data.length * ch.world.scaleX();
		var reach = l1 + l2;
		var dRaw = MathUtil.hypot(tx - px, ty - py);
		var dSoft = dRaw;
		var soft = Math.min(v.getOr("softness", 0) * Math.abs(unitScaleX()), reach);
		if (soft > 1e-6 && dRaw > reach - soft)
			dSoft = reach - soft + soft * (1 - Math.exp(-(dRaw - (reach - soft)) / soft));
		var dEff = Math.min(Math.max(dSoft, Math.abs(l1 - l2) + 1e-4), reach - 1e-4);
		var ux = dRaw > 1e-9 ? (tx - px) / dRaw : 1;
		var uy = dRaw > 1e-9 ? (ty - py) / dRaw : 0;
		var ax = px + ux * dEff, ay = py + uy * dEff;
		var base = Math.atan2(uy, ux);
		var den = 2 * l1 * dEff;
		var cosA = (l1 * l1 + dEff * dEff - l2 * l2) / MathUtil.orOne(den);
		var a1 = base + (bendPositive ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, cosA)));
		var curDir = Math.atan2(ch.world.y - py, ch.world.x - px);
		var sP = MathUtil.detSign(p.parent != null ? p.parent.world : root);
		var deltaP = MathUtil.wrapDeg((a1 - curDir) * MathUtil.RAD) * sP;
		var pRot = p.applied.rotation, cRot = ch.applied.rotation;
		p.applied.rotation = pRot + deltaP;
		p.updateSubtree(root, true);
		var want = Math.atan2(ay - ch.world.y, ax - ch.world.x) * MathUtil.RAD;
		var sC = MathUtil.detSign(p.world);
		var deltaC = MathUtil.wrapDeg(want - ch.worldRotation()) * sC;
		p.applied.rotation = pRot + deltaP * mix;
		ch.applied.rotation = cRot + deltaC * mix;
		p.updateWorld(root);
		ch.updateWorld(root);
		if (stretch && dRaw > dEff + 1e-9) {
			var s = 1 + (dRaw / dEff - 1) * mix;
			var cw = ch.world;
			var u = uniform ? s : 1;
			p.world.a *= s;
			p.world.c *= s;
			p.world.b *= u;
			p.world.d *= u;
			var ox = p.world.applyX(ch.applied.x, ch.applied.y), oy = p.world.applyY(ch.applied.x, ch.applied.y);
			ch.world.set(new Affine(cw.a * s, cw.b * u, cw.c * s, cw.d * u, ox, oy));
			p.syncApplied(root);
			ch.syncApplied(root);
		}
		ch.updateSubtree(root, false);
		for (sib in p.children)
			if (sib != ch)
				sib.updateSubtree(root, true);
	}

	// ---------------- Transform ----------------

	function setupWorldOf(id:String):Affine {
		if (setupCache == null) {
			setupCache = new Map();
			for (b in doc.skeleton.bones) {
				var parent = b.parent != null ? setupCache.get(b.parent) : null;
				setupCache.set(b.id, MathUtil.boneWorld(parent, b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY, b.inherit));
			}
		}
		var s = setupCache.get(id);
		return Affine.multiply(rootMatrix(), s != null ? s : new Affine());
	}

	static function rotateAxes(w:Affine, rad:Float):Void {
		if (rad == 0)
			return;
		var cos = Math.cos(rad), sin = Math.sin(rad);
		var a = w.a, b = w.b, c = w.c, d = w.d;
		w.a = cos * a - sin * c;
		w.b = cos * b - sin * d;
		w.c = sin * a + cos * c;
		w.d = sin * b + cos * d;
	}

	static function skewOf(m:Affine):Float {
		return MathUtil.wrapDeg((Math.atan2(m.d, m.b) - Math.atan2(m.c, m.a)) * MathUtil.RAD - 90);
	}

	static function setSkew(w:Affine, skewDeg:Float):Void {
		var ly = MathUtil.hypot(w.b, w.d);
		var ang = Math.atan2(w.c, w.a) + (90 + skewDeg) * MathUtil.DEG;
		w.b = Math.cos(ang) * ly;
		w.d = Math.sin(ang) * ly;
	}

	function applyTransform(c:TransformConstraintData, v:ConstraintValues):Void {
		var m = v.getOr("mix", 1);
		var mr = v.getOr("mixRotate", Math.NaN) * m, mt = v.getOr("mixTranslate", Math.NaN) * m, ms = v.getOr("mixScale", Math.NaN) * m,
			mh = v.getOr("mixShear", 0) * m;
		if (mr <= 0 && mt <= 0 && ms <= 0 && mh <= 0)
			return;
		var target = boneMap.get(c.target);
		if (target == null)
			return;
		var root = rootMatrix();
		var offScaleX = c.offsetScaleX, offScaleY = c.offsetScaleY, offShear = c.offsetShear;
		for (id in c.bones) {
			var b = boneMap.get(id);
			if (b == null || b == target)
				continue;
			if (c.local) {
				var p = b.applied, t = target.applied;
				if (c.relative) {
					var s = target.data;
					p.rotation += (MathUtil.wrapDeg(t.rotation - s.rotation) + c.offsetRotation) * mr;
					p.x += (t.x - s.x + c.offsetX) * mt;
					p.y += (t.y - s.y + c.offsetY) * mt;
					p.scaleX *= 1 + ((s.scaleX != 0 && !Math.isNaN(s.scaleX) ? t.scaleX / s.scaleX : 1) - 1 + offScaleX) * ms;
					p.scaleY *= 1 + ((s.scaleY != 0 && !Math.isNaN(s.scaleY) ? t.scaleY / s.scaleY : 1) - 1 + offScaleY) * ms;
					p.shearY += (t.shearY - s.shearY + offShear) * mh;
				} else {
					p.rotation += MathUtil.wrapDeg(t.rotation + c.offsetRotation - p.rotation) * mr;
					p.x += (t.x + c.offsetX - p.x) * mt;
					p.y += (t.y + c.offsetY - p.y) * mt;
					p.scaleX += (t.scaleX + offScaleX - p.scaleX) * ms;
					p.scaleY += (t.scaleY + offScaleY - p.scaleY) * ms;
					p.shearY += (t.shearY + offShear - p.shearY) * mh;
				}
				b.updateSubtree(root, true);
				continue;
			}
			var w = b.world, t = target.world;
			if (c.relative) {
				var s = setupWorldOf(target.data.id);
				if (mr > 0)
					rotateAxes(w, (MathUtil.wrapDeg(t.rotation() - s.rotation()) + c.offsetRotation) * mr * MathUtil.DEG);
				if (mt > 0) {
					w.x += (t.x - s.x + c.offsetX) * mt;
					w.y += (t.y - s.y + c.offsetY) * mt;
				}
				if (ms > 0) {
					var kx = 1 + (t.scaleX() / MathUtil.orOne(s.scaleX()) - 1 + offScaleX) * ms;
					var ky = 1 + (t.scaleY() / MathUtil.orOne(s.scaleY()) - 1 + offScaleY) * ms;
					w.a *= kx;
					w.c *= kx;
					w.b *= ky;
					w.d *= ky;
				}
				if (mh > 0)
					setSkew(w, skewOf(w) + (MathUtil.wrapDeg(skewOf(t) - skewOf(s)) + offShear) * mh);
			} else {
				if (mr > 0)
					rotateAxes(w, MathUtil.wrapDeg(t.rotation() + c.offsetRotation - w.rotation()) * mr * MathUtil.DEG);
				if (mt > 0) {
					var ox = t.applyX(c.offsetX, c.offsetY), oy = t.applyY(c.offsetX, c.offsetY);
					w.x += (ox - w.x) * mt;
					w.y += (oy - w.y) * mt;
				}
				if (ms > 0) {
					var sx = MathUtil.orOne(w.scaleX()), sy = MathUtil.orOne(w.scaleY());
					var kx = (sx + (t.scaleX() + offScaleX - sx) * ms) / sx;
					var ky = (sy + (t.scaleY() + offScaleY - sy) * ms) / sy;
					w.a *= kx;
					w.c *= kx;
					w.b *= ky;
					w.d *= ky;
				}
				if (mh > 0) {
					var sb = skewOf(w);
					setSkew(w, sb + MathUtil.wrapDeg(skewOf(t) + offShear - sb) * mh);
				}
			}
			b.syncApplied(root);
			b.updateSubtree(root, false);
		}
	}

	// ---------------- Path ----------------

	function applyPath(c:PathConstraintData, v:ConstraintValues):Void {
		var mixRotate = v.getOr("mixRotate", Math.NaN), mixX = v.getOr("mixX", Math.NaN), mixY = v.getOr("mixY", Math.NaN);
		if (mixRotate <= 0 && mixX <= 0 && mixY <= 0)
			return;
		var slot = slotMap.get(c.target);
		if (slot == null)
			return;
		var att = getAttachment(slot);
		if (!Std.isOfType(att, PathAttachment))
			return;
		var spline = new Spline(attachmentWorldVertices(slot, att), (cast att : PathAttachment).closed);
		var total = spline.length;
		if (total <= 1e-9)
			return;
		var bs:Array<Bone> = [];
		for (id in c.bones) {
			var b = boneMap.get(id);
			if (b != null)
				bs.push(b);
		}
		var n = bs.length;
		if (n == 0)
			return;
		var lengths:Array<Float> = [];
		var sumLen = 0.0;
		for (i in 0...n) {
			lengths.push(bs[i].data.length * bs[i].world.scaleX());
			sumLen += lengths[i];
		}
		var position = v.getOr("position", Math.NaN), spacing = v.getOr("spacing", Math.NaN);
		var dist:Array<Float> = [for (i in 0...n + 1) 0.0];
		dist[0] = c.positionMode == "percent" ? position * total : position;
		for (i in 0...n) {
			var gap = switch (c.spacingMode) {
				case "fixed": spacing;
				case "percent": spacing * total;
				case "proportional": spacing * total * (sumLen > 0 ? lengths[i] / sumLen : 1.0 / n);
				default: lengths[i] + spacing;
			}
			dist[i + 1] = dist[i] + gap;
		}
		var pts = [for (i in 0...n + 1) spline.sample(dist[i])];
		var root = rootMatrix();
		var off = c.offsetRotation * MathUtil.DEG;
		for (i in 0...n) {
			var b = bs[i];
			var w = b.world;
			var p = pts[i];
			w.x += (p.x - w.x) * mixX;
			w.y += (p.y - w.y) * mixY;
			if (mixRotate > 0) {
				var ang = p.angle;
				if (c.rotateMode != "tangent") {
					var q = pts[i + 1];
					var dx = q.x - w.x, dy = q.y - w.y, d = MathUtil.hypot(dx, dy);
					if (d > 1e-6) {
						ang = Math.atan2(dy, dx);
						if (c.rotateMode == "chainScale" && lengths[i] > 1e-6) {
							var k = 1 + (d / lengths[i] - 1) * mixRotate;
							w.a *= k;
							w.c *= k;
						}
					}
				}
				rotateAxes(w, MathUtil.wrapDeg((ang + off) * MathUtil.RAD - w.rotation()) * mixRotate * MathUtil.DEG);
				b.syncApplied(root);
			}
			b.updateSubtree(root, false);
		}
	}

	// ---------------- Physics ----------------

	function applyPhysics(c:PhysicsConstraintData, v:ConstraintValues, dt:Float):Void {
		var b = boneMap.get(c.bone);
		if (b == null)
			return;
		var w = b.world;
		var len = b.data.length > 1e-6 ? b.data.length : 1;
		var ox = w.x, oy = w.y;
		var tx = w.applyX(len, 0), ty = w.applyY(len, 0);
		var st = physicsState.get(c.id);
		if (st == null) {
			st = new PhysicsState();
			st.origin = new PhysicsParticle(ox, oy);
			st.tip = new PhysicsParticle(tx, ty);
			st.lastOx = ox;
			st.lastOy = oy;
			st.lastTx = tx;
			st.lastTy = ty;
			physicsState.set(c.id, st);
		}
		var carry = 1 - Math.min(1, Math.max(0, v.getOr("inertia", Math.NaN)));
		shift(st.origin, (ox - st.lastOx) * carry, (oy - st.lastOy) * carry);
		shift(st.tip, (tx - st.lastTx) * carry, (ty - st.lastTy) * carry);
		st.lastOx = ox;
		st.lastOy = oy;
		st.lastTx = tx;
		st.lastTy = ty;
		var fps = c.fps == 0 || Math.isNaN(c.fps) ? 60 : c.fps;
		var h = 1 / Math.max(1, fps);
		st.time += dt;
		var due = Math.ffloor(st.time / h + 1e-6);
		if (due - st.steps > MAX_PHYSICS_STEPS)
			st.steps = due - MAX_PHYSICS_STEPS;
		var k = Math.min(Math.max(0, v.getOr("strength", Math.NaN)) / Math.max(1e-6, v.getOr("mass", Math.NaN)), 1 / (h * h));
		var decay = Math.exp(-Math.max(0, v.getOr("damping", Math.NaN)) * h);
		var wind = v.getOr("wind", Math.NaN) * unitScaleX();
		var gravity = v.getOr("gravity", Math.NaN) * unitScaleY();
		while (st.steps < due) {
			step(st.origin, ox, oy, k, wind, gravity, h, decay);
			step(st.tip, tx, ty, k, wind, gravity, h, decay);
			st.steps++;
		}
		var mix = Math.min(1, Math.max(0, v.getOr("mix", Math.NaN)));
		if (mix <= 0)
			return;
		var f = Math.min(1, Math.max(0, st.time / h - st.steps));
		var sox = st.origin.px + (st.origin.x - st.origin.px) * f, soy = st.origin.py + (st.origin.y - st.origin.py) * f;
		var stx = st.tip.px + (st.tip.x - st.tip.px) * f, sty = st.tip.py + (st.tip.y - st.tip.py) * f;
		w.x = ox + (sox - ox) * c.x * mix;
		w.y = oy + (soy - oy) * c.y * mix;
		if (c.rotate > 0 || c.scaleX > 0) {
			var dx = stx - w.x, dy = sty - w.y, d = MathUtil.hypot(dx, dy);
			if (d > 1e-9) {
				var base = Math.atan2(ty - oy, tx - ox);
				rotateAxes(w, MathUtil.wrapDeg((Math.atan2(dy, dx) - base) * MathUtil.RAD) * c.rotate * mix * MathUtil.DEG);
				if (c.scaleX > 0 && b.data.length > 1e-6) {
					var rest = MathUtil.hypot(tx - ox, ty - oy);
					if (rest == 0 || Math.isNaN(rest))
						rest = len;
					var s = 1 + (d / rest - 1) * c.scaleX * mix;
					w.a *= s;
					w.c *= s;
				}
			}
		}
		b.syncApplied(rootMatrix());
		b.updateSubtree(rootMatrix(), false);
	}

	static function shift(p:PhysicsParticle, dx:Float, dy:Float):Void {
		p.x += dx;
		p.y += dy;
		p.px += dx;
		p.py += dy;
	}

	static function step(p:PhysicsParticle, gx:Float, gy:Float, k:Float, wind:Float, gravity:Float, h:Float, decay:Float):Void {
		p.px = p.x;
		p.py = p.y;
		p.vx = (p.vx + ((gx - p.x) * k + wind) * h) * decay;
		p.vy = (p.vy + ((gy - p.y) * k - gravity) * h) * decay;
		p.x += p.vx * h;
		p.y += p.vy * h;
	}

	// ---------------- Sequences ----------------

	/** Frame counter of a sequence on a slot (offset included). */
	public function sequenceCounter(slot:Slot, att:SequenceAttachment):Float {
		var keyed = slot.sequenceFrames.get(att.name);
		if (keyed != null)
			return Math.ffloor(keyed + 1e-6) + att.offset;
		if (att.input != null && att.input.length > 0) {
			var v = inputValues.get(att.input);
			if (v == null)
				v = inputDefaults.get(att.input);
			if (v != null)
				return Math.ffloor(v + 1e-6) + att.offset;
		}
		var time:Float = animationTime != null ? (animationTime : Float) : clock;
		return Math.ffloor(time * att.fps + 1e-6) + att.offset;
	}

	/** Index of the frame shown now (-1 = none). */
	public function sequenceFrame(slot:Slot, att:SequenceAttachment):Int {
		return sequenceFrameIndex(att.frames.length, att.mode, sequenceCounter(slot, att));
	}

	public static function sequenceFrameIndex(count:Int, mode:String, counter:Float):Int {
		if (count <= 0 || !Math.isFinite(counter))
			return count > 0 ? 0 : -1;
		var f = Math.ffloor(counter);
		switch (mode) {
			case "loop":
				return Std.int(((f % count) + count) % count);
			case "once":
				return f < 0 ? 0 : f >= count ? -1 : Std.int(f);
			case "holdLast":
				return Std.int(Math.min(Math.max(f, 0), count - 1));
			case "pingPong":
				if (count == 1)
					return 0;
				var period = 2.0 * count - 2;
				var k = ((f % period) + period) % period;
				return Std.int(k < count ? k : period - k);
			default:
				return -1;
		}
	}

	function sequenceItem(slot:Slot, att:SequenceAttachment, index:Int):DrawItem {
		var frame = index >= 0 && index < att.frames.length ? att.frames[index] : null;
		var image = frame != null ? images.get(frame.image) : null;
		if (frame == null || image == null)
			return null;
		var color = MathUtil.mulColor(slot.color, MathUtil.parseHex(att.color));
		if (color[3] <= 0)
			return null;
		var iw = image.width, ih = image.height;
		var r = frame.rect != null ? frame.rect : [0, 0, iw, ih];
		var u0 = r[0] / iw, v0 = r[1] / ih, u1 = (r[0] + r[2]) / iw, v1 = (r[1] + r[3]) / ih;
		var q0 = 0.0, p0 = 0.0, q1 = 1.0, p1 = 1.0;
		if (frame.trim != null) {
			var t = frame.trim;
			q0 = t[0] / t[2];
			p0 = t[1] / t[3];
			q1 = (t[0] + r[2]) / t[2];
			p1 = (t[1] + r[3]) / t[3];
		}
		var pk = packed.get(frame.image);
		if (pk != null && pk.trim != null) {
			var a0 = pk.trim[0], b0 = pk.trim[1], a1 = pk.trim[2], b1 = pk.trim[3];
			var nu0 = Math.max(u0, a0), nv0 = Math.max(v0, b0), nu1 = Math.min(u1, a1), nv1 = Math.min(v1, b1);
			if (nu0 >= nu1 || nv0 >= nv1)
				return null;
			var fq0 = q0 + ((nu0 - u0) / (u1 - u0)) * (q1 - q0), fp0 = p0 + ((nv0 - v0) / (v1 - v0)) * (p1 - p0);
			var fq1 = q0 + ((nu1 - u0) / (u1 - u0)) * (q1 - q0), fp1 = p0 + ((nv1 - v0) / (v1 - v0)) * (p1 - p0);
			q0 = fq0;
			p0 = fp0;
			q1 = fq1;
			p1 = fp1;
			u0 = nu0;
			v0 = nv0;
			u1 = nu1;
			v1 = nv1;
		}
		var vertices = attachmentWorldVertices(slot, att);
		if (q0 != 0 || p0 != 0 || q1 != 1 || p1 != 1)
			vertices = trimQuad(vertices, q0, p0, q1, p1);
		var quadUvs = f32([u0, v0, u1, v0, u1, v1, u0, v1]);
		var texture = pk != null ? pk.page : new TextureRef(image.id, image.width, image.height);
		var uvs = pk != null ? pk.map.remap(quadUvs) : quadUvs;
		var whole = pk == null && u0 == 0 && v0 == 0 && u1 == 1 && v1 == 1;
		var it = new DrawItem();
		it.slot = slot;
		it.attachment = att;
		it.image = image;
		it.texture = texture;
		if (!whole)
			it.textureRect = [
				Math.min(uvs[0], uvs[4]) * texture.width,
				Math.min(uvs[1], uvs[5]) * texture.height,
				Math.abs(uvs[4] - uvs[0]) * texture.width,
				Math.abs(uvs[5] - uvs[1]) * texture.height
			];
		it.vertices = vertices;
		it.uvs = uvs;
		it.indices = REGION_INDICES;
		it.color = color;
		it.dark = slot.dark;
		it.blend = slot.data.blend;
		return it;
	}

	// ---------------- Text ----------------

	/** Show fixed text (or a template) in a slot's text attachment instead of its own; null restores it. */
	public function setText(slotRef:String, text:String):Void {
		var slot = findSlot(slotRef);
		if (slot == null)
			throw "Slot \"" + slotRef + "\" not found";
		if (text == null)
			textOverrides.remove(slot.data.id);
		else
			textOverrides.set(slot.data.id, text);
	}

	/** The text a slot's text attachment shows now (template filled in). */
	public function textContent(slot:Slot, att:TextAttachment):String {
		var t = textOverrides.get(slot.data.id);
		return Template.format(t != null ? t : att.text, textValues);
	}

	/** Box centre to world matrix of a text attachment. */
	public function textMatrix(slot:Slot, att:TextAttachment):Affine {
		var r = att.rotation * MathUtil.DEG, c = Math.cos(r), s = Math.sin(r);
		return Affine.multiply(slot.bone.world, new Affine(c, -s, s, c, att.x, att.y));
	}

	// ---------------- Attachments ----------------

	/** Current attachment of a slot: active skin, then the default skin. */
	public function getAttachment(slot:Slot):Attachment {
		return getAttachmentNamed(slot, slot.attachmentName);
	}

	public function getAttachmentNamed(slot:Slot, name:String):Attachment {
		if (name == null)
			return null;
		var id = slot.data.id;
		var a = skin != null ? skin.get(id, name) : null;
		if (a != null)
			return a;
		var def = doc.defaultSkin();
		return def != null ? def.get(id, name) : null;
	}

	/** World-space vertices (float32 values) of a slot's attachment. */
	public function attachmentWorldVertices(slot:Slot, att:Attachment):Array<Float> {
		var m = slot.bone.world;
		if (Std.isOfType(att, RegionAttachment) || Std.isOfType(att, SequenceAttachment) || Std.isOfType(att, TextAttachment)) {
			var ax:Float, ay:Float, rot:Float, w:Float, hgt:Float, sx = 1.0, sy = 1.0, skx = 0.0, sky = 0.0;
			var text = Std.isOfType(att, TextAttachment);
			if (Std.isOfType(att, RegionAttachment)) {
				var r:RegionAttachment = cast att;
				ax = r.x;
				ay = r.y;
				rot = r.rotation;
				w = r.width;
				hgt = r.height;
				sx = r.scaleX;
				sy = r.scaleY;
				skx = r.skewX;
				sky = r.skewY;
			} else if (Std.isOfType(att, SequenceAttachment)) {
				var r:SequenceAttachment = cast att;
				ax = r.x;
				ay = r.y;
				rot = r.rotation;
				w = r.width;
				hgt = r.height;
				sx = r.scaleX;
				sy = r.scaleY;
				skx = r.skewX;
				sky = r.skewY;
			} else {
				var r:TextAttachment = cast att;
				ax = r.x;
				ay = r.y;
				rot = r.rotation;
				w = r.width;
				hgt = r.height;
			}
			var hw = (w / 2) * (text ? 1 : sx), hh = (hgt / 2) * (text ? 1 : sy);
			var cos = Math.cos(rot * MathUtil.DEG), sin = Math.sin(rot * MathUtil.DEG);
			var corners:Array<Float> = [-hw, hh, hw, hh, hw, -hh, -hw, -hh];
			var kx = !text && skx != 0 && !Math.isNaN(skx) ? Math.tan(skx * MathUtil.DEG) : 0;
			var ky = !text && sky != 0 && !Math.isNaN(sky) ? Math.tan(sky * MathUtil.DEG) : 0;
			if (kx != 0 || ky != 0) {
				var i = 0;
				while (i < 8) {
					var x0 = corners[i], y0 = corners[i + 1];
					corners[i] = x0 + kx * y0;
					corners[i + 1] = y0 + ky * x0;
					i += 2;
				}
			}
			var out:Array<Float> = [for (i in 0...8) 0.0];
			var i = 0;
			while (i < 8) {
				var lx = ax + corners[i] * cos - corners[i + 1] * sin;
				var ly = ay + corners[i] * sin + corners[i + 1] * cos;
				out[i] = JsNum.f32(m.a * lx + m.b * ly + m.x);
				out[i + 1] = JsNum.f32(m.c * lx + m.d * ly + m.y);
				i += 2;
			}
			return out;
		}
		if (Std.isOfType(att, MeshAttachment) || Std.isOfType(att, PathAttachment)) {
			var verts:Array<Float>;
			var weights:Array<Array<VertexWeight>>;
			var linked:String = null;
			if (Std.isOfType(att, MeshAttachment)) {
				var mesh:MeshAttachment = cast att;
				verts = mesh.vertices;
				weights = mesh.weights;
				if (mesh.linked != null && mesh.linked.deform)
					linked = mesh.linked.mesh;
			} else {
				var path:PathAttachment = cast att;
				verts = path.vertices;
				weights = path.weights;
			}
			var n = Std.int(verts.length / 2);
			var deform = linked != null ? slot.deform.get(linked) : null;
			if (deform == null)
				deform = slot.deform.get(att.name);
			var out:Array<Float> = [for (i in 0...n * 2) 0.0];
			if (weights != null) {
				for (v in 0...n) {
					var wx = 0.0, wy = 0.0;
					var dx = deform != null && v * 2 < deform.length ? deform[v * 2] : 0;
					var dy = deform != null && v * 2 + 1 < deform.length ? deform[v * 2 + 1] : 0;
					for (inf in weights[v]) {
						var ib = boneMap.get(inf.bone);
						var bm = ib != null ? ib.world : m;
						var lx = inf.x + dx, ly = inf.y + dy;
						wx += (bm.a * lx + bm.b * ly + bm.x) * inf.weight;
						wy += (bm.c * lx + bm.d * ly + bm.y) * inf.weight;
					}
					out[v * 2] = JsNum.f32(wx);
					out[v * 2 + 1] = JsNum.f32(wy);
				}
			} else {
				for (v in 0...n) {
					var lx = verts[v * 2] + (deform != null && v * 2 < deform.length ? deform[v * 2] : 0);
					var ly = verts[v * 2 + 1] + (deform != null && v * 2 + 1 < deform.length ? deform[v * 2 + 1] : 0);
					out[v * 2] = JsNum.f32(m.a * lx + m.b * ly + m.x);
					out[v * 2 + 1] = JsNum.f32(m.c * lx + m.d * ly + m.y);
				}
			}
			return out;
		}
		var local:Array<Float>;
		if (Std.isOfType(att, ShapeAttachment))
			local = shapeOutline(cast att);
		else if (Std.isOfType(att, BoundingBoxAttachment))
			local = (cast att : BoundingBoxAttachment).vertices;
		else if (Std.isOfType(att, ClippingAttachment))
			local = (cast att : ClippingAttachment).vertices;
		else if (Std.isOfType(att, PointAttachment))
			local = [(cast att : PointAttachment).x, (cast att : PointAttachment).y];
		else if (Std.isOfType(att, ParticlesAttachment))
			local = [(cast att : ParticlesAttachment).x, (cast att : ParticlesAttachment).y];
		else
			local = [];
		var out:Array<Float> = [for (i in 0...local.length) 0.0];
		var i = 0;
		while (i + 1 < local.length) {
			out[i] = JsNum.f32(m.a * local[i] + m.b * local[i + 1] + m.x);
			out[i + 1] = JsNum.f32(m.c * local[i] + m.d * local[i + 1] + m.y);
			i += 2;
		}
		return out;
	}

	/** Outline polygon of a shape in slot-bone space (core/geometry.ts shapeOutline, 32 segments). */
	public static function shapeOutline(s:ShapeAttachment):Array<Float> {
		var segments = 32;
		var pts:Array<Float> = [];
		var hw = s.width / 2, hh = s.height / 2;
		if (s.shape == "rect") {
			var r = Math.min(s.radius, Math.min(hw, hh));
			if (r <= 0) {
				for (d in [-hw, -hh, hw, -hh, hw, hh, -hw, hh])
					pts.push(d);
			} else {
				var corners:Array<Array<Float>> = [[hw - r, -hh + r, -90], [hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180]];
				var seg = Std.int(Math.max(2, JsNum.round(segments / 4.0)));
				for (cc in corners)
					for (i in 0...seg + 1) {
						var a = (cc[2] + (90.0 * i) / seg) * MathUtil.DEG;
						pts.push(cc[0] + Math.cos(a) * r);
						pts.push(cc[1] + Math.sin(a) * r);
					}
			}
		} else if (s.shape == "ellipse") {
			for (i in 0...segments) {
				var a = (i / segments) * Math.PI * 2;
				pts.push(Math.cos(a) * hw);
				pts.push(Math.sin(a) * hh);
			}
		} else if (s.points != null)
			for (d in s.points)
				pts.push(d);
		var cos = Math.cos(s.rotation * MathUtil.DEG), sin = Math.sin(s.rotation * MathUtil.DEG);
		var out:Array<Float> = [for (i in 0...pts.length) 0.0];
		var i = 0;
		while (i + 1 < out.length) {
			var x0 = pts[i], y0 = pts[i + 1];
			out[i] = s.x + x0 * cos - y0 * sin;
			out[i + 1] = s.y + x0 * sin + y0 * cos;
			i += 2;
		}
		if (out.length % 2 == 1)
			out[out.length - 1] = pts[out.length - 1];
		return out;
	}

	// ---------------- Draw list ----------------

	/** Renderable geometry in draw order (docs/runtime-spec.md §8.4). */
	public function drawList():Array<DrawItem> {
		var items:Array<DrawItem> = [];
		var clip:ClipRegion = null;
		var clipEnd:String = null;
		for (slot in drawOrder) {
			var att = slot.bone.active ? getAttachment(slot) : null;
			var first = items.length;
			if (Std.isOfType(att, ClippingAttachment)) {
				var ca:ClippingAttachment = cast att;
				if (clip == null && ca.vertices.length >= 6) {
					var key = Json.stringify(ca.vertices);
					var cached = clipCache.get(att);
					if (cached == null || cached.key != key) {
						cached = new Cached(key, Earcut.triangulate(ca.vertices));
						clipCache.set(att, cached);
					}
					clip = new ClipRegion(slot, attachmentWorldVertices(slot, att), cached.indices);
					clipEnd = ca.end;
				}
			} else if (Std.isOfType(att, RegionAttachment) || Std.isOfType(att, MeshAttachment)) {
				var isRegion = Std.isOfType(att, RegionAttachment);
				var imageId = isRegion ? (cast att : RegionAttachment).image : (cast att : MeshAttachment).image;
				var colorHex = isRegion ? (cast att : RegionAttachment).color : (cast att : MeshAttachment).color;
				var image = images.get(imageId);
				var color = MathUtil.mulColor(slot.color, MathUtil.parseHex(colorHex));
				if (color[3] > 0) {
					var vertices = attachmentWorldVertices(slot, att);
					var pk = packed.get(imageId);
					var uvs:Array<Float>;
					var indices:Array<Int>;
					if (isRegion) {
						uvs = pk != null ? pk.regionUvs : REGION_UVS;
						indices = REGION_INDICES;
						if (pk != null && pk.polyImage != null) {
							vertices = quadPoints(vertices, pk.polyImage);
							uvs = pk.polyUvs;
							indices = pk.polyIndices;
						} else if (pk != null && pk.trim != null)
							vertices = trimQuad(vertices, pk.trim[0], pk.trim[1], pk.trim[2], pk.trim[3]);
					} else {
						var mesh:MeshAttachment = cast att;
						uvs = pk != null ? pk.map.remap(mesh.uvs) : f32(mesh.uvs.copy());
						indices = mesh.triangles;
					}
					var it = new DrawItem();
					it.slot = slot;
					it.attachment = att;
					it.image = image;
					it.texture = pk != null ? pk.page : image != null ? new TextureRef(image.id, image.width, image.height) : null;
					if (pk != null)
						it.textureRect = pk.rect;
					it.vertices = vertices;
					it.uvs = uvs;
					it.indices = indices;
					it.color = color;
					it.dark = slot.dark;
					it.blend = slot.data.blend;
					items.push(it);
				}
			} else if (Std.isOfType(att, SequenceAttachment)) {
				var sa:SequenceAttachment = cast att;
				var it = sequenceItem(slot, sa, sequenceFrame(slot, sa));
				if (it != null)
					items.push(it);
			} else if (Std.isOfType(att, ParticlesAttachment)) {
				var it = particleItem(slot, cast att);
				if (it != null)
					items.push(it);
			} else if (Std.isOfType(att, TextAttachment)) {
				var ta:TextAttachment = cast att;
				var color = slot.color;
				if (color[3] > 0) {
					var it = new DrawItem();
					it.slot = slot;
					it.attachment = att;
					it.vertices = attachmentWorldVertices(slot, att);
					it.uvs = REGION_UVS;
					it.indices = REGION_INDICES;
					it.color = color;
					it.blend = slot.data.blend;
					var t = new DrawText();
					t.content = textContent(slot, ta);
					t.font = ta.font;
					t.size = ta.size;
					t.weight = ta.weight;
					t.align = ta.align;
					t.width = ta.width;
					t.height = ta.height;
					t.fill = MathUtil.parseHex(ta.color);
					t.outline = ta.outline != null && ta.outline.length > 0 && ta.outlineWidth != null && ta.outlineWidth != 0
						&& !Math.isNaN(ta.outlineWidth) ? MathUtil.parseHex(ta.outline) : null;
					t.outlineWidth = ta.outlineWidth != null ? (ta.outlineWidth : Float) : 0;
					t.matrix = textMatrix(slot, ta);
					it.text = t;
					items.push(it);
				}
			} else if (Std.isOfType(att, ShapeAttachment)) {
				var sa:ShapeAttachment = cast att;
				var outline = attachmentWorldVertices(slot, att);
				var key = sa.shape + "|" + JsNum.toString(sa.width) + "|" + JsNum.toString(sa.height) + "|" + JsNum.toString(sa.radius) + "|"
					+ (sa.points == null ? "" : Json.stringify(sa.points));
				var cached = shapeCache.get(att);
				if (cached == null || cached.key != key) {
					cached = new Cached(key, Earcut.triangulate(shapeOutline(sa)));
					shapeCache.set(att, cached);
				}
				var color = MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.fill));
				var hasStroke = sa.stroke != null && sa.stroke.length > 0 && sa.strokeWidth != null && sa.strokeWidth > 0
					&& MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.stroke))[3] > 0;
				if (color[3] > 0 || hasStroke) {
					var it = new DrawItem();
					it.slot = slot;
					it.attachment = att;
					it.texture = white != null ? white.page : null;
					it.vertices = outline;
					it.uvs = white != null ? fill2(outline.length, white.u, white.v) : [for (i in 0...outline.length) 0.0];
					it.indices = cached.indices;
					it.color = color;
					it.blend = slot.data.blend;
					if (sa.stroke != null && sa.stroke.length > 0 && sa.strokeWidth != null && sa.strokeWidth != 0 && !Math.isNaN(sa.strokeWidth))
						it.stroke = new Stroke(MathUtil.mulColor(slot.color, MathUtil.parseHex(sa.stroke)), sa.strokeWidth, outline);
					items.push(it);
				}
			}
			if (clip != null && clip.slot != slot)
				for (i in first...items.length)
					items[i].clip = clip;
			if (clip != null && slot.data.id == clipEnd) {
				clip = null;
				clipEnd = null;
			}
		}
		return items;
	}

	function particleItem(slot:Slot, att:ParticlesAttachment):DrawItem {
		var em = emitters.get(slot.data.id);
		if (em == null || em.data != att || em.alive() == 0)
			return null;
		var geo = em.geometry(particleFrac, slot.bone.world, slot.color);
		if (geo.count == 0)
			return null;
		var texture:TextureRef = null;
		var image:ImageAsset = null;
		var uvs = geo.uvs;
		var textureRect:Array<Float> = null;
		if (att.look == "image") {
			image = att.image != null && att.image.length > 0 ? images.get(att.image) : null;
			var pk = att.image != null && att.image.length > 0 ? packed.get(att.image) : null;
			if (pk != null) {
				texture = pk.page;
				textureRect = pk.rect;
				uvs = pk.map.remap(geo.uvs);
			} else if (image != null)
				texture = new TextureRef(image.id, image.width, image.height);
			if (texture == null)
				return null;
		} else if (att.look == "square") {
			if (white != null) {
				texture = white.page;
				uvs = fill2(geo.uvs.length, white.u, white.v);
			}
		} else
			texture = new TextureRef(DrawItem.PARTICLE_DOT_TEXTURE, DrawItem.PARTICLE_DOT_SIZE, DrawItem.PARTICLE_DOT_SIZE);
		var it = new DrawItem();
		it.slot = slot;
		it.attachment = att;
		it.image = image;
		it.texture = texture;
		it.textureRect = textureRect;
		it.vertices = geo.vertices;
		it.uvs = uvs;
		it.indices = geo.indices;
		it.color = slot.color;
		it.colors = geo.colors;
		it.blend = att.blend;
		it.particleLook = att.look;
		it.particleCount = geo.count;
		return it;
	}

	// ---------------- Hit testing ----------------

	/** World polygon used for hit tests: the current bounding box, else the slot's first bounding box, else the attachment. */
	public function hitPolygon(slot:Slot):Array<Float> {
		var att = getAttachment(slot);
		if (!Std.isOfType(att, BoundingBoxAttachment)) {
			var all = new OrderedMap<Attachment>();
			var def = doc.defaultSkin();
			var da = def != null ? def.attachments.get(slot.data.id) : null;
			if (da != null)
				for (k in da.keys)
					all.set(k, da.get(k));
			var sa = skin != null ? skin.attachments.get(slot.data.id) : null;
			if (sa != null)
				for (k in sa.keys)
					all.set(k, sa.get(k));
			var found:Attachment = null;
			for (k in jsKeyOrder(all.keys))
				if (Std.isOfType(all.get(k), BoundingBoxAttachment)) {
					found = all.get(k);
					break;
				}
			if (found != null)
				att = found;
		}
		if (att == null)
			return null;
		if (Std.isOfType(att, BoundingBoxAttachment) || Std.isOfType(att, ShapeAttachment) || Std.isOfType(att, ClippingAttachment))
			return attachmentWorldVertices(slot, att);
		if (Std.isOfType(att, RegionAttachment) || Std.isOfType(att, SequenceAttachment) || Std.isOfType(att, TextAttachment))
			return attachmentWorldVertices(slot, att);
		if (Std.isOfType(att, MeshAttachment)) {
			var v = attachmentWorldVertices(slot, att);
			var n = Std.int(Math.min(v.length, (cast att : MeshAttachment).hull * 2));
			return v.slice(0, n);
		}
		return null;
	}

	/** Property order of a JS object: array-index keys ascending, then the rest in insertion order. */
	public static function jsKeyOrder(keys:Array<String>):Array<String> {
		var ints:Array<String> = [], rest:Array<String> = [];
		for (k in keys)
			(isArrayIndex(k) ? ints : rest).push(k);
		haxe.ds.ArraySort.sort(ints, (a, b) -> {
			var x = Std.parseFloat(a), y = Std.parseFloat(b);
			return x < y ? -1 : x > y ? 1 : 0;
		});
		return ints.concat(rest);
	}

	static function isArrayIndex(k:String):Bool {
		if (k.length == 0 || k.length > 10)
			return false;
		if (k.length > 1 && k.charAt(0) == "0")
			return false;
		for (i in 0...k.length) {
			var c = k.charCodeAt(i);
			if (c < "0".code || c > "9".code)
				return false;
		}
		return Std.parseFloat(k) < 4294967295.0;
	}

	public function hitTest(slot:Slot, px:Float, py:Float):Bool {
		if (!slot.bone.active)
			return false;
		var poly = hitPolygon(slot);
		return poly != null && MathUtil.pointInPolygon(px, py, poly);
	}

	/** Axis-aligned bounds [minX, minY, maxX, maxY] of everything drawn and every bone. */
	public function bounds():Array<Float> {
		var b = [Math.POSITIVE_INFINITY, Math.POSITIVE_INFINITY, Math.NEGATIVE_INFINITY, Math.NEGATIVE_INFINITY];
		for (it in drawList()) {
			var i = 0;
			while (i + 1 < it.vertices.length) {
				addBound(b, it.vertices[i], it.vertices[i + 1]);
				i += 2;
			}
		}
		for (bone in bones) {
			addBound(b, bone.world.x, bone.world.y);
			addBound(b, bone.world.applyX(bone.data.length, 0), bone.world.applyY(bone.data.length, 0));
		}
		return b;
	}

	static function addBound(b:Array<Float>, x:Float, y:Float):Void {
		b[0] = Math.min(b[0], x);
		b[1] = Math.min(b[1], y);
		b[2] = Math.max(b[2], x);
		b[3] = Math.max(b[3], y);
	}

	static function fill2(n:Int, a:Float, b:Float):Array<Float> {
		var out:Array<Float> = [for (i in 0...n) 0.0];
		var fa = JsNum.f32(a), fb = JsNum.f32(b);
		var i = 0;
		while (i + 1 < n) {
			out[i] = fa;
			out[i + 1] = fb;
			i += 2;
		}
		return out;
	}

	/** Shrink a region quad (TL, TR, BR, BL) to the part [u0, v0, u1, v1] of its image. */
	public static function trimQuad(q:Array<Float>, u0:Float, v0:Float, u1:Float, v1:Float):Array<Float> {
		var ux = q[2] - q[0], uy = q[3] - q[1], vx = q[6] - q[0], vy = q[7] - q[1];
		var uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
		var out:Array<Float> = [];
		for (i in 0...4) {
			out.push(JsNum.f32(q[0] + ux * uv[i][0] + vx * uv[i][1]));
			out.push(JsNum.f32(q[1] + uy * uv[i][0] + vy * uv[i][1]));
		}
		return out;
	}

	/** Points in 0..1 image space placed on a region quad (TL, TR, BR, BL). */
	public static function quadPoints(q:Array<Float>, uv:Array<Float>):Array<Float> {
		var ux = q[2] - q[0], uy = q[3] - q[1], vx = q[6] - q[0], vy = q[7] - q[1];
		var out:Array<Float> = [for (i in 0...uv.length) 0.0];
		var i = 0;
		while (i + 1 < uv.length) {
			out[i] = JsNum.f32(q[0] + ux * uv[i] + vx * uv[i + 1]);
			out[i + 1] = JsNum.f32(q[1] + uy * uv[i] + vy * uv[i + 1]);
			i += 2;
		}
		return out;
	}
}
