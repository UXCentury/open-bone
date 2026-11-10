package openbone;

import openbone.Json;
import openbone.data.Model;

/** An event reported by an animation key, a listener or a script. */
class FiredEvent {
	public final name:String;
	public final id:String;

	/** Key's local time for animation events; state machine elapsed time for listener and script events. */
	public final time:Float;

	public final intValue:Float;
	public final floatValue:Float;
	public final stringValue:String;

	/** Sound the event plays, or null; and its volume multiplier, or null. */
	public final audio:String;

	public final volume:Null<Float>;

	/** Animation name ("" for listener and script events). */
	public final animation:String;

	public function new(name:String, id:String, time:Float, intValue:Float, floatValue:Float, stringValue:String, audio:String, volume:Null<Float>,
			animation:String) {
		this.name = name;
		this.id = id;
		this.time = time;
		this.intValue = intValue;
		this.floatValue = floatValue;
		this.stringValue = stringValue;
		this.audio = audio;
		this.volume = volume;
		this.animation = animation;
	}

	/** As scripts see it (`onEvent(e)`). */
	public function toObject():JObject {
		var m = new JObject();
		m.set("name", name);
		m.set("id", id);
		m.set("time", time);
		m.set("int", intValue);
		m.set("float", floatValue);
		m.set("string", stringValue);
		if (audio != null)
			m.set("audio", audio);
		if (volume != null)
			m.set("volume", volume);
		m.set("animation", animation);
		return m;
	}

	public function toString():String {
		return "FiredEvent" + Json.stringify(toObject());
	}
}

/**
 * A sound command for an audio backend: `play`, `stop` or `fade`. The runtime never plays audio; it emits these
 * (apply the document's bus and master volumes yourself).
 */
class AudioCommand {
	/** "play", "stop" or "fade". */
	public final type:String;

	/** Playing instance id; stop/fade refer to the id of an earlier play. */
	public final id:String;

	// play
	public var sound:String;
	public var asset:String;
	public var bus:String;
	public var source:String;
	public var volume = 0.0;
	public var rate = 0.0;
	public var fadeIn = 0.0;
	public var loop = false;
	// stop
	public var fade = 0.0;
	// fade (volume above is the target)
	public var duration = 0.0;

	public function new(type:String, id:String) {
		this.type = type;
		this.id = id;
	}

	/** Same fields as the TypeScript AudioCommand object. */
	public function toObject():JObject {
		var m = new JObject();
		m.set("type", type);
		m.set("id", id);
		switch (type) {
			case "play":
				m.set("sound", sound);
				m.set("asset", asset);
				m.set("bus", bus);
				m.set("volume", volume);
				m.set("rate", rate);
				m.set("loop", loop);
				m.set("fadeIn", fadeIn);
				m.set("source", source);
			case "stop":
				m.set("fade", fade);
			default:
				m.set("volume", volume);
				m.set("duration", duration);
		}
		return m;
	}

	public function toString():String {
		return "AudioCommand" + Json.stringify(toObject());
	}
}

class PlayingSound {
	public final id:String;
	public final sound:SoundData;
	public final owner:String;
	public final tag:String;
	public final loop:Bool;
	public var volume:Float;
	public final startedAt:Float;
	public final endsAt:Float;

	public function new(id:String, sound:SoundData, owner:String, tag:String, loop:Bool, volume:Float, startedAt:Float, endsAt:Float) {
		this.id = id;
		this.sound = sound;
		this.owner = owner;
		this.tag = tag;
		this.loop = loop;
		this.volume = volume;
		this.startedAt = startedAt;
		this.endsAt = endsAt;
	}
}

/** Options for `AudioDirector.play`; null fields use the sound's settings. */
class PlayOptions {
	public var volume:Null<Float>;
	public var rate:Null<Float>;
	public var loop:Null<Bool>;
	public var owner:String;
	public var tag:String;
	public var source:String;

	public function new() {}
}

/** Tracks what is playing and turns play/stop requests into `AudioCommand`s (runtime/audio.ts). */
class AudioDirector {
	static var counter = 0;
	static inline final UNKNOWN_LENGTH = 10;

	public final playing = new OrderedMap<PlayingSound>();
	public var time = 0.0;

	final doc:OpenBoneDocument;
	final out:AudioCommand->Void;

	public function new(doc:OpenBoneDocument, out:AudioCommand->Void) {
		this.doc = doc;
		this.out = out;
	}

	public function update(dt:Float):Void {
		time += dt;
		for (k in playing.keys.copy())
			if (playing.get(k).endsAt <= time)
				playing.remove(k);
	}

	static function base36(n:Int):String {
		var digits = "0123456789abcdefghijklmnopqrstuvwxyz";
		if (n == 0)
			return "0";
		var s = "";
		while (n > 0) {
			s = digits.charAt(n % 36) + s;
			n = Std.int(n / 36);
		}
		return s;
	}

	/** Start a sound (id or name; an audio asset plays with defaults). Returns the instance id, or null. */
	public function play(ref:String, o:PlayOptions):String {
		var sound = doc.resolveSound(ref);
		if (sound == null)
			return null;
		if (o == null)
			o = new PlayOptions();
		var loop:Bool = o.loop != null ? o.loop : sound.loop;
		var owner = o.owner, tag = o.tag;
		if (loop && tag != null)
			for (k in playing.keys) {
				var p = playing.get(k);
				if (p.loop && p.owner == owner && p.tag == tag)
					return p.id;
			}
		var rate:Float = o.rate != null ? o.rate : sound.rate;
		var volume = sound.volume * (o.volume != null ? (o.volume : Float) : 1.0);
		var len = 0.0;
		if (doc.audio != null)
			for (a in doc.audio.assets)
				if (a.id == sound.asset) {
					len = a.duration;
					break;
				}
		var id = "play_" + base36(++counter);
		playing.set(id, new PlayingSound(id, sound, owner, tag, loop, volume, time, loop ? Math.POSITIVE_INFINITY : time + (len > 0 ? len / rate : UNKNOWN_LENGTH)));
		var c = new AudioCommand("play", id);
		c.sound = sound.id;
		c.asset = sound.asset;
		c.bus = sound.bus;
		c.volume = volume;
		c.rate = rate;
		c.loop = loop;
		c.fadeIn = sound.fadeIn;
		c.source = o.source != null ? o.source : "";
		out(c);
		return id;
	}

	/** Stop one instance (fade null = its sound's fadeOut). */
	public function stop(id:String, fade:Null<Float>):Void {
		var p = playing.get(id);
		if (p == null)
			return;
		playing.remove(id);
		var c = new AudioCommand("stop", id);
		c.fade = fade != null ? (fade : Float) : p.sound.fadeOut;
		out(c);
	}

	/** Stop every playing instance of a sound. */
	public function stopSound(ref:String, fade:Null<Float>):Void {
		var s = doc.resolveSound(ref);
		if (s == null)
			return;
		for (k in playing.keys.copy()) {
			var p = playing.get(k);
			if (p != null && p.sound.id == s.id)
				stop(p.id, fade);
		}
	}

	/** Stop an owner's looping sounds (or all of them), fading at least the sound's fadeOut. */
	public function stopOwner(owner:String, fade:Float, all:Bool):Void {
		for (k in playing.keys.copy()) {
			var p = playing.get(k);
			if (p != null && p.owner == owner && (all || p.loop))
				stop(p.id, Math.max(fade, p.sound.fadeOut));
		}
	}

	/** Ramp an instance to a new volume. */
	public function fade(id:String, volume:Float, duration:Float):Void {
		var p = playing.get(id);
		if (p == null)
			return;
		p.volume = volume;
		var c = new AudioCommand("fade", id);
		c.volume = volume;
		c.duration = duration;
		out(c);
	}

	public function stopAll(fade:Float):Void {
		for (id in playing.keys.copy())
			stop(id, fade);
	}

	/** Audio keys crossed from total time prev (exclusive) to next (inclusive): their key indices. */
	public static function audioKeysBetween(anim:AnimationData, prev:Float, next:Float, loop:Bool):Array<Int> {
		var out:Array<Int> = [];
		var keys = anim.audio;
		if (keys.length == 0 || next <= prev)
			return out;
		var d = anim.getDuration();
		for (index in 0...keys.length) {
			var key = keys[index];
			if (!loop || d <= 0) {
				if (key.time > prev && key.time <= next)
					out.push(index);
				continue;
			}
			var c = Math.ffloor(prev / d);
			var lastC = Math.ffloor(next / d);
			while (c <= lastC) {
				var at = c * d + key.time;
				if (at > prev && at <= next)
					out.push(index);
				c++;
			}
		}
		return out;
	}

	/** Start the audio keys an animation crossed, owned by `owner`. */
	public static function playAudioKeys(dir:AudioDirector, anim:AnimationData, prev:Float, next:Float, loop:Bool, owner:String):Void {
		for (k in audioKeysBetween(anim, prev, next, loop)) {
			var key = anim.audio[k];
			var o = new PlayOptions();
			o.volume = key.volume;
			o.rate = key.rate;
			o.loop = key.loop;
			o.owner = owner;
			o.tag = anim.id + "#" + k;
			o.source = "key:" + anim.name;
			dir.play(key.sound, o);
		}
	}
}
