package openbone;

import openbone.AudioDirector;
import openbone.Json;
import openbone.ParticleEmitter;
import openbone.ScriptHost;
import openbone.Skeleton;
import openbone.data.Model;

/** Receives state machine events; override what you need. */
class StateMachineListener {
	public function new() {}

	public function event(e:FiredEvent):Void {}

	public function stateChange(layer:String, from:String, to:String):Void {}

	public function inputChange(name:String, value:Dynamic):Void {}

	public function log(args:Array<Dynamic>):Void {}

	public function error(error:Dynamic):Void {}

	public function audio(c:AudioCommand):Void {}
}

private class StateInstance {
	static var counter = 0;

	public final uid:String;
	public final data:SmState;
	public var time = 0.0;
	public var prevTime = -1e-6;
	public final scripts:Array<ScriptHandle> = [];

	public function new(data:SmState) {
		this.data = data;
		uid = "state_" + (++counter);
	}
}

private class LayerInstance {
	public final data:SmLayer;
	public var current:StateInstance;
	public var from:StateInstance;
	public var mixTime = 0.0;
	public var mixDuration = 0.0;
	public var exited = false;

	public function new(data:SmLayer) {
		this.data = data;
	}
}

private class PointerEvent {
	public final type:String;
	public final x:Float;
	public final y:Float;

	public function new(type:String, x:Float, y:Float) {
		this.type = type;
		this.x = x;
		this.y = y;
	}
}

private class BlendPair {
	public var lo:AnimationData;
	public var hi:AnimationData;
	public var t = 0.0;

	public function new() {}
}

/**
 * Runs a Rive-style state machine over a skeleton: inputs, layered states with cross-fades, pointer listeners, events,
 * bindings and scripts (runtime/state-machine.ts, docs/runtime-spec.md §9).
 */
class StateMachineInstance implements ScriptApi {
	static inline final ON_COMPLETE_MIX = 0.1;

	public final skeleton:Skeleton;
	public final data:StateMachineData;
	public final doc:OpenBoneDocument;

	/** Input values by input id: Float, Bool or String (null = undefined). */
	public final inputs = new OrderedMap<Dynamic>();

	/** Sounds started by states, audio keys, event audio and listeners. */
	public final audio:AudioDirector;

	final fired:Map<String, Bool> = new Map();
	final layers:Array<LayerInstance> = [];
	var pending:Array<PointerEvent> = [];
	final hovered:Map<String, Bool> = new Map();
	final pressed:Map<String, Bool> = new Map();
	var pointerX = 0.0;
	var pointerY = 0.0;
	var pointerDown = false;
	final scripts:Array<ScriptHandle> = [];
	final boneOverrides = new OrderedMap<OrderedMap<Float>>();
	final slotOverrides = new OrderedMap<OrderedMap<Dynamic>>();
	final emitterOverrides = new OrderedMap<Bool>();
	var pendingEvents:Array<FiredEvent> = [];
	var elapsedTime = 0.0;
	var started = false;
	final scriptHost:ScriptHost;
	final handles:Map<String, ScriptHandle> = new Map();
	final listeners:Array<StateMachineListener> = [];

	public function new(skeleton:Skeleton, data:StateMachineData, scriptHost:ScriptHost) {
		this.skeleton = skeleton;
		this.data = data;
		this.doc = skeleton.doc;
		this.scriptHost = scriptHost;
		audio = new AudioDirector(doc, c -> {
			for (l in listeners.copy())
				l.audio(c);
		});
		for (i in data.inputs)
			inputs.set(i.id, i.type == "trigger" ? false : i.defaultValue);
		for (l in data.layers)
			layers.push(new LayerInstance(l));
		skeleton.textValues = getInput;
	}

	public function addListener(l:StateMachineListener):Void {
		listeners.push(l);
	}

	public function removeListener(l:StateMachineListener):Void {
		listeners.remove(l);
	}

	/** Seconds advanced so far. */
	public function elapsed():Float {
		return elapsedTime;
	}

	// ---------------- Inputs ----------------

	function input(ref:String):SmInput {
		for (i in data.inputs)
			if (i.id == ref || i.name == ref)
				return i;
		return null;
	}

	/** Input value by id or name (Float, Bool or String), or null. */
	public function getInput(name:String):Dynamic {
		var i = input(name);
		return i != null ? inputs.get(i.id) : null;
	}

	/** Set an input by id or name (a trigger fires). Strings, bools and numbers are converted like the TypeScript runtime. */
	public function setInput(name:String, value:Dynamic):Void {
		var i = input(name);
		if (i == null)
			throw "Input \"" + name + "\" not found";
		if (i.type == "trigger") {
			fire(name);
			return;
		}
		var v:Dynamic;
		if (i.type == "string")
			v = JsNum.str(value);
		else if (i.type == "bool")
			v = Std.isOfType(value, String) ? value == "true" : JsNum.truthy(value);
		else {
			var n = JsNum.toNumber(value);
			if (!Math.isFinite(n))
				return;
			v = n;
		}
		if (JsNum.strictEquals(inputs.get(i.id), v))
			return;
		inputs.set(i.id, v);
		if (i.type == "bool" && i.ownsMute)
			audio.setMute(i.mutes, v == true);
		for (l in listeners.copy())
			l.inputChange(i.name, v);
	}

	/**
	 * Mute, unmute or toggle (null) a bus id (null = the master). When a bool input owns that bus's mute, it goes
	 * through the input so both stay in step. Returns the new state.
	 */
	public function setBusMute(bus:String, muted:Null<Bool>):Bool {
		var next = muted != null ? muted : !audio.isMuted(bus);
		var owner:SmInput = null;
		for (i in data.inputs)
			if (i.type == "bool" && i.ownsMute && i.mutes == bus) {
				owner = i;
				break;
			}
		if (owner != null && JsNum.truthy(getInput(owner.id)) != next)
			setInput(owner.id, next);
		else
			audio.setMute(bus, next);
		return next;
	}

	public function setBool(name:String, v:Bool):Void {
		setInput(name, v);
	}

	public function setNumber(name:String, v:Float):Void {
		setInput(name, v);
	}

	public function setString(name:String, v:String):Void {
		setInput(name, v);
	}

	/** Show fixed text (or a template) in a slot's text attachment; null restores its own. */
	public function setText(slot:String, text:String):Void {
		skeleton.setText(slot, text);
	}

	public function fire(name:String):Void {
		var i = input(name);
		if (i == null)
			throw "Input \"" + name + "\" not found";
		fired.set(i.id, true);
		for (l in listeners.copy())
			l.inputChange(i.name, true);
	}

	/** Current state name per layer ("exit" for an exited layer, null for none), in layer order. */
	public function activeStates():OrderedMap<String> {
		var out = new OrderedMap<String>();
		for (l in layers)
			out.set(l.data.name, l.exited ? "exit" : l.current != null ? l.current.data.name : null);
		return out;
	}

	// ---------------- Pointer ----------------

	/** Queue a pointer event ("down", "up" or "move") in skeleton space (y up); processed on the next advance. */
	public function pointer(type:String, x:Float, y:Float):Void {
		pending.push(new PointerEvent(type, x, y));
	}

	function processPointer():Void {
		var evs = pending;
		pending = [];
		for (p in evs) {
			pointerX = p.x;
			pointerY = p.y;
			pointerDown = p.type == "down" || (p.type != "up" && pointerDown);
			for (s in scripts) {
				var arg = new JObject();
				arg.set("type", p.type);
				arg.set("x", p.x);
				arg.set("y", p.y);
				safeCall(s, "onPointer", [arg]);
			}
			for (li in data.listeners) {
				var hit = li.slot != null && li.slot.length > 0 ? hitSlot(li.slot, p.x, p.y) : true;
				var key = li.id;
				var fire = false;
				switch (li.event) {
					case "move":
						fire = hit && p.type == "move";
					case "down":
						fire = hit && p.type == "down";
					case "up":
						fire = hit && p.type == "up";
					case "click":
						if (p.type == "down" && hit)
							pressed.set(key, true);
						if (p.type == "up") {
							fire = hit && pressed.exists(key);
							pressed.remove(key);
						}
					case "enter" | "exit":
						var was = hovered.exists(key);
						if (hit && !was) {
							hovered.set(key, true);
							fire = li.event == "enter";
						} else if (!hit && was) {
							hovered.remove(key);
							fire = li.event == "exit";
						}
					default:
				}
				if (fire)
					runActions(li, li.actions);
			}
		}
	}

	function hitSlot(slotId:String, x:Float, y:Float):Bool {
		var slot = skeleton.slotById(slotId);
		return slot != null && skeleton.hitTest(slot, x, y);
	}

	function runActions(li:SmListener, actions:Array<SmAction>):Void {
		for (a in actions) {
			switch (a.type) {
				case "setInput":
					setInput(a.input, a.value);
				case "toggleInput":
					setInput(a.input, !JsNum.truthy(inputs.get(a.input)));
				case "fireTrigger":
					fire(a.input);
				case "reportEvent":
					var ev = doc.eventById(a.event);
					if (ev != null) {
						if (ev.audio != null && ev.audio.length > 0) {
							var o = new PlayOptions();
							o.volume = ev.volume;
							o.source = "event:" + ev.name;
							audio.play(ev.audio, o);
						}
						pendingEvents.push(new FiredEvent(ev.name, ev.id, elapsedTime, ev.intValue, ev.floatValue, ev.stringValue, null, null, ""));
					}
				case "playSound":
					var o = new PlayOptions();
					o.volume = a.volume;
					o.source = "listener:" + li.name;
					audio.play(a.sound, o);
				case "stopSound":
					audio.stopSound(a.sound, a.fade);
				case "runScript":
					var script = doc.scriptById(a.script);
					var handle = script != null ? scriptFor(script.id) : null;
					if (handle != null)
						safeCall(handle, a.fn, []);
				case "setEmitter":
					setEmitter(a.slot, a.emitting);
				case "emitParticles":
					skeleton.emitParticles(a.slot, a.count);
				case "setMute":
					setBusMute(a.bus, a.muted);
				default:
			}
		}
	}

	/** Switch a slot's particle emitter; switching it on restarts its cycle so bursts replay. */
	public function setEmitter(slotRef:String, emitting:Bool):Void {
		var slot = skeleton.findSlot(slotRef);
		if (slot == null)
			return;
		emitterOverrides.set(slot.data.id, emitting);
		if (emitting)
			skeleton.restartEmitter(slot.data.id);
	}

	// ---------------- Scripts ----------------

	/** The `ob` API (ScriptApi): method name and JSON-decoded arguments; returns a JSON value or Undefined. */
	public function call(method:String, args:Array<Dynamic>):Dynamic {
		var a0:Dynamic = args.length > 0 ? args[0] : null;
		var a1:Dynamic = args.length > 1 ? args[1] : null;
		switch (method) {
			case "time":
				return elapsedTime;
			case "input":
				var v:Dynamic = getInput(JsNum.str(a0));
				return v != null ? v : Undefined.INSTANCE;
			case "setInput":
				setInput(JsNum.str(a0), a1);
				return Undefined.INSTANCE;
			case "fire":
				fire(JsNum.str(a0));
				return Undefined.INSTANCE;
			case "emit":
				var name = JsNum.str(a0);
				var payload:JObject = Std.isOfType(a1, JObject) ? a1 : new JObject();
				var ev:EventData = null;
				for (e in doc.events)
					if (e.name == name || e.id == name) {
						ev = e;
						break;
					}
				if (ev != null && ev.audio != null && ev.audio.length > 0) {
					var o = new PlayOptions();
					o.volume = ev.volume;
					o.source = "event:" + ev.name;
					audio.play(ev.audio, o);
				}
				var pi:Dynamic = payload.get("int"), pf:Dynamic = payload.get("float"), ps:Dynamic = payload.get("string");
				pendingEvents.push(new FiredEvent(name, ev != null ? ev.id : name, elapsedTime, pi != null ? JsNum.toNumber(pi) : ev != null ? ev.intValue : 0,
					pf != null ? JsNum.toNumber(pf) : ev != null ? ev.floatValue : 0, ps != null ? JsNum.str(ps) : ev != null ? ev.stringValue : "", null, null,
					""));
				return Undefined.INSTANCE;
			case "bone":
				var b = skeleton.findBone(JsNum.str(a0));
				if (b == null)
					return null;
				var m = new JObject();
				m.set("x", b.x);
				m.set("y", b.y);
				m.set("rotation", b.rotation);
				m.set("scaleX", b.scaleX);
				m.set("scaleY", b.scaleY);
				m.set("worldX", b.world.x);
				m.set("worldY", b.world.y);
				m.set("worldRotation", b.worldRotation());
				return m;
			case "setBone":
				var b = skeleton.findBone(JsNum.str(a0));
				if (b != null && Std.isOfType(a1, JObject)) {
					var o = boneOverrides.get(b.data.id);
					if (o == null) {
						o = new OrderedMap<Float>();
						boneOverrides.set(b.data.id, o);
					}
					var src:JObject = a1;
					for (k in src.keys)
						o.set(k, JsNum.toNumber(src.get(k)));
				}
				return Undefined.INSTANCE;
			case "slot":
				var s = skeleton.findSlot(JsNum.str(a0));
				if (s != null && Std.isOfType(a1, JObject)) {
					var o = slotOverrides.get(s.data.id);
					if (o == null) {
						o = new OrderedMap<Dynamic>();
						slotOverrides.set(s.data.id, o);
					}
					var src:JObject = a1;
					for (k in src.keys)
						o.set(k, src.get(k));
				}
				return Undefined.INSTANCE;
			case "pointer":
				var m = new JObject();
				m.set("x", pointerX);
				m.set("y", pointerY);
				m.set("down", pointerDown);
				return m;
			case "log":
				for (l in listeners.copy())
					l.log(args);
				return Undefined.INSTANCE;
			default:
				return Undefined.INSTANCE;
		}
	}

	function scriptFor(id:String):ScriptHandle {
		if (scriptHost == null)
			return null;
		var h = handles.get(id);
		if (h == null) {
			var s = doc.scriptById(id);
			if (s == null)
				return null;
			try {
				h = scriptHost.load(s, this);
			} catch (e:Dynamic) {
				reportError(e);
				return null;
			}
			handles.set(id, h);
		}
		return h;
	}

	function reportError(e:Dynamic):Void {
		for (l in listeners.copy())
			l.error(e);
	}

	function safeCall(h:ScriptHandle, fn:String, args:Array<Dynamic>):Void {
		try {
			if (h.has(fn))
				h.call(fn, args);
		} catch (e:Dynamic) {
			reportError(e);
		}
	}

	function start():Void {
		started = true;
		// Inputs that own a bus's mute: a true default mutes it; a bus already muted shows as true.
		for (i in data.inputs) {
			if (i.type != "bool" || !i.ownsMute)
				continue;
			if (JsNum.truthy(inputs.get(i.id)))
				audio.setMute(i.mutes, true);
			else if (audio.isMuted(i.mutes))
				inputs.set(i.id, true);
		}
		for (id in data.scripts) {
			var h = scriptFor(id);
			if (h != null) {
				scripts.push(h);
				safeCall(h, "onStart", []);
			}
		}
		for (l in layers) {
			var entry:SmState = null;
			for (s in l.data.states)
				if (s.id == l.data.entry) {
					entry = s;
					break;
				}
			if (entry != null)
				enter(l, entry, 0);
		}
	}

	function stateSounds(s:SmState, on:String, owner:String):Void {
		for (x in s.sounds) {
			if (x.on != on)
				continue;
			if (x.action == "stop")
				audio.stopSound(x.sound, null);
			else {
				var o = new PlayOptions();
				o.volume = x.volume;
				o.owner = owner;
				o.tag = owner != null ? "hook:" + x.sound : null;
				o.source = "state:" + s.name;
				audio.play(x.sound, o);
			}
		}
	}

	function enter(l:LayerInstance, state:SmState, mix:Float):Void {
		var prev = l.current;
		if (prev != null) {
			for (h in prev.scripts)
				disposeQuietly(h);
			audio.stopOwner(prev.uid, mix, false);
			stateSounds(prev.data, "exit", null);
		}
		if (state.type == "exit") {
			l.exited = true;
			l.from = prev;
			l.current = null;
			l.mixTime = 0;
			l.mixDuration = mix;
		} else {
			var inst = new StateInstance(state);
			l.from = mix > 0 ? prev : null;
			l.current = inst;
			l.mixTime = 0;
			l.mixDuration = mix;
			l.exited = false;
			stateSounds(state, "enter", inst.uid);
			for (e in state.emitters)
				setEmitter(e.slot, e.emitting);
			for (x in state.inputs)
				if (input(x.input) != null)
					setInput(x.input, x.value);
			for (id in state.scripts) {
				var s = doc.scriptById(id);
				if (s == null || scriptHost == null)
					continue;
				try {
					var h = scriptHost.load(s, this);
					inst.scripts.push(h);
					safeCall(h, "onStart", []);
				} catch (e:Dynamic) {
					reportError(e);
				}
			}
		}
		var from = prev != null ? prev.data.name : null;
		for (li in listeners.copy())
			li.stateChange(l.data.name, from, state.name);
	}

	static function disposeQuietly(h:ScriptHandle):Void {
		try {
			h.dispose();
		} catch (e:Dynamic) {}
	}

	// ---------------- Transitions ----------------

	function conditionPasses(c:SmCondition):Bool {
		var inp:SmInput = null;
		for (i in data.inputs)
			if (i.id == c.input) {
				inp = i;
				break;
			}
		if (inp == null)
			return false;
		if (inp.type == "trigger")
			return fired.exists(inp.id);
		var v:Dynamic = inputs.get(inp.id);
		var want:Dynamic = c.value;
		switch (c.op) {
			case "==":
				if (inp.type == "string")
					return JsNum.str(v) == JsNum.str(want);
				return JsNum.strictEquals(v, want) || (JsNum.isNum(v) && JsNum.isNum(want) && Math.abs((v : Float) - (want : Float)) < 1e-9);
			case "!=":
				if (inp.type == "string")
					return JsNum.str(v) != JsNum.str(want);
				return !JsNum.strictEquals(v, want);
			case ">":
				return JsNum.toNumber(v) > JsNum.toNumber(want);
			case "<":
				return JsNum.toNumber(v) < JsNum.toNumber(want);
			case ">=":
				return JsNum.toNumber(v) >= JsNum.toNumber(want);
			case "<=":
				return JsNum.toNumber(v) <= JsNum.toNumber(want);
			default:
				return false;
		}
	}

	function progress(s:StateInstance):Float {
		var pair = blendPair(s.data);
		var anim = pair != null ? (pair.t >= 0.5 ? pair.hi : pair.lo) : doc.animationById(s.data.animation);
		var d = anim != null ? anim.getDuration() : 0;
		return d > 0 ? s.time / d : 1;
	}

	function canTake(t:SmTransition, s:StateInstance):Bool {
		var any = t.from == StateMachineData.ANY_STATE;
		var toSelf = s != null && t.to == s.data.id;
		if (!any && toSelf && t.conditions.length == 0)
			return false;
		if (any && toSelf)
			return false;
		var exitTime:Null<Float> = t.exitTime != null ? t.exitTime : t.conditions.length == 0 ? 1.0 : null;
		if (exitTime != null && s != null && progress(s) < exitTime)
			return false;
		for (c in t.conditions)
			if (!conditionPasses(c))
				return false;
		return true;
	}

	function evaluate(l:LayerInstance):SmTransition {
		if (l.exited)
			return null;
		var cur = l.current;
		var candidates:Array<SmTransition> = [];
		for (t in l.data.transitions)
			if (t.from == StateMachineData.ANY_STATE || (cur != null && t.from == cur.data.id))
				candidates.push(t);
		haxe.ds.ArraySort.sort(candidates, (a, b) -> {
			var x = a.from == StateMachineData.ANY_STATE ? 1 : 0, y = b.from == StateMachineData.ANY_STATE ? 1 : 0;
			return x - y;
		});
		for (t in candidates) {
			if (!canTake(t, cur))
				continue;
			var to = stateById(l, t.to);
			if (to == null)
				continue;
			enter(l, to, t.duration);
			return t;
		}
		var next = cur != null ? cur.data.onComplete : null;
		if (cur != null && next != null && next.length > 0 && progress(cur) >= 1) {
			var to = stateById(l, next);
			if (to != null)
				enter(l, to, ON_COMPLETE_MIX);
		}
		return null;
	}

	static function stateById(l:LayerInstance, id:String):SmState {
		for (s in l.data.states)
			if (s.id == id)
				return s;
		return null;
	}

	function settle(l:LayerInstance):Void {
		for (hop in 0...4) {
			var t = evaluate(l);
			if (t == null)
				return;
			for (c in t.conditions)
				fired.remove(c.input);
		}
	}

	// ---------------- Apply ----------------

	function blendPair(d:SmState):BlendPair {
		if (d.type != "blend1d" || d.blend.length == 0)
			return null;
		var raw:Dynamic = inputs.get(d.blendInput != null ? d.blendInput : "");
		var v = JsNum.toNumber(raw != null ? raw : 0.0);
		var entries = d.blend.copy();
		haxe.ds.ArraySort.sort(entries, (a, b) -> {
			var x = a.value - b.value;
			return x < 0 ? -1 : x > 0 ? 1 : 0;
		});
		var lo = entries[0], hi = entries[0];
		var t = 0.0;
		if (v >= entries[entries.length - 1].value)
			lo = hi = entries[entries.length - 1];
		else
			for (i in 0...entries.length - 1)
				if (v >= entries[i].value && v <= entries[i + 1].value) {
					lo = entries[i];
					hi = entries[i + 1];
					var span = hi.value - lo.value;
					t = (v - lo.value) / MathUtil.orOne(span);
					break;
				}
		var p = new BlendPair();
		p.lo = doc.animationById(lo.animation);
		p.hi = doc.animationById(hi.animation);
		p.t = t;
		return p;
	}

	/** The animations a state is playing now (a blend state's current pair). */
	function stateAnimations(s:StateInstance):Array<AnimationData> {
		var d = s.data;
		var out:Array<AnimationData> = [];
		if (d.type == "animation") {
			var anim = doc.animationById(d.animation);
			if (anim != null)
				out.push(anim);
		} else if (d.type == "blend1d") {
			var pair = blendPair(d);
			if (pair != null) {
				if (pair.lo != null)
					out.push(pair.lo);
				if (pair.hi != null)
					out.push(pair.hi);
			}
		}
		return out;
	}

	/**
		Pose a state at weight `alpha`. With `into` (the state being faded to) and its outgoing weight `outAlpha`, the
		blending values none of `into` key are applied at `outAlpha` instead (spec §5.1a).
	**/
	function applyState(s:StateInstance, alpha:Float, ?into:Array<AnimationData>, outAlpha:Float = 0):Void {
		var d = s.data;
		if (d.type == "animation") {
			var anim = doc.animationById(d.animation);
			if (anim != null)
				Animations.apply(skeleton, anim, Animations.localTime(anim, s.time, d.loop), alpha, into == null ? null : new MixOut(into, outAlpha));
		} else if (d.type == "blend1d") {
			var pair = blendPair(d);
			if (pair == null)
				return;
			if (pair.lo != null)
				Animations.apply(skeleton, pair.lo, Animations.localTime(pair.lo, s.time, d.loop), alpha, into == null ? null : new MixOut(into, outAlpha));
			if (pair.hi != null && pair.hi != pair.lo && pair.t > 0)
				Animations.apply(skeleton, pair.hi, Animations.localTime(pair.hi, s.time, d.loop), alpha * pair.t,
					into == null ? null : new MixOut(into, outAlpha * pair.t));
		}
	}

	function collectEvents(s:StateInstance):Void {
		var d = s.data;
		var anim:AnimationData = null;
		if (d.type == "animation")
			anim = doc.animationById(d.animation);
		else if (d.type == "blend1d") {
			var pair = blendPair(d);
			anim = pair != null ? (pair.t >= 0.5 ? pair.hi : pair.lo) : null;
		}
		if (anim == null)
			return;
		AudioDirector.playAudioKeys(audio, anim, s.prevTime, s.time, d.loop, s.uid);
		for (ev in Animations.eventsBetween(doc, anim, s.prevTime, s.time, d.loop)) {
			if (ev.audio != null) {
				var o = new PlayOptions();
				o.volume = ev.volume;
				o.owner = s.uid;
				o.source = "event:" + ev.name;
				audio.play(ev.audio, o);
			}
			pendingEvents.push(ev);
		}
	}

	/** Step the machine by dt seconds and pose the skeleton (spec §9.1). */
	public function advance(dt:Float):Void {
		if (!started)
			start();
		elapsedTime += dt;
		audio.update(dt);
		processPointer();
		for (s in scripts.copy())
			safeCall(s, "onUpdate", [dt]);
		for (l in layers)
			if (l.current != null)
				for (h in l.current.scripts.copy())
					safeCall(h, "onUpdate", [dt]);

		for (l in layers)
			settle(l);
		fired.clear();

		for (l in layers) {
			for (s in [l.current, l.from]) {
				if (s == null)
					continue;
				s.prevTime = s.time > 0 ? s.time : Math.min(s.prevTime, s.time);
				s.time += dt * s.data.speed;
			}
			if (l.current != null && dt > 0)
				collectEvents(l.current);
			if (l.from != null) {
				l.mixTime += dt;
				if (l.mixTime >= l.mixDuration)
					l.from = null;
			}
		}

		var sk = skeleton;
		sk.setToSetupPose();
		for (l in layers) {
			var mixA = l.mixDuration > 0 ? Math.min(1, l.mixTime / l.mixDuration) : 1;
			if (l.from != null) {
				// Fading to a state: what it doesn't key fades from the old state's value to the pose underneath.
				if (l.current != null)
					applyState(l.from, 1, stateAnimations(l.current), 1 - mixA);
				else
					applyState(l.from, l.exited ? 1 - mixA : 1);
			}
			if (l.current != null)
				applyState(l.current, l.from != null ? mixA : 1);
		}
		for (id in boneOverrides.keys) {
			var b = sk.boneById(id);
			if (b == null)
				continue;
			var o = boneOverrides.get(id);
			for (p in o.keys)
				b.set(p, o.get(p));
		}
		for (id in slotOverrides.keys) {
			var s = sk.slotById(id);
			if (s == null)
				continue;
			var o = slotOverrides.get(id);
			var color:Dynamic = o.get("color");
			if (JsNum.truthy(color))
				s.color = MathUtil.parseHex(JsNum.str(color));
			if (o.exists("attachment")) {
				var a:Dynamic = o.get("attachment");
				s.attachmentName = a == null ? null : JsNum.str(a);
			}
		}
		for (id in inputs.keys) {
			var v:Dynamic = inputs.get(id);
			if (JsNum.isNum(v))
				sk.inputValues.set(id, v);
		}
		for (id in emitterOverrides.keys) {
			var cur = sk.particleValues.get(id);
			var v = cur != null ? cur.copy() : new ParticleValues();
			v.emitting = emitterOverrides.get(id);
			sk.particleValues.set(id, v);
		}
		applyBindings();
		sk.update(dt);
		sk.updateWorldTransform();

		var evs = pendingEvents;
		pendingEvents = [];
		for (e in evs) {
			for (l in listeners.copy())
				l.event(e);
			var em = e.toObject();
			for (h in scripts.copy())
				safeCall(h, "onEvent", [em]);
			for (l in layers)
				if (l.current != null)
					for (h in l.current.scripts.copy())
						safeCall(h, "onEvent", [em]);
		}
	}

	/** Drive bound properties from their inputs (after animations and script overrides). */
	public function applyBindings():Void {
		var sk = skeleton;
		for (b in data.bindings) {
			var raw:Dynamic = inputs.get(b.input);
			if (raw == null)
				continue;
			var n = JsNum.toNumber(raw);
			if (!Math.isFinite(n))
				continue;
			var t = Template.bindingT(n, b.inMin, b.inMax);
			if (b.target == "bone") {
				var bone = sk.boneById(b.object);
				if (bone != null)
					bone.set(b.property, lerpNum(b, t));
			} else if (b.target == "slot") {
				var slot = sk.slotById(b.object);
				if (slot == null)
					continue;
				if (b.property == "alpha")
					slot.color = [slot.color[0], slot.color[1], slot.color[2], lerpNum(b, t)];
				else if (b.property == "color") {
					var lo = MathUtil.parseHex(JsNum.str(b.outMin)), hi = MathUtil.parseHex(JsNum.str(b.outMax));
					slot.color = [for (k in 0...4) lo[k] + (hi[k] - lo[k]) * t];
				}
			} else {
				var v = sk.constraintValues.get(b.object);
				if (v != null)
					v.put(b.property, lerpNum(b, t));
			}
		}
	}

	static function lerpNum(b:SmBinding, t:Float):Float {
		var lo = JsNum.toNumber(b.outMin), hi = JsNum.toNumber(b.outMax);
		return lo + (hi - lo) * t;
	}

	/** Clear persistent script overrides. */
	public function clearOverrides():Void {
		boneOverrides.clear();
		slotOverrides.clear();
	}

	/** Stop every sound and release scripts. */
	public function dispose():Void {
		audio.stopAll(0);
		for (h in handles)
			disposeQuietly(h);
		for (l in layers)
			if (l.current != null)
				for (h in l.current.scripts)
					disposeQuietly(h);
		handles.clear();
	}
}
