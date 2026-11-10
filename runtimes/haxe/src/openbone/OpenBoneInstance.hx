package openbone;

import haxe.io.Bytes;
import openbone.AnimationState;
import openbone.AudioDirector;
import openbone.ScriptHost;
import openbone.StateMachineInstance;
import openbone.data.DocumentLoader;
import openbone.data.Model;

/** Receives events, state changes and audio commands from whichever driver is active; override what you need. */
class InstanceListener {
	public function new() {}

	public function event(e:FiredEvent):Void {}

	public function stateChange(layer:String, from:String, to:String):Void {}

	public function audio(c:AudioCommand):Void {}
}

private class StateForward extends AnimationStateListener {
	final owner:OpenBoneInstance;

	public function new(owner:OpenBoneInstance) {
		super();
		this.owner = owner;
	}

	override public function event(e:FiredEvent, track:Int):Void {
		for (l in owner.listenerList())
			l.event(e);
	}

	override public function audio(c:AudioCommand):Void {
		for (l in owner.listenerList())
			l.audio(c);
	}
}

private class MachineForward extends StateMachineListener {
	final owner:OpenBoneInstance;

	public function new(owner:OpenBoneInstance) {
		super();
		this.owner = owner;
	}

	override public function event(e:FiredEvent):Void {
		for (l in owner.listenerList())
			l.event(e);
	}

	override public function stateChange(layer:String, from:String, to:String):Void {
		for (l in owner.listenerList())
			l.stateChange(layer, from, to);
	}

	override public function audio(c:AudioCommand):Void {
		for (l in owner.listenerList())
			l.audio(c);
	}
}

/**
 * High-level handle: one skeleton driven either by an `AnimationState` (play/queue animations) or by a state machine
 * (inputs, listeners, scripts). The usual entry point for players and games (runtime/instance.ts).
 *
 * ```haxe
 * var inst = new OpenBoneInstance(DocumentLoader.load(bytes));
 * inst.play("walk", true);
 * inst.advance(1 / 60);
 * for (it in inst.drawList()) renderer.draw(it);
 * ```
 */
class OpenBoneInstance {
	public final doc:OpenBoneDocument;
	public final skeleton:Skeleton;
	public final animationState:AnimationState;
	public var stateMachine:StateMachineInstance;

	final scriptHost:ScriptHost;
	final listeners:Array<InstanceListener> = [];

	/** `scriptHost`: engine for state machine scripts, or null to ignore scripts. */
	public function new(doc:OpenBoneDocument, ?scriptHost:ScriptHost) {
		this.doc = doc;
		this.scriptHost = scriptHost;
		skeleton = new Skeleton(doc);
		animationState = new AnimationState(skeleton);
		animationState.addListener(new StateForward(this));
	}

	/** Load a .obone or .obonb file's bytes. */
	public static function fromBytes(bytes:Bytes, ?scriptHost:ScriptHost):OpenBoneInstance {
		return new OpenBoneInstance(DocumentLoader.load(bytes), scriptHost);
	}

	public function addListener(l:InstanceListener):Void {
		listeners.push(l);
	}

	public function removeListener(l:InstanceListener):Void {
		listeners.remove(l);
	}

	@:allow(openbone)
	function listenerList():Array<InstanceListener> {
		return listeners.copy();
	}

	/** Play an animation on a track (stops the state machine, if any). */
	public function play(animation:String, loop:Bool, track = 0):TrackEntry {
		if (stateMachine != null)
			stateMachine.dispose();
		stateMachine = null;
		return animationState.setAnimation(track, animation, loop);
	}

	/** Drive the skeleton with a state machine (by name or id; null = the first). */
	public function useStateMachine(?name:String):StateMachineInstance {
		var data = name != null ? doc.findStateMachine(name) : doc.stateMachines.length == 0 ? null : doc.stateMachines[0];
		if (data == null)
			throw name != null ? "State machine \"" + name + "\" not found" : "Document has no state machine";
		if (stateMachine != null)
			stateMachine.dispose();
		animationState.clearTracks();
		stateMachine = new StateMachineInstance(skeleton, data, scriptHost);
		stateMachine.addListener(new MachineForward(this));
		return stateMachine;
	}

	/** Step time by dt seconds and pose the skeleton. */
	public function advance(dt:Float):Void {
		if (stateMachine != null) {
			stateMachine.advance(dt);
			return;
		}
		animationState.update(dt);
		skeleton.setToSetupPose();
		animationState.apply();
		skeleton.update(dt);
		skeleton.updateWorldTransform();
	}

	/** Pointer event ("down", "up", "move") in skeleton space (y up). */
	public function pointer(type:String, x:Float, y:Float):Void {
		if (stateMachine != null)
			stateMachine.pointer(type, x, y);
	}

	/** Artboard pixels (y down, origin top-left) to skeleton space. */
	public function artboardToSkeleton(px:Float, py:Float):Array<Float> {
		return [px - doc.originX, doc.originY - py];
	}

	/** Stop every sound and release the state machine's scripts. */
	public function dispose():Void {
		if (stateMachine != null)
			stateMachine.dispose();
		animationState.clearTracks();
	}

	public function drawList():Array<DrawItem> {
		return skeleton.drawList();
	}
}
