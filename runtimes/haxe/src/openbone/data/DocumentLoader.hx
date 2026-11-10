package openbone.data;

import haxe.io.Bytes;
import openbone.JsNum;
import openbone.Json;
import openbone.data.Model;

/**
 * Loads documents: JSON (.obone) or binary (.obonb), then fills the defaults `normalizeDocument` fills
 * (docs/runtime-spec.md §2).
 */
class DocumentLoader {
	public static inline final FORMAT_VERSION = 1;

	/** Load from file bytes, whichever format they are in. */
	public static function load(bytes:Bytes):OpenBoneDocument {
		return isBinary(bytes) ? fromBinary(bytes) : fromJson(bytes.toString());
	}

	public static function fromJson(json:String):OpenBoneDocument {
		if (json.length > 0 && json.charCodeAt(0) == 0xFEFF)
			json = json.substr(1);
		return fromTree(Json.parse(json));
	}

	/** Build from a parsed JSON tree (JObject, arrays, Float, String, Bool, null). */
	public static function fromTree(tree:Dynamic):OpenBoneDocument {
		if (!Std.isOfType(tree, JObject))
			throw "Not an OpenBone document (missing format: \"openbone\")";
		var m:JObject = tree;
		if (m.get("format") != "openbone")
			throw "Not an OpenBone document (missing format: \"openbone\")";
		var version = num(m, "version", 1);
		if (version > FORMAT_VERSION)
			throw "Document version " + JsNum.toString(version) + " is newer than supported " + FORMAT_VERSION;
		var d = new OpenBoneDocument();
		d.version = Std.int(version);
		d.name = str(m, "name", "");
		d.width = num(m, "width", 0);
		d.height = num(m, "height", 0);
		d.originX = num(m, "originX", 0);
		d.originY = num(m, "originY", 0);
		d.background = str(m, "background", null);
		d.fps = num(m, "fps", 30);
		for (x in maps(m.get("images"))) {
			var i = new ImageAsset();
			i.id = str(x, "id", "");
			i.name = str(x, "name", "");
			i.src = str(x, "src", "");
			i.width = num(x, "width", 0);
			i.height = num(x, "height", 0);
			d.images.push(i);
		}
		if (Std.isOfType(m.get("atlas"), JObject))
			d.atlas = atlas(m.get("atlas"));
		skeleton(d.skeleton, map(m.get("skeleton")));
		for (x in maps(m.get("events"))) {
			var e = new EventData();
			e.id = str(x, "id", "");
			e.name = str(x, "name", "");
			e.intValue = num(x, "int", 0);
			e.floatValue = num(x, "float", 0);
			e.stringValue = str(x, "string", "");
			e.audio = str(x, "audio", null);
			e.volume = optNum(x, "volume");
			d.events.push(e);
		}
		for (x in maps(m.get("animations")))
			d.animations.push(animation(x));
		for (x in maps(m.get("stateMachines")))
			d.stateMachines.push(stateMachine(x));
		for (x in maps(m.get("scripts"))) {
			var s = new ScriptData();
			s.id = str(x, "id", "");
			s.name = str(x, "name", "");
			s.code = str(x, "code", "");
			d.scripts.push(s);
		}
		if (Std.isOfType(m.get("audio"), JObject))
			d.audio = audio(m.get("audio"));
		return d;
	}

	// ---------------- Sections ----------------

	static function atlas(m:JObject):AtlasData {
		var a = new AtlasData();
		for (x in maps(m.get("pages"))) {
			var p = new AtlasPage();
			p.id = str(x, "id", "");
			p.name = str(x, "name", "");
			p.src = str(x, "src", "");
			p.width = num(x, "width", 0);
			p.height = num(x, "height", 0);
			a.pages.push(p);
		}
		for (x in maps(m.get("regions"))) {
			var r = new AtlasRegion();
			r.image = str(x, "image", "");
			r.page = str(x, "page", "");
			r.x = num(x, "x", 0);
			r.y = num(x, "y", 0);
			r.width = num(x, "width", 0);
			r.height = num(x, "height", 0);
			r.offsetX = num(x, "offsetX", 0);
			r.offsetY = num(x, "offsetY", 0);
			r.originalWidth = num(x, "originalWidth", r.width);
			r.originalHeight = num(x, "originalHeight", r.height);
			r.rotated = bool(x, "rotated", false);
			r.polygon = nums(x.get("polygon"));
			a.regions.push(r);
		}
		if (m.get("white") != null) {
			var w = map(m.get("white"));
			a.white = new AtlasWhite();
			a.white.page = str(w, "page", "");
			a.white.x = num(w, "x", 0);
			a.white.y = num(w, "y", 0);
			a.white.width = num(w, "width", 0);
			a.white.height = num(w, "height", 0);
		}
		a.padding = num(m, "padding", 0);
		a.scale = num(m, "scale", 1);
		a.premultipliedAlpha = bool(m, "premultipliedAlpha", false);
		a.stripWhitespace = bool(m, "stripWhitespace", false);
		a.polygons = bool(m, "polygons", false);
		return a;
	}

	static function skeleton(sk:SkeletonData, m:JObject):Void {
		for (x in maps(m.get("bones"))) {
			var b = new BoneData();
			b.id = str(x, "id", "");
			b.name = str(x, "name", "");
			b.parent = str(x, "parent", null);
			b.length = num(x, "length", 0);
			b.x = num(x, "x", 0);
			b.y = num(x, "y", 0);
			b.rotation = num(x, "rotation", 0);
			b.scaleX = num(x, "scaleX", 1);
			b.scaleY = num(x, "scaleY", 1);
			b.shearX = num(x, "shearX", 0);
			b.shearY = num(x, "shearY", 0);
			b.inherit = Inherit.parse(str(x, "inherit", "normal"));
			b.color = str(x, "color", null);
			sk.bones.push(b);
		}
		for (x in maps(m.get("slots"))) {
			var s = new SlotData();
			s.id = str(x, "id", "");
			s.name = str(x, "name", "");
			s.bone = str(x, "bone", "");
			s.color = str(x, "color", "#ffffffff");
			s.attachment = str(x, "attachment", null);
			s.blend = str(x, "blend", "normal");
			s.dark = str(x, "dark", null);
			sk.slots.push(s);
		}
		for (x in maps(m.get("skins"))) {
			var k = new SkinData();
			k.id = str(x, "id", "");
			k.name = str(x, "name", "");
			var atts = map(x.get("attachments"));
			for (slotId in atts.keys) {
				var slotAtts = new OrderedMap<Attachment>();
				var sm = map(atts.get(slotId));
				for (name in sm.keys) {
					var att = attachment(name, map(sm.get(name)));
					if (att != null)
						slotAtts.set(name, att);
				}
				k.attachments.set(slotId, slotAtts);
			}
			if (Std.isOfType(x.get("bones"), Array))
				k.bones = strs(x.get("bones"));
			if (Std.isOfType(x.get("constraints"), Array))
				k.constraints = strs(x.get("constraints"));
			sk.skins.push(k);
		}
		for (x in maps(m.get("ik"))) {
			var c = new IkConstraintData();
			base(c, x);
			for (s in strs(x.get("bones")))
				c.bones.push(s);
			c.target = str(x, "target", "");
			c.mix = num(x, "mix", 0);
			c.bendPositive = bool(x, "bendPositive", false);
			c.softness = num(x, "softness", 0);
			c.stretch = bool(x, "stretch", false);
			c.compress = bool(x, "compress", false);
			c.uniform = bool(x, "uniform", false);
			sk.ik.push(c);
		}
		for (x in maps(m.get("transform"))) {
			var c = new TransformConstraintData();
			base(c, x);
			for (s in strs(x.get("bones")))
				c.bones.push(s);
			c.target = str(x, "target", "");
			c.mixRotate = num(x, "mixRotate", 0);
			c.mixTranslate = num(x, "mixTranslate", 0);
			c.mixScale = num(x, "mixScale", 0);
			c.mixShear = num(x, "mixShear", 0);
			c.offsetRotation = num(x, "offsetRotation", 0);
			c.offsetX = num(x, "offsetX", 0);
			c.offsetY = num(x, "offsetY", 0);
			c.offsetScaleX = num(x, "offsetScaleX", 0);
			c.offsetScaleY = num(x, "offsetScaleY", 0);
			c.offsetShear = num(x, "offsetShear", 0);
			c.local = bool(x, "local", false);
			c.relative = bool(x, "relative", false);
			sk.transform.push(c);
		}
		for (x in maps(m.get("path"))) {
			var c = new PathConstraintData();
			base(c, x);
			for (s in strs(x.get("bones")))
				c.bones.push(s);
			c.target = str(x, "target", "");
			c.positionMode = str(x, "positionMode", "percent");
			c.spacingMode = str(x, "spacingMode", "length");
			c.rotateMode = str(x, "rotateMode", "tangent");
			c.offsetRotation = num(x, "offsetRotation", 0);
			c.position = num(x, "position", 0);
			c.spacing = num(x, "spacing", 0);
			c.mixRotate = num(x, "mixRotate", 0);
			c.mixX = num(x, "mixX", 0);
			c.mixY = num(x, "mixY", 0);
			sk.path.push(c);
		}
		for (x in maps(m.get("physics"))) {
			var c = new PhysicsConstraintData();
			base(c, x);
			c.bone = str(x, "bone", "");
			c.x = num(x, "x", 0);
			c.y = num(x, "y", 0);
			c.rotate = num(x, "rotate", 0);
			c.scaleX = num(x, "scaleX", 0);
			c.inertia = num(x, "inertia", 0);
			c.strength = num(x, "strength", 0);
			c.damping = num(x, "damping", 0);
			c.mass = num(x, "mass", 0);
			c.gravity = num(x, "gravity", 0);
			c.wind = num(x, "wind", 0);
			c.mix = num(x, "mix", 0);
			c.fps = num(x, "fps", 0);
			sk.physics.push(c);
		}
		for (x in maps(m.get("sliders"))) {
			var s = new SliderData();
			s.id = str(x, "id", "");
			s.name = str(x, "name", "");
			s.animation = str(x, "animation", "");
			s.bone = str(x, "bone", null);
			s.property = str(x, "property", null);
			s.input = str(x, "input", null);
			s.from = num(x, "from", 0);
			s.to = num(x, "to", 0);
			s.timeFrom = optNum(x, "timeFrom");
			s.timeTo = optNum(x, "timeTo");
			s.mix = num(x, "mix", 0);
			s.loop = bool(x, "loop", false);
			s.additive = bool(x, "additive", false);
			sk.sliders.push(s);
		}
		sk.referenceScale = optNum(m, "referenceScale");
	}

	static function base(c:ConstraintData, x:JObject):Void {
		c.id = str(x, "id", "");
		c.name = str(x, "name", "");
		c.order = optNum(x, "order");
	}

	static function weights(v:Dynamic):Array<Array<VertexWeight>> {
		if (!Std.isOfType(v, Array))
			return null;
		var l:Array<Dynamic> = v;
		var out:Array<Array<VertexWeight>> = [];
		for (i in 0...l.length) {
			var infs = maps(l[i]);
			var row:Array<VertexWeight> = [];
			for (inf in infs) {
				var w = new VertexWeight();
				w.bone = str(inf, "bone", "");
				w.x = num(inf, "x", 0);
				w.y = num(inf, "y", 0);
				w.weight = num(inf, "weight", 0);
				row.push(w);
			}
			out.push(row);
		}
		return out;
	}

	static function attachment(key:String, x:JObject):Attachment {
		var type = str(x, "type", "");
		var out:Attachment;
		switch (type) {
			case "region":
				var a = new RegionAttachment();
				a.image = str(x, "image", "");
				a.x = num(x, "x", 0);
				a.y = num(x, "y", 0);
				a.rotation = num(x, "rotation", 0);
				a.scaleX = num(x, "scaleX", 1);
				a.scaleY = num(x, "scaleY", 1);
				a.skewX = num(x, "skewX", 0);
				a.skewY = num(x, "skewY", 0);
				a.width = num(x, "width", 0);
				a.height = num(x, "height", 0);
				a.color = str(x, "color", "#ffffffff");
				out = a;
			case "mesh":
				var a = new MeshAttachment();
				a.image = str(x, "image", "");
				a.uvs = numsOr(x.get("uvs"));
				a.vertices = numsOr(x.get("vertices"));
				a.triangles = [for (t in numsOr(x.get("triangles"))) Std.int(t)];
				a.weights = weights(x.get("weights"));
				a.hull = Std.int(num(x, "hull", Std.int(a.vertices.length / 2)));
				a.color = str(x, "color", "#ffffffff");
				if (Std.isOfType(x.get("linked"), JObject)) {
					var l = map(x.get("linked"));
					a.linked = new LinkedMesh();
					a.linked.mesh = str(l, "mesh", "");
					a.linked.slot = str(l, "slot", null);
					a.linked.skin = str(l, "skin", null);
					a.linked.deform = bool(l, "deform", false);
				}
				out = a;
			case "shape":
				var a = new ShapeAttachment();
				a.shape = str(x, "shape", "rect");
				a.x = num(x, "x", 0);
				a.y = num(x, "y", 0);
				a.rotation = num(x, "rotation", 0);
				a.width = num(x, "width", 0);
				a.height = num(x, "height", 0);
				a.radius = num(x, "radius", 0);
				a.points = nums(x.get("points"));
				a.fill = str(x, "fill", "#ffffffff");
				a.stroke = str(x, "stroke", null);
				a.strokeWidth = optNum(x, "strokeWidth");
				out = a;
			case "boundingBox":
				var a = new BoundingBoxAttachment();
				a.vertices = numsOr(x.get("vertices"));
				out = a;
			case "point":
				var a = new PointAttachment();
				a.x = num(x, "x", 0);
				a.y = num(x, "y", 0);
				a.rotation = num(x, "rotation", 0);
				out = a;
			case "clipping":
				var a = new ClippingAttachment();
				a.vertices = numsOr(x.get("vertices"));
				a.end = str(x, "end", null);
				out = a;
			case "path":
				var a = new PathAttachment();
				a.vertices = numsOr(x.get("vertices"));
				a.weights = weights(x.get("weights"));
				a.closed = bool(x, "closed", false);
				a.color = str(x, "color", "#ff8800ff");
				out = a;
			case "sequence":
				var a = new SequenceAttachment();
				for (f in maps(x.get("frames"))) {
					var fr = new SequenceFrame();
					fr.image = str(f, "image", "");
					if (Std.isOfType(f.get("rect"), JObject)) {
						var r = map(f.get("rect"));
						fr.rect = [num(r, "x", 0), num(r, "y", 0), num(r, "width", 0), num(r, "height", 0)];
					}
					if (Std.isOfType(f.get("trim"), JObject)) {
						var t = map(f.get("trim"));
						fr.trim = [num(t, "x", 0), num(t, "y", 0), num(t, "sourceWidth", 0), num(t, "sourceHeight", 0)];
					}
					a.frames.push(fr);
				}
				a.x = num(x, "x", 0);
				a.y = num(x, "y", 0);
				a.rotation = num(x, "rotation", 0);
				a.scaleX = num(x, "scaleX", 1);
				a.scaleY = num(x, "scaleY", 1);
				a.skewX = num(x, "skewX", 0);
				a.skewY = num(x, "skewY", 0);
				a.width = num(x, "width", 0);
				a.height = num(x, "height", 0);
				a.color = str(x, "color", "#ffffffff");
				a.fps = num(x, "fps", 24);
				a.mode = str(x, "mode", "loop");
				a.offset = num(x, "offset", 0);
				a.input = str(x, "input", null);
				out = a;
			case "particles":
				// Missing fields keep the defaults (normalizeDocument fills them from defaultParticleSettings).
				var a = new ParticlesAttachment();
				a.emitting = bool(x, "emitting", a.emitting);
				a.rate = num(x, "rate", a.rate);
				if (x.exists("bursts"))
					for (b in maps(x.get("bursts"))) {
						var bu = new ParticleBurst();
						bu.time = num(b, "time", 0);
						bu.count = num(b, "count", 0);
						a.bursts.push(bu);
					}
				a.maxParticles = num(x, "maxParticles", a.maxParticles);
				a.duration = num(x, "duration", a.duration);
				a.loop = bool(x, "loop", a.loop);
				a.prewarm = bool(x, "prewarm", a.prewarm);
				a.shape = str(x, "shape", a.shape);
				a.x = num(x, "x", a.x);
				a.y = num(x, "y", a.y);
				a.rotation = num(x, "rotation", a.rotation);
				a.angle = num(x, "angle", a.angle);
				a.radius = num(x, "radius", a.radius);
				a.width = num(x, "width", a.width);
				a.height = num(x, "height", a.height);
				a.space = str(x, "space", a.space);
				a.lifetime = range(x.get("lifetime"), a.lifetime);
				a.speed = range(x.get("speed"), a.speed);
				a.gravity = num(x, "gravity", a.gravity);
				a.drag = num(x, "drag", a.drag);
				a.startSize = range(x.get("startSize"), a.startSize);
				a.endSize = range(x.get("endSize"), a.endSize);
				a.startRotation = range(x.get("startRotation"), a.startRotation);
				a.endRotation = range(x.get("endRotation"), a.endRotation);
				a.angularVelocity = range(x.get("angularVelocity"), a.angularVelocity);
				if (Std.isOfType(x.get("colors"), Array)) {
					for (c in maps(x.get("colors")))
						a.colors.push(new ColorStop(num(c, "t", 0), str(c, "color", "#ffffffff")));
				} else {
					a.colors.push(new ColorStop(0, "#ffffffff"));
					a.colors.push(new ColorStop(1, "#ffffff00"));
				}
				a.blend = str(x, "blend", a.blend);
				a.look = str(x, "look", a.look);
				a.image = str(x, "image", null);
				a.stretch = num(x, "stretch", a.stretch);
				a.seed = num(x, "seed", a.seed);
				out = a;
			case "text":
				var a = new TextAttachment();
				a.text = str(x, "text", "");
				a.x = num(x, "x", 0);
				a.y = num(x, "y", 0);
				a.rotation = num(x, "rotation", 0);
				a.width = num(x, "width", 0);
				a.height = num(x, "height", 0);
				a.font = str(x, "font", "sans-serif");
				a.size = num(x, "size", 24);
				a.weight = num(x, "weight", 400);
				a.color = str(x, "color", "#ffffffff");
				a.align = str(x, "align", "center");
				a.outline = str(x, "outline", null);
				a.outlineWidth = optNum(x, "outlineWidth");
				out = a;
			default:
				return null;
		}
		out.name = str(x, "name", key);
		return out;
	}

	static function range(v:Dynamic, def:Array<Float>):Array<Float> {
		var r = nums(v);
		return r != null && r.length >= 2 ? [r[0], r[1]] : def.copy();
	}

	static function animation(x:JObject):AnimationData {
		var a = new AnimationData();
		a.id = str(x, "id", "");
		a.name = str(x, "name", "");
		a.duration = num(x, "duration", 0);
		for (t in maps(x.get("timelines"))) {
			var tl = new Timeline();
			tl.target = str(t, "target", "");
			tl.id = str(t, "id", "");
			tl.property = str(t, "property", "");
			tl.attachment = str(t, "attachment", null);
			var keys = maps(t.get("keys"));
			var forceStep = tl.target == "bone" && tl.property == "inherit";
			for (k in keys) {
				var key = new Key();
				key.time = num(k, "time", 0);
				var v:Dynamic = k.get("value");
				if (Std.isOfType(v, Array)) {
					var l:Array<Dynamic> = v;
					if (tl.target == "drawOrder") {
						var ids:Array<String> = [for (e in l) e == null ? null : JsNum.str(e)];
						v = ids;
					} else
						v = numsOr(v);
				}
				key.value = v;
				key.curve = forceStep ? Curve.STEPPED : curve(k.get("curve"));
				tl.keys.push(key);
			}
			a.timelines.push(tl);
		}
		for (e in maps(x.get("events"))) {
			var k = new EventKey();
			k.time = num(e, "time", 0);
			k.event = str(e, "event", "");
			k.intValue = optNum(e, "int");
			k.floatValue = optNum(e, "float");
			k.stringValue = str(e, "string", null);
			a.events.push(k);
		}
		for (e in maps(x.get("audio"))) {
			var k = new AudioKey();
			k.time = num(e, "time", 0);
			k.sound = str(e, "sound", "");
			k.volume = optNum(e, "volume");
			k.rate = optNum(e, "rate");
			k.loop = Std.isOfType(e.get("loop"), Bool) ? (e.get("loop") : Bool) : null;
			a.audio.push(k);
		}
		return a;
	}

	static function curve(c:Dynamic):Curve {
		if (c == "stepped")
			return Curve.STEPPED;
		if (Std.isOfType(c, Array)) {
			var b = numsOr(c);
			if (b.length >= 4)
				return Curve.makeBezier(b[0], b[1], b[2], b[3]);
		}
		return Curve.LINEAR;
	}

	static function stateMachine(x:JObject):StateMachineData {
		var sm = new StateMachineData();
		sm.id = str(x, "id", "");
		sm.name = str(x, "name", "");
		for (i in maps(x.get("inputs"))) {
			var inp = new SmInput();
			inp.id = str(i, "id", "");
			inp.name = str(i, "name", "");
			inp.type = str(i, "type", "number");
			inp.defaultValue = i.get("default");
			sm.inputs.push(inp);
		}
		for (b in maps(x.get("bindings"))) {
			var bi = new SmBinding();
			bi.id = str(b, "id", "");
			bi.input = str(b, "input", "");
			bi.target = str(b, "target", "");
			bi.object = str(b, "object", "");
			bi.property = str(b, "property", "");
			bi.inMin = num(b, "inMin", 0);
			bi.inMax = num(b, "inMax", 0);
			bi.outMin = b.get("outMin");
			bi.outMax = b.get("outMax");
			sm.bindings.push(bi);
		}
		for (l in maps(x.get("layers"))) {
			var layer = new SmLayer();
			layer.id = str(l, "id", "");
			layer.name = str(l, "name", "");
			layer.entry = str(l, "entry", null);
			for (s in maps(l.get("states"))) {
				var st = new SmState();
				st.id = str(s, "id", "");
				st.name = str(s, "name", "");
				st.type = str(s, "type", "animation");
				st.animation = str(s, "animation", null);
				st.loop = bool(s, "loop", false);
				st.speed = num(s, "speed", 1);
				st.blendInput = str(s, "blendInput", null);
				for (e in maps(s.get("blend"))) {
					var be = new SmBlendEntry();
					be.animation = str(e, "animation", "");
					be.value = num(e, "value", 0);
					st.blend.push(be);
				}
				for (sc in strs(s.get("scripts")))
					st.scripts.push(sc);
				for (e in maps(s.get("sounds"))) {
					var so = new SmSound();
					so.sound = str(e, "sound", "");
					so.on = str(e, "on", "enter");
					so.action = str(e, "action", "play");
					so.volume = optNum(e, "volume");
					st.sounds.push(so);
				}
				for (e in maps(s.get("emitters"))) {
					var em = new SmEmitter();
					em.slot = str(e, "slot", "");
					em.emitting = bool(e, "emitting", false);
					st.emitters.push(em);
				}
				for (e in maps(s.get("inputs"))) {
					var si = new SmStateInput();
					si.input = str(e, "input", "");
					si.value = e.get("value");
					st.inputs.push(si);
				}
				st.onComplete = str(s, "onComplete", null);
				layer.states.push(st);
			}
			for (t in maps(l.get("transitions"))) {
				var tr = new SmTransition();
				tr.id = str(t, "id", "");
				tr.from = str(t, "from", "");
				tr.to = str(t, "to", "");
				for (c in maps(t.get("conditions"))) {
					var co = new SmCondition();
					co.input = str(c, "input", "");
					co.op = str(c, "op", "==");
					co.value = c.get("value");
					tr.conditions.push(co);
				}
				tr.duration = num(t, "duration", 0);
				tr.exitTime = optNum(t, "exitTime");
				layer.transitions.push(tr);
			}
			sm.layers.push(layer);
		}
		for (l in maps(x.get("listeners"))) {
			var li = new SmListener();
			li.id = str(l, "id", "");
			li.name = str(l, "name", "");
			li.slot = str(l, "slot", null);
			li.event = str(l, "event", "click");
			for (a in maps(l.get("actions"))) {
				var ac = new SmAction();
				ac.type = str(a, "type", "");
				ac.input = str(a, "input", null);
				ac.event = str(a, "event", null);
				ac.script = str(a, "script", null);
				ac.fn = str(a, "fn", null);
				ac.sound = str(a, "sound", null);
				ac.slot = str(a, "slot", null);
				ac.value = a.get("value");
				ac.volume = optNum(a, "volume");
				ac.fade = optNum(a, "fade");
				ac.emitting = bool(a, "emitting", false);
				ac.count = num(a, "count", 0);
				li.actions.push(ac);
			}
			sm.listeners.push(li);
		}
		for (sc in strs(x.get("scripts")))
			sm.scripts.push(sc);
		return sm;
	}

	static function audio(m:JObject):AudioData {
		var a = new AudioData();
		a.master = num(m, "master", 1);
		a.muted = bool(m, "muted", false);
		for (x in maps(m.get("assets"))) {
			var as = new AudioAsset();
			as.id = str(x, "id", "");
			as.name = str(x, "name", "");
			as.src = str(x, "src", "");
			as.duration = num(x, "duration", 0);
			a.assets.push(as);
		}
		for (x in maps(m.get("buses"))) {
			var b = new AudioBus();
			b.id = str(x, "id", "");
			b.name = str(x, "name", "");
			b.volume = num(x, "volume", 1);
			b.muted = bool(x, "muted", false);
			a.buses.push(b);
		}
		for (x in maps(m.get("sounds"))) {
			var s = new SoundData();
			s.id = str(x, "id", "");
			s.name = str(x, "name", "");
			s.asset = str(x, "asset", "");
			s.bus = str(x, "bus", null);
			s.volume = num(x, "volume", 1);
			s.rate = num(x, "rate", 1);
			s.loop = bool(x, "loop", false);
			s.fadeIn = num(x, "fadeIn", 0);
			s.fadeOut = num(x, "fadeOut", 0);
			a.sounds.push(s);
		}
		return a;
	}

	// ---------------- Binary (.obonb) ----------------

	public static function isBinary(b:Bytes):Bool {
		return b.length >= 5 && b.get(0) == 0x4f && b.get(1) == 0x42 && b.get(2) == 0x4e && b.get(3) == 0x42;
	}

	/** Decode .obonb bytes (core/binary.ts): float32 values are rounded to 7 significant digits. */
	public static function fromBinary(bytes:Bytes):OpenBoneDocument {
		return fromTree(decodeBinary(bytes));
	}

	/** Decode .obonb bytes to the JSON tree they encode (before validation and defaults). */
	public static function decodeBinary(bytes:Bytes):Dynamic {
		if (!isBinary(bytes))
			throw "Not an OpenBone binary document (missing OBNB header)";
		var version = bytes.get(4);
		if (version > 1)
			throw "Binary version " + version + " is newer than supported 1";
		var r = new BinReader(bytes);
		var count = r.varint();
		var strings:Array<String> = [];
		for (i in 0...Std.int(count)) {
			var n = Std.int(r.varint());
			if (r.p + n > bytes.length)
				throw r.fail();
			strings.push(bytes.getString(r.p, n, UTF8));
			r.p += n;
		}
		r.strings = strings;
		return r.value();
	}

	// ---------------- Tree helpers ----------------

	public static function map(v:Dynamic):JObject {
		return Std.isOfType(v, JObject) ? v : new JObject();
	}

	public static function maps(v:Dynamic):Array<JObject> {
		var out:Array<JObject> = [];
		if (Std.isOfType(v, Array))
			for (o in (v : Array<Dynamic>))
				if (Std.isOfType(o, JObject))
					out.push(o);
		return out;
	}

	public static function strs(v:Dynamic):Array<String> {
		var out:Array<String> = [];
		if (Std.isOfType(v, Array))
			for (o in (v : Array<Dynamic>))
				if (o != null)
					out.push(JsNum.str(o));
		return out;
	}

	public static function nums(v:Dynamic):Array<Float> {
		if (!Std.isOfType(v, Array))
			return null;
		var l:Array<Dynamic> = v;
		return [for (x in l) JsNum.isNum(x) ? (x : Float) : Math.NaN];
	}

	public static function numsOr(v:Dynamic):Array<Float> {
		var r = nums(v);
		return r == null ? [] : r;
	}

	public static function num(m:JObject, k:String, def:Float):Float {
		var v:Dynamic = m.get(k);
		return JsNum.isNum(v) ? (v : Float) : def;
	}

	public static function optNum(m:JObject, k:String):Null<Float> {
		var v:Dynamic = m.get(k);
		return JsNum.isNum(v) ? (v : Float) : null;
	}

	public static function str(m:JObject, k:String, def:String):String {
		var v:Dynamic = m.get(k);
		return Std.isOfType(v, String) ? v : def;
	}

	public static function bool(m:JObject, k:String, def:Bool):Bool {
		var v:Dynamic = m.get(k);
		return Std.isOfType(v, Bool) ? v : def;
	}
}

private class BinReader {
	final b:Bytes;

	public var p = 5;
	public var strings:Array<String>;

	public function new(b:Bytes) {
		this.b = b;
	}

	public function fail():String {
		return "Corrupt OpenBone binary document";
	}

	public function varint():Float {
		var n = 0.0;
		var mul = 1.0;
		while (true) {
			if (p >= b.length)
				throw fail();
			var x = b.get(p++);
			n += (x & 0x7f) * mul;
			if (x < 0x80)
				return n;
			mul *= 0x80;
			if (mul > Math.pow(2, 56))
				throw fail();
		}
	}

	function str():String {
		var i = varint();
		if (i >= strings.length)
			throw fail();
		return strings[Std.int(i)];
	}

	public function value():Dynamic {
		if (p >= b.length)
			throw fail();
		var tag = b.get(p++);
		switch (tag) {
			case 0:
				return null;
			case 1:
				return false;
			case 2:
				return true;
			case 3:
				return varint();
			case 4:
				return -varint() - 1;
			case 5:
				if (p + 4 > b.length)
					throw fail();
				var bits = b.getInt32(p);
				p += 4;
				return JsNum.roundPrecision(JsNum.floatFromBits(bits), 7);
			case 6:
				if (p + 8 > b.length)
					throw fail();
				var lo = b.getInt32(p), hi = b.getInt32(p + 4);
				p += 8;
				return JsNum.doubleFromBits(lo, hi);
			case 7:
				return str();
			case 8:
				var n = Std.int(varint());
				var a:Array<Dynamic> = [];
				for (i in 0...n)
					a.push(value());
				return a;
			case 9:
				var n = Std.int(varint());
				var o = new JObject();
				for (i in 0...n) {
					var k = str();
					o.set(k, value());
				}
				return o;
			case 10:
				var mime = str();
				var n = Std.int(varint());
				if (p + n > b.length)
					throw fail();
				var data = b.sub(p, n);
				p += n;
				return "data:" + mime + ";base64," + haxe.crypto.Base64.encode(data);
			default:
				throw fail();
		}
	}
}
