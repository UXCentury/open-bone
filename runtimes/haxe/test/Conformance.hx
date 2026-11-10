import openbone.AudioDirector;
import openbone.DrawItem;
import openbone.JsNum;
import openbone.Json;
import openbone.OpenBoneInstance;
import openbone.ScriptHost;
import openbone.SkeletonBounds;
import openbone.StateMachineInstance;
import openbone.data.DocumentLoader;
import openbone.data.Model;

/** Records events and audio commands between samples (play ids renumbered p1, p2…). */
private class Recorder extends InstanceListener {
	public final events:Array<FiredEvent> = [];
	public final commands:Array<JObject> = [];

	final ids:Map<String, String> = new Map();
	var count = 0;

	override public function event(e:FiredEvent):Void {
		events.push(e);
	}

	override public function audio(c:AudioCommand):Void {
		var id = ids.get(c.id);
		if (id == null) {
			id = "p" + (++count);
			ids.set(c.id, id);
		}
		var m = c.toObject();
		m.set("id", id);
		commands.push(m);
	}
}

/** A file's top-level bounding-box `queries`, with the other skeletons for `others` posed once. */
private class BoundsQueries {
	public final points:Array<Array<Float>> = [];
	public final segments:Array<Array<Float>> = [];
	public final aabbs:Array<Array<Float>> = [];
	public final others:Array<SkeletonBounds> = [];

	public function new(q:JObject, doc:OpenBoneDocument, host:ScriptHost) {
		for (p in list(q, "points"))
			points.push(p);
		for (p in list(q, "segments"))
			segments.push(p);
		for (p in list(q, "aabbs"))
			aabbs.push(p);
		for (p in list(q, "others")) {
			var xy:Array<Float> = p;
			var o = new OpenBoneInstance(doc, host);
			o.skeleton.x = xy[0];
			o.skeleton.y = xy[1];
			o.advance(0);
			others.push(o.skeleton.boundingBoxes());
			o.dispose();
		}
	}

	static function list(q:JObject, k:String):Array<Dynamic> {
		var v:Dynamic = q.get(k);
		return v == null ? [] : v;
	}
}

private class ErrorLog extends StateMachineListener {
	public final errors:Array<String> = [];

	override public function error(e:Dynamic):Void {
		errors.push(Std.string(e));
	}
}

/**
 * Runs every case of conformance/expected/*.json exactly like conformance/generate.ts and compares every sample with
 * the tolerances in conformance/README.md (the same checks as the Java, C# and C++ runners).
 *
 * Arguments: `--repo <path>` (default ../..), `--only <file name>`, `--verbose`.
 */
class Conformance {
	static inline final DT = 1.0 / 60;
	static inline final SAMPLE_EVERY = 10;
	static inline final TOL_XY = 1e-3;
	static inline final TOL_ABCD = 1e-4;
	static inline final TOL_COLOR = 1.0 / 255;
	static inline final TOL_VERT = 1e-3;
	static inline final TOL_PARTICLE = 1e-2;
	static inline final TOL_NUM = 1e-4;

	/** Slack for comparing two 4-decimal values. */
	static inline final EPS = 1e-7;

	static function main() {
		var args = Platform.args();
		var repo = "../..";
		var only:String = null;
		var verbose = false;
		var i = 0;
		while (i < args.length) {
			switch (args[i]) {
				case "--repo":
					repo = args[++i];
				case "--only":
					only = args[++i];
				case "--verbose":
					verbose = true;
				default:
			}
			i++;
		}
		var envRepo = Platform.env("OPENBONE_REPO");
		if (envRepo != null && envRepo.length > 0)
			repo = envRepo;
		var host:ScriptHost = #if js new openbone.JsScriptHost() #else null #end;
		var dir = repo + "/conformance/expected";
		var files = [for (f in Platform.listDir(dir)) if (StringTools.endsWith(f, ".json")) f];
		files.sort((a, b) -> a < b ? -1 : a > b ? 1 : 0);
		if (files.length == 0)
			throw "No expected files in " + dir;
		var passed = 0, failed = 0, skipped = 0;
		var failures:Array<String> = [];
		var skips:Array<String> = [];
		var t0 = Platform.now();
		for (f in files) {
			var name = f.substr(0, f.length - 5);
			if (only != null && name != only)
				continue;
			var exp:JObject = Json.parse(Platform.readText(dir + "/" + f));
			var doc = DocumentLoader.load(Platform.readBytes(repo + "/" + exp.get("document")));
			var cases:Array<Dynamic> = exp.get("cases");
			var queries = exp.exists("queries") ? new BoundsQueries(exp.get("queries"), doc, host) : null;
			var filePass = 0;
			for (c in cases) {
				var cm:JObject = c;
				var caseName:String = cm.get("name");
				if (host == null && cm.get("kind") == "stateMachine" && needsScripts(doc, cm.get("stateMachine"))) {
					skipped++;
					skips.push(name + " " + caseName);
					continue;
				}
				try {
					runCase(name, doc, host, cm, queries);
					passed++;
					filePass++;
					if (verbose)
						Platform.println("  ok   " + name + " " + caseName);
				} catch (e:Dynamic) {
					failed++;
					var msg = Std.string(e);
					failures.push(msg);
					Platform.println("  FAIL " + msg);
				}
			}
			Platform.println((filePass == cases.length ? "PASS " : "     ") + name + ": " + filePass + "/" + cases.length);
		}
		var total = passed + failed + skipped;
		if (skips.length > 0) {
			Platform.println("Skipped (state machine scripts need a JavaScript engine; this target has no script host):");
			for (s in skips)
				Platform.println("  - " + s);
		}
		Platform.println("Haxe (" + Platform.target() + ") conformance: " + passed + "/" + total + " passed, " + skipped + " skipped, " + failed + " failed ("
			+ Math.round((Platform.now() - t0) * 10) / 10 + " s)");
		Platform.exit(failed > 0 ? 1 : 0);
	}

	/** Whether a state machine runs scripts (machine scripts, state scripts or runScript listener actions). */
	static function needsScripts(doc:OpenBoneDocument, machine:String):Bool {
		var sm = doc.findStateMachine(machine);
		if (sm == null)
			return false;
		for (id in sm.scripts)
			if (doc.scriptById(id) != null)
				return true;
		for (l in sm.layers)
			for (s in l.states)
				for (id in s.scripts)
					if (doc.scriptById(id) != null)
						return true;
		for (li in sm.listeners)
			for (a in li.actions)
				if (a.type == "runScript" && doc.scriptById(a.script) != null)
					return true;
		return false;
	}

	static function r4(n:Float):Float {
		var r = Math.ffloor(n * 1e4);
		var v = (n * 1e4 - r >= 0.5 ? r + 1 : r) / 1e4;
		return v == 0 ? 0 : v;
	}

	static function runCase(file:String, doc:OpenBoneDocument, host:ScriptHost, c:JObject, queries:BoundsQueries):Void {
		var kind:String = c.get("kind");
		var name:String = c.get("name");
		var samples:Array<Dynamic> = c.get("samples");
		var duration:Float = c.get("duration");
		var steps = Math.round(duration / DT);
		var inst = new OpenBoneInstance(doc, host);
		var errors = new ErrorLog();
		var machine:StateMachineInstance = null;
		var actions:Array<JObject> = [];
		if (kind == "stateMachine") {
			machine = inst.useStateMachine(c.get("stateMachine"));
			for (a in (c.get("actions") : Array<Dynamic>))
				actions.push(a);
			machine.addListener(errors);
		} else {
			inst.skeleton.setSkin(c.get("skin"));
			if (kind == "animation")
				inst.play(c.get("animation"), true);
		}
		var rec = new Recorder();
		inst.addListener(rec);
		var si = 0;
		inst.advance(0);
		compare(file + " " + name, 0, inst, rec, samples[si++], queries);
		for (i in 1...steps + 1) {
			var t = (i - 1) * DT;
			for (a in actions) {
				if (Math.abs((a.get("t") : Float) - t) > DT / 2)
					continue;
				if (a.exists("fire"))
					machine.fire(a.get("fire"));
				else if (a.exists("input"))
					machine.setInput(a.get("input"), a.get("value"));
				else
					inst.pointer(a.get("pointer"), a.get("x"), a.get("y"));
			}
			inst.advance(DT);
			if (i % SAMPLE_EVERY == 0)
				compare(file + " " + name, i * DT, inst, rec, samples[si++], queries);
		}
		inst.dispose();
		if (si != samples.length)
			throw file + " " + name + ": produced " + si + " samples, expected " + samples.length;
		if (errors.errors.length > 0)
			throw file + " " + name + ": script errors " + errors.errors;
	}

	static function compare(caseName:String, t:Float, inst:OpenBoneInstance, rec:Recorder, exp:JObject, queries:BoundsQueries):Void {
		var where = caseName + " t=" + r4(t);
		num(where + " t", r4(t), exp.get("t"), 1e-9);
		var sk = inst.skeleton;
		var bones:Array<Dynamic> = exp.get("bones");
		eq(where + " bone count", sk.bones.length, bones.length);
		for (i in 0...bones.length) {
			var b = sk.bones[i];
			var e:Array<Dynamic> = bones[i];
			var w = [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y];
			for (k in 0...6)
				num(where + " bone " + b.data.name + "[" + "abcdxy".charAt(k) + "]", w[k], e[k], k < 4 ? TOL_ABCD : TOL_XY);
		}
		var slots:Array<Dynamic> = exp.get("slots");
		eq(where + " slot count", sk.slots.length, slots.length);
		for (i in 0...slots.length) {
			var s = sk.slots[i];
			var e:Array<Dynamic> = slots[i];
			var w = where + " slot " + s.data.name;
			eq(w + " attachment", s.attachmentName, e[0]);
			nums(w + " color", s.color, e[1], TOL_COLOR, 4);
			if (e[2] == null)
				eq(w + " dark", s.dark == null ? null : "set", null);
			else {
				if (s.dark == null)
					throw w + " dark: expected " + Json.stringify(e[2]) + " got null";
				nums(w + " dark", s.dark, e[2], TOL_COLOR, 3);
			}
		}
		var draw = sk.drawList();
		var ed:Array<Dynamic> = exp.get("draw");
		if (draw.length != ed.length) {
			var got = [for (d in draw) d.slot.data.name + ":" + d.attachment.name];
			var want = [for (o in ed) (o : JObject).get("slot") + ":" + (o : JObject).get("attachment")];
			throw where + " draw list: got " + got + " expected " + want;
		}
		var clips:Array<ClipRegion> = [];
		for (i in 0...draw.length) {
			var d = draw[i];
			var e:JObject = ed[i];
			var w = where + " draw[" + i + "] " + d.slot.data.name + "/" + d.attachment.name;
			eq(w + " slot", d.slot.data.name, e.get("slot"));
			eq(w + " attachment", d.attachment.name, e.get("attachment"));
			eq(w + " type", d.kind(), e.get("type"));
			eq(w + " blend", d.blend, e.get("blend"));
			eq(w + " texture", d.texture == null ? null : d.texture.id, e.get("texture"));
			var particles = d.particleLook != null;
			nums(w + " vertices", d.vertices, e.get("vertices"), particles ? TOL_PARTICLE : TOL_VERT, -1);
			nums(w + " uvs", d.uvs, e.get("uvs"), TOL_VERT, -1);
			var ei:Array<Dynamic> = e.get("indices");
			eq(w + " index count", d.indices.length, ei.length);
			for (k in 0...ei.length)
				if (d.indices[k] != Std.int(ei[k]))
					throw w + " indices: got " + d.indices + " expected " + Json.stringify(ei);
			nums(w + " color", d.color, e.get("color"), TOL_COLOR, 4);
			if (e.exists("dark") != (d.dark != null))
				throw w + " dark presence: got " + (d.dark != null) + " expected " + e.exists("dark");
			if (d.dark != null)
				nums(w + " dark", d.dark, e.get("dark"), TOL_COLOR, 3);
			if (e.exists("colors") != (d.colors != null))
				throw w + " colors presence";
			if (d.colors != null)
				nums(w + " colors", d.colors, e.get("colors"), TOL_COLOR, -1);
			var clip:Null<Int> = null;
			if (d.clip != null) {
				if (clips.indexOf(d.clip) < 0)
					clips.push(d.clip);
				clip = clips.indexOf(d.clip);
			}
			var ec:Dynamic = e.get("clip");
			eq(w + " clip", clip, ec == null ? null : Std.int(ec));
			eq(w + " text", d.text == null ? null : d.text.content, e.get("text"));
		}
		var ee:Array<Dynamic> = exp.get("events");
		if (ee.length != rec.events.length)
			throw where + " events: got " + [for (x in rec.events) x.toString()] + " expected " + Json.stringify(ee);
		for (i in 0...ee.length) {
			var e:JObject = ee[i];
			var f = rec.events[i];
			var w = where + " event[" + i + "] " + f.name;
			eq(w + " name", f.name, e.get("name"));
			num(w + " time", r4(f.time), e.get("time"), TOL_NUM);
			num(w + " int", f.intValue, e.get("int"), 0);
			num(w + " float", f.floatValue, e.get("float"), TOL_NUM);
			eq(w + " string", f.stringValue, e.get("string"));
		}
		var ea:Array<Dynamic> = exp.get("audio");
		if (ea.length != rec.commands.length)
			throw where + " audio: got " + Json.stringify(rec.commands) + " expected " + Json.stringify(ea);
		for (i in 0...ea.length) {
			var e:JObject = ea[i];
			var g = rec.commands[i];
			var w = where + " audio[" + i + "]";
			var sameKeys = e.keys.length == g.keys.length;
			for (k in e.keys)
				if (!g.exists(k))
					sameKeys = false;
			if (!sameKeys)
				throw w + " keys: got " + Json.stringify(g) + " expected " + Json.stringify(e);
			for (k in e.keys) {
				var ev:Dynamic = e.get(k), gv:Dynamic = g.get(k);
				if (JsNum.isNum(ev))
					num(w + " " + k, gv, ev, TOL_NUM);
				else
					eq(w + " " + k, gv, ev);
			}
		}
		if (exp.exists("states")) {
			var es:JObject = exp.get("states");
			var got = inst.stateMachine.activeStates();
			var same = got.keys.length == es.keys.length;
			for (k in es.keys)
				if (!got.exists(k) || got.get(k) != es.get(k))
					same = false;
			if (!same)
				throw where + " states: got " + [for (k in got.keys) k + "=" + got.get(k)] + " expected " + Json.stringify(es);
		}
		if (exp.exists("bounds") != (queries != null))
			throw where + " bounds presence: got " + (queries != null) + " expected " + exp.exists("bounds");
		if (queries != null)
			compareBounds(where + " bounds", sk.boundingBoxes(), exp.get("bounds"), queries);
		rec.events.resize(0);
		rec.commands.resize(0);
	}

	/** Bounding-box queries (conformance/README.md "Bounding-box queries", docs/runtime-spec.md §8.10). */
	static function compareBounds(where:String, b:SkeletonBounds, e:JObject, q:BoundsQueries):Void {
		var eb:Array<Dynamic> = e.get("boxes");
		if (b.boxes.length != eb.length)
			throw where + " boxes: got " + [for (x in b.boxes) x.slot.data.name + ":" + x.attachment] + " expected "
				+ [for (o in eb) (o : JObject).get("slot") + ":" + (o : JObject).get("attachment")];
		for (i in 0...eb.length) {
			var box = b.boxes[i];
			var o:JObject = eb[i];
			var w = where + " box[" + i + "]";
			eq(w + " slot", box.slot.data.name, o.get("slot"));
			eq(w + " attachment", box.attachment, o.get("attachment"));
			nums(w + " vertices", box.vertices, o.get("vertices"), TOL_VERT, -1);
		}
		var ea:Array<Dynamic> = e.get("aabb");
		if (ea == null) {
			if (b.boxes.length > 0)
				throw where + " aabb: got [" + b.minX + ", " + b.minY + ", " + b.maxX + ", " + b.maxY + "] expected null";
		} else
			nums(where + " aabb", [b.minX, b.minY, b.maxX, b.maxY], ea, TOL_VERT, -1);
		var idx = (list:Array<BoundingBoxPolygon>) -> [for (x in list) b.boxes.indexOf(x)];
		var first = (x:Null<BoundingBoxPolygon>) -> x == null ? -1 : b.boxes.indexOf(x);
		var ep:Array<Dynamic> = e.get("points");
		eq(where + " point count", ep.length, q.points.length);
		for (i in 0...ep.length) {
			var p = q.points[i];
			var w = where + " point " + Json.stringify(p);
			var got = idx(b.containsPointAll(p[0], p[1]));
			ints(w + " containsPointAll", got, ep[i]);
			eq(w + " containsPoint", first(b.containsPoint(p[0], p[1])), got.length > 0 ? got[0] : -1);
		}
		var es:Array<Dynamic> = e.get("segments");
		eq(where + " segment count", es.length, q.segments.length);
		for (i in 0...es.length) {
			var p = q.segments[i];
			var w = where + " segment " + Json.stringify(p);
			var got = idx(b.intersectsSegmentAll(p[0], p[1], p[2], p[3]));
			ints(w + " intersectsSegmentAll", got, es[i]);
			eq(w + " intersectsSegment", first(b.intersectsSegment(p[0], p[1], p[2], p[3])), got.length > 0 ? got[0] : -1);
		}
		var er:Array<Dynamic> = e.get("aabbs");
		eq(where + " aabb query count", er.length, q.aabbs.length);
		for (i in 0...er.length) {
			var p = q.aabbs[i];
			eq(where + " aabbIntersects " + Json.stringify(p), b.aabbIntersects(p[0], p[1], p[2], p[3]), er[i]);
		}
		var eo:Array<Dynamic> = e.get("others");
		eq(where + " others count", eo.length, q.others.length);
		for (i in 0...eo.length) {
			var o = q.others[i];
			var pair = b.intersectsBounds(o);
			var got = pair == null ? null : [b.boxes.indexOf(pair[0]), o.boxes.indexOf(pair[1])];
			var w = where + " others[" + i + "] intersectsBounds";
			if (eo[i] == null) {
				if (got != null)
					throw w + ": got " + got + " expected null";
			} else {
				if (got == null)
					throw w + ": got null expected " + Json.stringify(eo[i]);
				ints(w, got, eo[i]);
			}
		}
	}

	/** Index lists compared exactly. */
	static function ints(what:String, got:Array<Int>, want:Array<Dynamic>):Void {
		var same = got.length == want.length;
		if (same)
			for (k in 0...want.length)
				if (got[k] != Std.int(want[k]))
					same = false;
		if (!same)
			throw what + ": got " + got + " expected " + Json.stringify(want);
	}

	static function eq(what:String, got:Dynamic, want:Dynamic):Void {
		var same = got == null ? want == null : want != null && got == want;
		if (!same && JsNum.isNum(got) && JsNum.isNum(want))
			same = (got : Float) == (want : Float);
		if (!same)
			throw what + ": got " + Std.string(got) + " expected " + Std.string(want);
	}

	static function num(what:String, got:Float, want:Dynamic, tol:Float):Void {
		var w:Float = want;
		var g = r4(got);
		if (!(Math.abs(g - w) <= tol + EPS))
			throw what + ": got " + got + " expected " + w + " (tolerance " + tol + ")";
	}

	/** Compare the first n values (n = -1: all, lengths must match). */
	static function nums(what:String, got:Array<Float>, want:Array<Dynamic>, tol:Float, n:Int):Void {
		if (n < 0) {
			if (got.length != want.length)
				throw what + ": got " + got.length + " values, expected " + want.length + " " + Json.stringify(want);
			n = got.length;
		}
		for (i in 0...n) {
			var w:Float = want[i];
			var g = r4(got[i]);
			if (!(Math.abs(g - w) <= tol + EPS))
				throw what + "[" + i + "]: got " + got[i] + " expected " + w + " (tolerance " + tol + ")\n  got " + Json.stringify(got) + "\n  exp "
					+ Json.stringify(want);
		}
	}
}
