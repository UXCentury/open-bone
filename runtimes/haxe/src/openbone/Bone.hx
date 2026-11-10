package openbone;

import openbone.MathUtil;
import openbone.data.Model;

/** A bone of a `Skeleton`: local pose (written by animations), applied values and world matrix. */
class Bone {
	public final data:BoneData;
	public var parent:Bone;
	public final children:Array<Bone> = [];

	/** Local pose written by animations, sliders, bindings and scripts. */
	public var x = 0.0;

	public var y = 0.0;
	public var rotation = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;
	public var shearX = 0.0;
	public var shearY = 0.0;

	/** Inherit mode used this frame (setup value, or an inherit key). */
	public var inherit = Inherit.Normal;

	/** False while the bone is skin-only and the current skin does not list it. */
	public var active = true;

	/** Local values used for the world transform this frame (constraints may change them). */
	public final applied = new LocalTransform();

	public final world = new Affine();

	public function new(data:BoneData) {
		this.data = data;
		setToSetupPose();
		resetApplied();
	}

	public inline function name():String {
		return data.name;
	}

	public function setToSetupPose():Void {
		var d = data;
		x = d.x;
		y = d.y;
		rotation = d.rotation;
		scaleX = d.scaleX;
		scaleY = d.scaleY;
		shearX = d.shearX;
		shearY = d.shearY;
		inherit = d.inherit;
	}

	public function resetApplied():Void {
		var a = applied;
		a.x = x;
		a.y = y;
		a.rotation = rotation;
		a.scaleX = scaleX;
		a.scaleY = scaleY;
		a.shearX = shearX;
		a.shearY = shearY;
	}

	public function updateWorld(root:Affine):Void {
		world.set(MathUtil.boneWorldOf(parent != null ? parent.world : root, applied, parent != null ? inherit : Normal));
	}

	/** After a constraint wrote `world` directly: store matching local values in `applied`. */
	public function syncApplied(root:Affine):Void {
		MathUtil.localFromWorld(parent != null ? parent.world : root, world, parent != null ? inherit : Normal, applied);
	}

	public function updateSubtree(root:Affine, includeSelf:Bool):Void {
		if (!active)
			return;
		if (includeSelf)
			updateWorld(root);
		for (c in children)
			c.updateSubtree(root, true);
	}

	public inline function worldX():Float {
		return world.x;
	}

	public inline function worldY():Float {
		return world.y;
	}

	public function worldRotation():Float {
		return world.rotation();
	}

	/** World point to this bone's local space. */
	public function worldToLocal(wx:Float, wy:Float):Array<Float> {
		var inv = world.invert();
		return [inv.applyX(wx, wy), inv.applyY(wx, wy)];
	}

	/** Local pose property by name ("x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"); NaN if unknown. */
	public function get(property:String):Float {
		return switch (property) {
			case "x": x;
			case "y": y;
			case "rotation": rotation;
			case "scaleX": scaleX;
			case "scaleY": scaleY;
			case "shearX": shearX;
			case "shearY": shearY;
			default: Math.NaN;
		}
	}

	/** Set a local pose property by name; returns false if the name is not a bone property. */
	public function set(property:String, v:Float):Bool {
		switch (property) {
			case "x":
				x = v;
			case "y":
				y = v;
			case "rotation":
				rotation = v;
			case "scaleX":
				scaleX = v;
			case "scaleY":
				scaleY = v;
			case "shearX":
				shearX = v;
			case "shearY":
				shearY = v;
			default:
				return false;
		}
		return true;
	}

	public function toString():String {
		return data.name;
	}
}
