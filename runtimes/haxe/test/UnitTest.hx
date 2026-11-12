import openbone.AudioDirector;
import openbone.Earcut;
import openbone.JsNum;
import openbone.Json;
import openbone.MathUtil;
import openbone.OpenBoneInstance;
import openbone.ParticleEmitter;
import openbone.Template;
import openbone.data.DocumentLoader;

/** Porting traps from docs/runtime-spec.md §12 that the suite only covers indirectly. Run from runtimes/haxe. */
class UnitTest {
	static var checks = 0;
	static var failures:Array<String> = [];

	static function main() {
		jsNumberStrings();
		templates();
		rngMatchesMulberry32();
		earcutSquareAndConcave();
		angles();
		binaryDocumentsDecodeLikeTypeScript();
		documentFonts();
		setMuteOverridesTheDocumentMix();
		for (f in failures)
			Platform.println("  FAIL " + f);
		Platform.println("Haxe (" + Platform.target() + ") unit tests: " + (checks - failures.length) + "/" + checks + " passed");
		Platform.exit(failures.length > 0 ? 1 : 0);
	}

	static function eq(what:String, got:Dynamic, want:Dynamic):Void {
		checks++;
		var same = got == want || (JsNum.isNum(got) && JsNum.isNum(want) && (got : Float) == (want : Float));
		if (!same)
			failures.push(what + ": got " + Std.string(got) + " expected " + Std.string(want));
	}

	static function jsNumberStrings() {
		eq("String(0.1)", JsNum.toString(0.1), "0.1");
		eq("String(0.1+0.2)", JsNum.toString(0.1 + 0.2), "0.30000000000000004");
		eq("String(1e21)", JsNum.toString(1e21), "1e+21");
		eq("String(123456789012345678901)", JsNum.toString(123456789012345678901.0), "123456789012345680000");
		eq("String(1e-7)", JsNum.toString(1e-7), "1e-7");
		eq("String(1e-6)", JsNum.toString(1e-6), "0.000001");
		eq("String(-2.5)", JsNum.toString(-2.5), "-2.5");
		eq("String(5e-324)", JsNum.toString(5e-324), "5e-324");
		eq("(2.5).toFixed(0)", JsNum.toFixed(2.5, 0), "3");
		eq("(1.005+1e-12).toFixed(2)", JsNum.toFixed(1.005 + 1e-12, 2), "1.01");
		eq("(1.005).toFixed(2)", JsNum.toFixed(1.005, 2), "1.00"); // 1.005 is 1.00499999… in binary
		eq("(-0.0001).toFixed(2)", JsNum.toFixed(-0.0001, 2), "-0.00");
		eq("(0.035).toFixed(2)", JsNum.toFixed(0.035, 2), "0.04");
		eq("Number(f32(0.42).toPrecision(7))", JsNum.roundPrecision(JsNum.f32(0.42), 7), 0.42);
		eq("fround(0.1)", JsNum.f32(0.1), 0.10000000149011612);
		eq("fround(16777217)", JsNum.f32(16777217), 16777216);
		eq("fround(16777219)", JsNum.f32(16777219), 16777220); // tie to even
		eq("fround(3.5e38)", JsNum.f32(3.5e38), Math.POSITIVE_INFINITY);
		eq("float bits 0x3f800001", JsNum.floatFromBits(0x3f800001), 1.0000001192092896);
		eq("Number('0x1f')", JsNum.parse("0x1f"), 31);
		eq("Number(' 12 ')", JsNum.parse(" 12 "), 12);
		eq("Number('1e')", Math.isNaN(JsNum.parse("1e")), true);
		eq("Number('')", JsNum.parse(""), 0);
		eq("Math.round(-2.5)", JsNum.round(-2.5), -2);
	}

	static function templates() {
		var v = new Map<String, Dynamic>();
		v.set("m", 2.349);
		v.set("n", 12345.5);
		v.set("s", "hi");
		v.set("b", true);
		var get = (k:String) -> v.get(k);
		eq("{m:0.00}x", Template.format("{m:0.00}x", get), "2.35x");
		eq("{n:$#,##0.00}", Template.format("{n:$#,##0.00}", get), "$12,345.50");
		eq("{m:+0%}", Template.format("{m:+0%}", get), "+235%");
		eq("plain values", Template.format("{s} {b} {missing} {{", get), "hi true {missing} {");
		eq("}} and {a:{", Template.format("}} {m:{x} }", get), "} {m:{x} }");
		eq("#.##", Template.formatNumber(0.349, "#.##"), ".35");
		eq("#,##0 of a million", Template.formatNumber(1234567.891, "#,##0"), "1,234,568");
		eq("-0.00 sign", Template.formatNumber(-0.001, "0.00"), "0.00");
		eq("no digits pattern", Template.formatNumber(5, "abc"), "5abc");
		eq("plain(1/3)", Template.plain(1.0 / 3), "0.333333");
	}

	static function rngMatchesMulberry32() {
		// Values printed by the TypeScript Rng(1) / hashString.
		var r = new Rng(1);
		eq("rng 1", r.next(), 0.6270739405881613);
		eq("rng 2", r.next(), 0.002735721180215478);
		var h = ParticleEmitter.hashString("fx");
		eq("fnv1a fx", h < 0 ? h + 4294967296.0 : h, 0x4d22c733);
		eq("ToInt32(2^32 + 5)", ParticleEmitter.toInt32(4294967301.0), 5);
		eq("ToInt32(-1.5)", ParticleEmitter.toInt32(-1.5), -1);
	}

	static function earcutSquareAndConcave() {
		eq("earcut square", Json.stringify(Earcut.triangulate([0, 0, 10, 0, 10, 10, 0, 10])), "[2,3,0,2,0,1]");
		eq("earcut quad", Json.stringify(Earcut.triangulate([10, 0, 0, 50, 60, 60, 70, 10])), "[1,0,3,1,3,2]");
	}

	static function angles() {
		eq("wrapDeg(540)", MathUtil.wrapDeg(540), 180);
		eq("wrapDeg(-180)", MathUtil.wrapDeg(-180), 180);
		eq("wrapDeg(-190)", MathUtil.wrapDeg(-190), 170);
		eq("parseHex(#f80)", Json.stringify(MathUtil.parseHex("#f80")), Json.stringify([1, 136 / 255, 0, 1]));
	}

	/** .obonb decoding (float32 → 7 significant digits) matches deserializeBinary in the TypeScript core. */
	static function binaryDocumentsDecodeLikeTypeScript() {
		for (name in ["transforms", "walker"]) {
			var bytes = Platform.readBytes("test/data/" + name + ".obonb");
			var mine:Dynamic = DocumentLoader.decodeBinary(bytes);
			var ts:Dynamic = Json.parse(Platform.readText("test/data/" + name + ".decoded.json"));
			var n = sameTree(name, mine, ts);
			eq(name + " values compared > 100", n > 100, true);
			var doc = DocumentLoader.load(bytes);
			var inst = new OpenBoneInstance(doc);
			inst.play(doc.animations[0].name, true);
			for (i in 0...30)
				inst.advance(1 / 60.0);
			eq(name + " draws", inst.drawList().length > 0, true);
		}
	}

	/** Document fonts load from .obone and .obonb alike, and match by family (any case) and closest weight. */
	static function documentFonts() {
		for (file in ["fonts.obone", "fonts.obonb"]) {
			var doc = DocumentLoader.load(Platform.readBytes("test/data/" + file));
			eq(file + " fonts", doc.fonts.length, 3);
			var regular = doc.fonts[0], bold = doc.fonts[1], light = doc.fonts[2];
			eq(file + " id", regular.id, "f1");
			eq(file + " name", regular.name, "Brand Regular");
			eq(file + " family", regular.family, "Brand Sans");
			eq(file + " data src", regular.src, "data:font/ttf;base64,AAEAAAALAIAAAwAw");
			eq(file + " default weight", regular.weight, 400);
			eq(file + " default style", regular.style, "normal");
			eq(file + " path src", bold.src, "fonts/BrandSans-Bold.ttf");
			eq(file + " weight", bold.weight, 700);
			eq(file + " italic weight", light.weight, 300);
			eq(file + " style", light.style, "italic");
			eq(file + " match 400", doc.findFont("brand sans", 400) == regular, true);
			eq(file + " match 500", doc.findFont(" BRAND SANS ", 500) == regular, true);
			eq(file + " match 600", doc.findFont("Brand Sans", 600) == bold, true);
			eq(file + " match 900", doc.findFont("Brand Sans", 900) == bold, true);
			eq(file + " match 100", doc.findFont("Brand Sans", 100) == light, true);
			eq(file + " other family", doc.findFont("Georgia", 400) == null, true);
		}
		eq("no fonts", DocumentLoader.fromJson('{"format":"openbone","version":1}').fonts.length, 0);
	}

	/** setMute listener actions: parsing (null bus = master, missing muted = toggle) and AudioDirector overrides. */
	static function setMuteOverridesTheDocumentMix() {
		var doc = DocumentLoader.fromJson('{"format":"openbone","version":1,"skeleton":{"bones":[],"slots":[]},'
			+ '"audio":{"master":1,"muted":false,"assets":[],"sounds":[],"buses":[{"id":"bus_a","name":"A","volume":0.5,"muted":true}]},'
			+ '"stateMachines":[{"id":"sm","name":"sm","inputs":[],"layers":[],"listeners":[{"id":"l","name":"l","event":"click","actions":['
			+ '{"type":"setMute","bus":"bus_a","muted":false},{"type":"setMute","bus":null,"muted":"toggle"},{"type":"setMute"},{"type":"futureThing"}]}]}]}');
		var acts = doc.stateMachines[0].listeners[0].actions;
		eq("setMute actions parsed", acts.length, 4);
		eq("setMute bus", acts[0].bus, "bus_a");
		eq("setMute muted false", acts[0].muted, false);
		eq("setMute null bus = master", acts[1].bus, null);
		eq("setMute \"toggle\" = null", acts[1].muted, null);
		eq("setMute missing muted = null", acts[2].muted, null);
		eq("unknown action kept as its type", acts[3].type, "futureThing");
		var got:Array<String> = [];
		var dir = new AudioDirector(doc, c -> got.push(Json.stringify(c.toObject())));
		eq("document-muted bus", dir.isMuted("bus_a"), true);
		eq("master from document", dir.isMuted(null), false);
		eq("unknown bus", dir.isMuted("nope"), false);
		eq("toggle a document-muted bus", dir.setMute("bus_a", null), false);
		eq("override wins", dir.isMuted("bus_a"), false);
		eq("mute master", dir.setMute(null, true), true);
		eq("toggle master", dir.setMute(null, null), false);
		eq("mix commands", got.join(","),
			'{"type":"mix","bus":"bus_a","muted":false},{"type":"mix","bus":null,"muted":true},{"type":"mix","bus":null,"muted":false}');
	}

	static function sameTree(path:String, mine:Dynamic, ts:Dynamic):Int {
		if (Std.isOfType(mine, JObject)) {
			var m:JObject = mine;
			if (!Std.isOfType(ts, JObject)) {
				eq(path + " object", false, true);
				return 0;
			}
			var t:JObject = ts;
			var n = 0;
			for (k in m.keys) {
				if (!t.exists(k)) {
					eq(path + "." + k + " present in TypeScript decode", false, true);
					continue;
				}
				n += sameTree(path + "." + k, m.get(k), t.get(k));
			}
			return n;
		}
		if (Std.isOfType(mine, Array)) {
			var m:Array<Dynamic> = mine, t:Array<Dynamic> = ts;
			if (m.length != t.length) {
				eq(path + " length", m.length, t.length);
				return 0;
			}
			var n = 0;
			for (i in 0...m.length)
				n += sameTree(path + "[" + i + "]", m[i], t[i]);
			return n;
		}
		checks++;
		var same = mine == ts || (JsNum.isNum(mine) && JsNum.isNum(ts) && (mine : Float) == (ts : Float));
		if (!same)
			failures.push(path + ": got " + Std.string(mine) + " expected " + Std.string(ts));
		return 1;
	}
}
