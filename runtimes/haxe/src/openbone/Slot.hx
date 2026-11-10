package openbone;

import openbone.data.Model;

/** A slot: what a bone shows (attachment), its tint and per-attachment deform / sequence state. */
class Slot {
	public final data:SlotData;
	public final bone:Bone;

	/** RGBA tint (0..1, not premultiplied). */
	public var color:Array<Float> = [1, 1, 1, 1];

	/** Two-colour tint dark colour (alpha unused), or null. */
	public var dark:Array<Float>;

	public var attachmentName:String;

	/** Mesh/path deform offsets by attachment name. */
	public final deform:Map<String, Array<Float>> = new Map();

	/** Keyed sequence frame counters by attachment name. */
	public final sequenceFrames:Map<String, Float> = new Map();

	public function new(data:SlotData, bone:Bone) {
		this.data = data;
		this.bone = bone;
		setToSetupPose();
	}

	public inline function name():String {
		return data.name;
	}

	public function setToSetupPose():Void {
		color = MathUtil.parseHex(data.color);
		dark = data.dark != null ? MathUtil.parseHex(data.dark) : null;
		attachmentName = data.attachment;
		deform.clear();
		sequenceFrames.clear();
	}

	public function toString():String {
		return data.name;
	}
}
