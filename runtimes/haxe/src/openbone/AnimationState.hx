package openbone;

import openbone.AudioDirector;
import openbone.data.Model;

/** An animation playing on a track of an `AnimationState`. */
class TrackEntry {
	static var counter = 0;

	/** Owner id for the sounds this entry starts. */
	public final uid:String;

	public final animation:AnimationData;
	public final loop:Bool;

	/** Total elapsed time (seconds, unwrapped). */
	public var time = 0.0;

	public var prevTime = -1e-6;
	public var speed = 1.0;
	public var alpha = 1.0;
	public var mixingFrom:TrackEntry;
	public var mixTime = 0.0;
	public var mixDuration = 0.0;
	public var completedLoops = 0.0;

	public function new(animation:AnimationData, loop:Bool) {
		this.animation = animation;
		this.loop = loop;
		uid = "entry_" + (++counter);
	}

	public function duration():Float {
		return animation.getDuration();
	}

	public function localTime():Float {
		return Animations.localTime(animation, time, loop);
	}

	public function isComplete():Bool {
		return !loop && time >= duration();
	}
}

/** Receives animation state events; override what you need. */
class AnimationStateListener {
	public function new() {}

	public function event(e:FiredEvent, track:Int):Void {}

	public function start(entry:TrackEntry, track:Int):Void {}

	public function complete(entry:TrackEntry, track:Int):Void {}

	public function audio(c:AudioCommand):Void {}
}

private class Queued {
	public final track:Int;
	public final entry:TrackEntry;
	public final delay:Float;
	public final mix:Float;

	public function new(track:Int, entry:TrackEntry, delay:Float, mix:Float) {
		this.track = track;
		this.entry = entry;
		this.delay = delay;
		this.mix = mix;
	}
}

/** Plays animations on numbered tracks with cross-fading; higher tracks layer on top (runtime/animation-state.ts). */
class AnimationState {
	public final skeleton:Skeleton;
	public final tracks:Array<TrackEntry> = [];

	final queue:Array<Queued> = [];

	public var defaultMix = 0.2;
	public final audio:AudioDirector;

	final listeners:Array<AnimationStateListener> = [];

	public function new(skeleton:Skeleton) {
		this.skeleton = skeleton;
		audio = new AudioDirector(skeleton.doc, c -> {
			for (l in listeners.copy())
				l.audio(c);
		});
	}

	public function addListener(l:AnimationStateListener):Void {
		listeners.push(l);
	}

	public function removeListener(l:AnimationStateListener):Void {
		listeners.remove(l);
	}

	function endEntry(e:TrackEntry, fade:Float):Void {
		if (e != null)
			audio.stopOwner(e.uid, fade, false);
	}

	function resolve(anim:String):AnimationData {
		var a = skeleton.doc.findAnimation(anim);
		if (a == null)
			throw "Animation \"" + anim + "\" not found";
		return a;
	}

	function get(track:Int):TrackEntry {
		return track < tracks.length ? tracks[track] : null;
	}

	function put(track:Int, e:TrackEntry):Void {
		while (tracks.length <= track)
			tracks.push(null);
		tracks[track] = e;
	}

	/** Play an animation (by id or name) now on a track, mixing from what played there. */
	public function setAnimation(track:Int, anim:String, loop:Bool):TrackEntry {
		return setAnimationData(track, resolve(anim), loop, defaultMix);
	}

	public function setAnimationData(track:Int, anim:AnimationData, loop:Bool, mix:Float):TrackEntry {
		var entry = new TrackEntry(anim, loop);
		var cur = get(track);
		endEntry(cur, mix);
		if (cur != null && mix > 0) {
			entry.mixingFrom = cur;
			cur.mixingFrom = null;
			entry.mixDuration = mix;
		}
		put(track, entry);
		var i = queue.length;
		while (--i >= 0)
			if (queue[i].track == track)
				queue.splice(i, 1);
		for (l in listeners.copy())
			l.start(entry, track);
		return entry;
	}

	/** Queue an animation after the current one completes (non-looping) or after `delay` seconds. */
	public function addAnimation(track:Int, anim:String, loop:Bool, delay:Float):TrackEntry {
		return addAnimationData(track, resolve(anim), loop, delay, defaultMix);
	}

	public function addAnimationData(track:Int, anim:AnimationData, loop:Bool, delay:Float, mix:Float):TrackEntry {
		var entry = new TrackEntry(anim, loop);
		if (get(track) == null) {
			put(track, entry);
			for (l in listeners.copy())
				l.start(entry, track);
		} else
			queue.push(new Queued(track, entry, delay, mix));
		return entry;
	}

	public function clearTrack(track:Int):Void {
		endEntry(get(track), 0);
		if (track < tracks.length)
			tracks[track] = null;
	}

	/** Stop every track and every sound. */
	public function clearTracks():Void {
		tracks.resize(0);
		queue.resize(0);
		audio.stopAll(0);
	}

	public function update(dt:Float):Void {
		audio.update(dt);
		for (track in 0...tracks.length) {
			var e = tracks[track];
			if (e == null)
				continue;
			e.prevTime = e.time > 0 ? e.time : Math.min(e.prevTime, e.time);
			e.time += dt * e.speed;
			if (e.mixingFrom != null) {
				e.mixingFrom.prevTime = e.mixingFrom.time;
				e.mixingFrom.time += dt * e.mixingFrom.speed;
				e.mixTime += dt;
				if (e.mixTime >= e.mixDuration)
					e.mixingFrom = null;
			}
			if (dt > 0) {
				AudioDirector.playAudioKeys(audio, e.animation, e.prevTime, e.time, e.loop, e.uid);
				for (ev in Animations.eventsBetween(skeleton.doc, e.animation, e.prevTime, e.time, e.loop)) {
					if (ev.audio != null) {
						var o = new PlayOptions();
						o.volume = ev.volume;
						o.owner = e.uid;
						o.source = "event:" + ev.name;
						audio.play(ev.audio, o);
					}
					for (l in listeners.copy())
						l.event(ev, track);
				}
			}
			var d = e.duration();
			if (d > 0) {
				var loops = Math.ffloor(e.time / d);
				if (e.loop ? loops > e.completedLoops : e.prevTime < d && e.time >= d) {
					e.completedLoops = loops;
					for (l in listeners.copy())
						l.complete(e, track);
					if (!e.loop)
						endEntry(e, 0);
				}
			}
			var q:Queued = null;
			for (x in queue)
				if (x.track == track) {
					q = x;
					break;
				}
			if (q != null && (q.delay > 0 ? e.time >= q.delay : e.isComplete() || (e.loop && d > 0 && e.time >= d))) {
				queue.remove(q);
				endEntry(e, q.mix);
				q.entry.mixingFrom = e;
				q.entry.mixDuration = q.mix;
				tracks[track] = q.entry;
				for (l in listeners.copy())
					l.start(q.entry, track);
			}
		}
	}

	public function apply():Void {
		applyTo(skeleton);
	}

	public function applyTo(sk:Skeleton):Void {
		for (e in tracks) {
			if (e == null)
				continue;
			if (e.mixingFrom != null) {
				Animations.apply(sk, e.mixingFrom.animation, e.mixingFrom.localTime(), e.alpha);
				var md = MathUtil.orOne(e.mixDuration);
				Animations.apply(sk, e.animation, e.localTime(), e.alpha * Math.min(1, e.mixTime / md));
			} else
				Animations.apply(sk, e.animation, e.localTime(), e.alpha);
		}
	}
}
