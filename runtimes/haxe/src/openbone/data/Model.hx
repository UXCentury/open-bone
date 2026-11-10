package openbone.data;

/**
 * The document model (docs/format.md). One module for every data type: `import openbone.data.Model;` brings them all
 * in. Load documents with `DocumentLoader`.
 */
class Model {}

/** A loaded OpenBone document (.obone / .obonb). */
class OpenBoneDocument {
	public var format = "openbone";
	public var version = 1;
	public var name = "";
	public var width = 0.0;
	public var height = 0.0;
	public var originX = 0.0;
	public var originY = 0.0;
	public var background:String;
	public var fps = 30.0;
	public final images:Array<ImageAsset> = [];

	/** Texture atlas the images are packed into, or null. */
	public var atlas:AtlasData;

	public final skeleton = new SkeletonData();
	public final events:Array<EventData> = [];
	public final animations:Array<AnimationData> = [];
	public final stateMachines:Array<StateMachineData> = [];
	public final scripts:Array<ScriptData> = [];

	/** Sounds, buses and audio files, or null. */
	public var audio:AudioData;

	public function new() {}

	/** Animation by id, then by name; null if none. */
	public function findAnimation(ref:String):AnimationData {
		for (a in animations)
			if (a.id == ref)
				return a;
		for (a in animations)
			if (a.name == ref)
				return a;
		return null;
	}

	public function animationById(id:String):AnimationData {
		if (id == null)
			return null;
		for (a in animations)
			if (a.id == id)
				return a;
		return null;
	}

	public function eventById(id:String):EventData {
		for (e in events)
			if (e.id == id)
				return e;
		return null;
	}

	public function scriptById(id:String):ScriptData {
		for (s in scripts)
			if (s.id == id)
				return s;
		return null;
	}

	public function imageById(id:String):ImageAsset {
		for (i in images)
			if (i.id == id)
				return i;
		return null;
	}

	public function findStateMachine(ref:String):StateMachineData {
		for (s in stateMachines)
			if (s.name == ref || s.id == ref)
				return s;
		return null;
	}

	/** The default skin (the first one, whatever its name). */
	public function defaultSkin():SkinData {
		return skeleton.skins.length == 0 ? null : skeleton.skins[0];
	}

	/**
	 * What to play for a reference: a sound by id/name, or else an audio asset by id/name played with default settings
	 * on the sfx bus. Null when nothing matches.
	 */
	public function resolveSound(ref:String):SoundData {
		if (audio == null || ref == null)
			return null;
		for (s in audio.sounds)
			if (s.id == ref)
				return s;
		for (s in audio.sounds)
			if (s.name == ref)
				return s;
		var asset:AudioAsset = null;
		for (a in audio.assets)
			if (a.id == ref) {
				asset = a;
				break;
			}
		if (asset == null)
			for (a in audio.assets)
				if (a.name == ref) {
					asset = a;
					break;
				}
		if (asset == null)
			return null;
		var bus:String = null;
		for (b in audio.buses)
			if (b.name == "sfx") {
				bus = b.id;
				break;
			}
		var s = new SoundData();
		s.id = asset.id;
		s.name = asset.name;
		s.asset = asset.id;
		s.bus = bus;
		return s;
	}
}

/** An image the document uses (src is a data: URL or a path). */
class ImageAsset {
	public var id:String;
	public var name:String;
	public var src:String;
	public var width = 0.0;
	public var height = 0.0;

	public function new() {}
}

/** A texture atlas: pages (images) and the region of each packed image. */
class AtlasData {
	public final pages:Array<AtlasPage> = [];
	public final regions:Array<AtlasRegion> = [];

	/** A solid white block on a page (shapes and square particles sample its centre), or null. */
	public var white:AtlasWhite;

	public var padding = 0.0;
	public var scale = 1.0;
	public var premultipliedAlpha = false;
	public var stripWhitespace = false;
	public var polygons = false;

	public function new() {}
}

class AtlasPage {
	public var id:String;
	public var name:String;
	public var src:String;
	public var width = 0.0;
	public var height = 0.0;

	public function new() {}
}

class AtlasRegion {
	public var image:String;
	public var page:String;
	public var x = 0.0;
	public var y = 0.0;
	public var width = 0.0;
	public var height = 0.0;
	public var offsetX = 0.0;
	public var offsetY = 0.0;
	public var originalWidth = 0.0;
	public var originalHeight = 0.0;
	public var rotated = false;

	/** Outline in original-image pixels (flat x,y, y-down), or null. */
	public var polygon:Array<Float>;

	public function new() {}

	public function isTrimmed():Bool {
		return offsetX != 0 || offsetY != 0 || width != originalWidth || height != originalHeight;
	}
}

class AtlasWhite {
	public var page:String;
	public var x = 0.0;
	public var y = 0.0;
	public var width = 0.0;
	public var height = 0.0;

	public function new() {}
}

/** How a bone inherits its parent's transform. */
enum abstract Inherit(Int) {
	var Normal = 0;
	var OnlyTranslation = 1;
	var NoRotation = 2;
	var NoScale = 3;

	public static function parse(s:String):Inherit {
		return switch (s) {
			case "onlyTranslation": OnlyTranslation;
			case "noRotation": NoRotation;
			case "noScale": NoScale;
			default: Normal;
		}
	}
}

class SkeletonData {
	public final bones:Array<BoneData> = [];
	public final slots:Array<SlotData> = [];
	public final skins:Array<SkinData> = [];
	public final ik:Array<IkConstraintData> = [];
	public final transform:Array<TransformConstraintData> = [];
	public final path:Array<PathConstraintData> = [];
	public final physics:Array<PhysicsConstraintData> = [];
	public final sliders:Array<SliderData> = [];

	/** Units per 100 at which physics gravity/wind and IK softness are authored; null = 100. */
	public var referenceScale:Null<Float>;

	public function new() {}
}

class BoneData {
	public var id:String;
	public var name:String;
	public var parent:String;
	public var length = 0.0;
	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;
	public var shearX = 0.0;
	public var shearY = 0.0;
	public var inherit = Inherit.Normal;
	public var color:String;

	public function new() {}

	/** Bone setup property by name ("x", "rotation"…); NaN if unknown. */
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
}

class SlotData {
	public var id:String;
	public var name:String;
	public var bone:String;
	public var color = "#ffffff";
	public var attachment:String;

	/** "normal", "additive", "multiply" or "screen". */
	public var blend = "normal";

	/** Two-colour tint dark colour, or null. */
	public var dark:String;

	public function new() {}
}

/** An insertion-ordered string map (the file's key order matters for attachments). */
class OrderedMap<V> {
	public final keys:Array<String> = [];

	final map:Map<String, V> = new Map();

	public function new() {}

	public inline function exists(k:String):Bool {
		return map.exists(k);
	}

	public inline function get(k:String):Null<V> {
		return map.get(k);
	}

	public function set(k:String, v:V):Void {
		if (!map.exists(k))
			keys.push(k);
		map.set(k, v);
	}

	public function remove(k:String):Bool {
		if (!map.exists(k))
			return false;
		map.remove(k);
		keys.remove(k);
		return true;
	}

	public function clear():Void {
		keys.resize(0);
		map.clear();
	}
}

class SkinData {
	public var id:String;
	public var name:String;

	/** Slot id → attachment name → attachment (insertion ordered, as in the file). */
	public final attachments = new OrderedMap<OrderedMap<Attachment>>();

	/** Skin bones / skin constraints (ids), or null. */
	public var bones:Array<String>;

	public var constraints:Array<String>;

	public function new() {}

	public function get(slotId:String, name:String):Attachment {
		var m = attachments.get(slotId);
		return m == null ? null : m.get(name);
	}
}

// ---------------- Attachments ----------------

/** Base of every attachment kind; `type` is the file's type string ("region", "mesh"…). */
class Attachment {
	public var type:String;
	public var name:String;

	function new(type:String) {
		this.type = type;
	}
}

class RegionAttachment extends Attachment {
	public var image:String;
	public var color = "#ffffffff";
	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;
	public var skewX = 0.0;
	public var skewY = 0.0;
	public var width = 0.0;
	public var height = 0.0;

	public function new() {
		super("region");
	}
}

class VertexWeight {
	public var bone:String;
	public var x = 0.0;
	public var y = 0.0;
	public var weight = 0.0;

	public function new() {}
}

class LinkedMesh {
	public var mesh:String;
	public var slot:String;
	public var skin:String;
	public var deform = false;

	public function new() {}
}

class MeshAttachment extends Attachment {
	public var image:String;
	public var color = "#ffffffff";
	public var uvs:Array<Float> = [];
	public var vertices:Array<Float> = [];
	public var triangles:Array<Int> = [];

	/** Per vertex: its bone influences, or null for an unweighted mesh. */
	public var weights:Array<Array<VertexWeight>>;

	public var hull = 0;

	/** Linked mesh info, or null. */
	public var linked:LinkedMesh;

	public function new() {
		super("mesh");
	}
}

class ShapeAttachment extends Attachment {
	/** "rect", "ellipse" or "polygon". */
	public var shape = "rect";

	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var width = 0.0;
	public var height = 0.0;
	public var radius = 0.0;
	public var points:Array<Float>;
	public var fill = "#ffffffff";
	public var stroke:String;
	public var strokeWidth:Null<Float>;

	public function new() {
		super("shape");
	}
}

class BoundingBoxAttachment extends Attachment {
	public var vertices:Array<Float> = [];

	/** Optional per-vertex bone influences (mesh layout), so the box bends with several bones. */
	public var weights:Array<Array<VertexWeight>>;

	public function new() {
		super("boundingBox");
	}
}

class PointAttachment extends Attachment {
	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;

	public function new() {
		super("point");
	}
}

class ClippingAttachment extends Attachment {
	public var vertices:Array<Float> = [];

	/** Slot id the mask ends at (inclusive), or null for never. */
	public var end:String;

	public function new() {
		super("clipping");
	}
}

class PathAttachment extends Attachment {
	public var vertices:Array<Float> = [];
	public var weights:Array<Array<VertexWeight>>;
	public var closed = false;
	public var color = "#ff8800ff";

	public function new() {
		super("path");
	}
}

class SequenceFrame {
	public var image:String;

	/** Sub-rectangle [x, y, width, height] of the image, or null for the whole image. */
	public var rect:Array<Float>;

	/** Trim [x, y, sourceWidth, sourceHeight], or null. */
	public var trim:Array<Float>;

	public function new() {}
}

class SequenceAttachment extends Attachment {
	public final frames:Array<SequenceFrame> = [];
	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var scaleX = 1.0;
	public var scaleY = 1.0;
	public var skewX = 0.0;
	public var skewY = 0.0;
	public var width = 0.0;
	public var height = 0.0;
	public var fps = 24.0;
	public var offset = 0.0;
	public var color = "#ffffffff";

	/** "loop", "once", "pingPong" or "holdLast". */
	public var mode = "loop";

	/** Number input id that drives the frame, or null. */
	public var input:String;

	public function new() {
		super("sequence");
	}
}

class ParticleBurst {
	public var time = 0.0;
	public var count = 0.0;

	public function new() {}
}

class ColorStop {
	public var t:Float;
	public var color:String;

	public function new(t:Float, color:String) {
		this.t = t;
		this.color = color;
	}
}

/** A particle emitter. Missing fields take the defaults below (core/particles.ts defaultParticleSettings). */
class ParticlesAttachment extends Attachment {
	public var emitting = true;
	public var rate = 20.0;
	public final bursts:Array<ParticleBurst> = [];
	public var maxParticles = 200.0;
	public var duration = 1.0;
	public var loop = true;
	public var prewarm = false;

	/** "point", "circle", "box" or "cone". */
	public var shape = "point";

	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 90.0;
	public var angle = 30.0;
	public var radius = 10.0;
	public var width = 40.0;
	public var height = 40.0;

	/** "world" or "local". */
	public var space = "world";

	public var lifetime:Array<Float> = [0.8, 1.2];
	public var speed:Array<Float> = [80, 120];
	public var gravity = 0.0;
	public var drag = 0.0;
	public var startSize:Array<Float> = [10, 14];
	public var endSize:Array<Float> = [2, 4];
	public var startRotation:Array<Float> = [0, 0];
	public var endRotation:Array<Float> = [0, 0];
	public var angularVelocity:Array<Float> = [0, 0];
	public final colors:Array<ColorStop> = [];
	public var blend = "normal";

	/** "circle", "square", "spark" or "image". */
	public var look = "circle";

	public var image:String;
	public var stretch = 0.05;
	public var seed = 1.0;

	public function new() {
		super("particles");
	}
}

class TextAttachment extends Attachment {
	/** Text or template ("{score:0.00}x"). */
	public var text = "";

	public var x = 0.0;
	public var y = 0.0;
	public var rotation = 0.0;
	public var width = 0.0;
	public var height = 0.0;
	public var size = 24.0;
	public var weight = 400.0;
	public var font = "sans-serif";
	public var color = "#ffffffff";

	/** "left", "center" or "right". */
	public var align = "center";

	public var outline:String;
	public var outlineWidth:Null<Float>;

	public function new() {
		super("text");
	}
}

// ---------------- Constraints ----------------

/** Base of the four constraint kinds. */
class ConstraintData {
	public var id:String;
	public var name:String;

	/** Position in the update order (see Skeleton constraint order), or null for the default position. */
	public var order:Null<Float>;

	/** "ik", "transform", "path" or "physics". */
	public final kind:String;

	function new(kind:String) {
		this.kind = kind;
	}
}

class IkConstraintData extends ConstraintData {
	public final bones:Array<String> = [];
	public var target:String;
	public var mix = 1.0;
	public var softness = 0.0;
	public var bendPositive = true;
	public var stretch = false;
	public var compress = false;
	public var uniform = false;

	public function new() {
		super("ik");
	}
}

class TransformConstraintData extends ConstraintData {
	public final bones:Array<String> = [];
	public var target:String;
	public var mixRotate = 0.0;
	public var mixTranslate = 0.0;
	public var mixScale = 0.0;
	public var mixShear = 0.0;
	public var offsetRotation = 0.0;
	public var offsetX = 0.0;
	public var offsetY = 0.0;
	public var offsetScaleX = 0.0;
	public var offsetScaleY = 0.0;
	public var offsetShear = 0.0;
	public var local = false;
	public var relative = false;

	public function new() {
		super("transform");
	}
}

class PathConstraintData extends ConstraintData {
	public final bones:Array<String> = [];

	/** Slot id holding the path attachment. */
	public var target:String;

	/** "fixed" or "percent". */
	public var positionMode = "percent";

	/** "length", "fixed", "percent" or "proportional". */
	public var spacingMode = "length";

	/** "tangent", "chain" or "chainScale". */
	public var rotateMode = "tangent";

	/**
	 * Arc-length placement inside each bezier segment (default). False: the segment is found by arc length, the point
	 * inside it at the raw bezier parameter (docs/runtime-spec.md §7.3 "Constant speed off").
	 */
	public var constantSpeed = true;

	public var offsetRotation = 0.0;
	public var position = 0.0;
	public var spacing = 0.0;
	public var mixRotate = 0.0;
	public var mixX = 0.0;
	public var mixY = 0.0;

	public function new() {
		super("path");
	}
}

class PhysicsConstraintData extends ConstraintData {
	public var bone:String;
	public var x = 0.0;
	public var y = 0.0;
	public var rotate = 0.0;
	public var scaleX = 0.0;
	public var inertia = 0.0;
	public var strength = 0.0;
	public var damping = 0.0;
	public var mass = 0.0;
	public var gravity = 0.0;
	public var wind = 0.0;
	public var mix = 0.0;
	public var fps = 0.0;

	public function new() {
		super("physics");
	}
}

/** Scrubs an animation from a driver: a bone's local property or a number input. */
class SliderData {
	public var id:String;
	public var name:String;
	public var animation:String;
	public var bone:String;
	public var property:String;
	public var input:String;
	public var from = 0.0;
	public var to = 0.0;
	public var mix = 1.0;
	public var timeFrom:Null<Float>;
	public var timeTo:Null<Float>;
	public var loop = false;
	public var additive = false;

	public function new() {}
}

// ---------------- Animations ----------------

/** Key curve: linear, stepped or a cubic bezier [x1, y1, x2, y2]. */
class Curve {
	public static final LINEAR = new Curve(0, null);
	public static final STEPPED = new Curve(1, null);

	/** 0 linear, 1 stepped, 2 bezier. */
	public final kind:Int;

	public final bezier:Array<Float>;

	function new(kind:Int, bezier:Array<Float>) {
		this.kind = kind;
		this.bezier = bezier;
	}

	public static function makeBezier(x1:Float, y1:Float, x2:Float, y2:Float):Curve {
		return new Curve(2, [x1, y1, x2, y2]);
	}

	public inline function isStepped():Bool {
		return kind == 1;
	}

	/** Eased fraction for t in 0..1 (bezier solved by bisection, as in core/math.ts evalCurve). */
	public function apply(t:Float):Float {
		if (kind == 0)
			return t;
		if (kind == 1)
			return 0;
		var x1 = bezier[0], y1 = bezier[1], x2 = bezier[2], y2 = bezier[3];
		var lo = 0.0, hi = 1.0, s = t;
		for (i in 0...24) {
			var x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s - t;
			if (Math.abs(x) < 1e-6)
				break;
			if (x > 0)
				hi = s;
			else
				lo = s;
			s = (lo + hi) / 2;
		}
		return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
	}
}

/**
 * One timeline key. `value` is a Float (numbers), String (colours, attachment names, inherit modes), Bool
 * (switches), null, Array<Float> (deform offsets) or Array<String> (draw order slot ids).
 */
class Key {
	public var time = 0.0;
	public var value:Dynamic;
	public var curve = Curve.LINEAR;

	public function new() {}
}

/** Keys for one property of one target ("bone", "slot", "ik", "transform", "path", "physics", "sequence", "particles", "deform", "drawOrder"). */
class Timeline {
	public var target:String;
	public var id:String;
	public var property:String;

	/** Attachment name for deform and sequence timelines. */
	public var attachment:String;

	public var keys:Array<Key> = [];

	public function new() {}
}

class EventKey {
	public var time = 0.0;
	public var event:String;

	/** Payload overrides, or null to use the event's. */
	public var intValue:Null<Float>;

	public var floatValue:Null<Float>;
	public var stringValue:String;

	public function new() {}
}

class AudioKey {
	public var time = 0.0;
	public var sound:String;
	public var volume:Null<Float>;
	public var rate:Null<Float>;
	public var loop:Null<Bool>;

	public function new() {}
}

class AnimationData {
	public var id:String;
	public var name:String;
	public var duration = 0.0;
	public final timelines:Array<Timeline> = [];
	public final events:Array<EventKey> = [];
	public final audio:Array<AudioKey> = [];

	public function new() {}

	/** Explicit duration if > 0, else the last key time of any timeline, event or audio key. */
	public function getDuration():Float {
		if (duration > 0)
			return duration;
		var t = 0.0;
		for (tl in timelines)
			for (k in tl.keys)
				t = Math.max(t, k.time);
		for (e in events)
			t = Math.max(t, e.time);
		for (k in audio)
			t = Math.max(t, k.time);
		return t;
	}
}

class EventData {
	public var id:String;
	public var name:String;
	public var intValue = 0.0;
	public var floatValue = 0.0;
	public var stringValue = "";

	/** Sound (or audio asset) played when it fires, or null. */
	public var audio:String;

	public var volume:Null<Float>;

	public function new() {}
}

class ScriptData {
	public var id:String;
	public var name:String;
	public var code = "";

	public function new() {}
}

// ---------------- Audio ----------------

class AudioData {
	public var master = 1.0;
	public var muted = false;
	public final assets:Array<AudioAsset> = [];
	public final buses:Array<AudioBus> = [];
	public final sounds:Array<SoundData> = [];

	public function new() {}
}

class AudioAsset {
	public var id:String;
	public var name:String;
	public var src:String;
	public var duration = 0.0;

	public function new() {}
}

class AudioBus {
	public var id:String;
	public var name:String;
	public var volume = 1.0;
	public var muted = false;

	public function new() {}
}

class SoundData {
	public var id:String;
	public var name:String;
	public var asset:String;
	public var bus:String;
	public var volume = 1.0;
	public var rate = 1.0;
	public var fadeIn = 0.0;
	public var fadeOut = 0.0;
	public var loop = false;

	public function new() {}
}

// ---------------- State machines ----------------

/** A Rive-style state machine: inputs, layers of states and transitions, pointer listeners, bindings and scripts. */
class StateMachineData {
	public static inline final ANY_STATE = "@any";

	public var id:String;
	public var name:String;
	public final inputs:Array<SmInput> = [];
	public final bindings:Array<SmBinding> = [];
	public final layers:Array<SmLayer> = [];
	public final listeners:Array<SmListener> = [];
	public final scripts:Array<String> = [];

	public function new() {}
}

class SmInput {
	public var id:String;
	public var name:String;

	/** "bool", "number", "trigger" or "string". */
	public var type:String;

	/** Float, Bool or String; null if absent. */
	public var defaultValue:Dynamic;

	public function new() {}
}

class SmBinding {
	public var id:String;
	public var input:String;
	public var target:String;
	public var object:String;
	public var property:String;
	public var inMin = 0.0;
	public var inMax = 0.0;

	/** Float or hex String. */
	public var outMin:Dynamic;

	public var outMax:Dynamic;

	public function new() {}
}

class SmLayer {
	public var id:String;
	public var name:String;
	public var entry:String;
	public final states:Array<SmState> = [];
	public final transitions:Array<SmTransition> = [];

	public function new() {}
}

class SmState {
	public var id:String;
	public var name:String;

	/** "animation", "blend1d" or "exit". */
	public var type = "animation";

	public var animation:String;
	public var blendInput:String;
	public var onComplete:String;
	public var loop = true;
	public var speed = 1.0;
	public final blend:Array<SmBlendEntry> = [];
	public final scripts:Array<String> = [];
	public final sounds:Array<SmSound> = [];
	public final emitters:Array<SmEmitter> = [];
	public final inputs:Array<SmStateInput> = [];

	public function new() {}
}

class SmBlendEntry {
	public var animation:String;
	public var value = 0.0;

	public function new() {}
}

class SmSound {
	public var sound:String;

	/** "enter" or "exit". */
	public var on:String;

	/** "play" or "stop". */
	public var action:String;

	public var volume:Null<Float>;

	public function new() {}
}

class SmEmitter {
	public var slot:String;
	public var emitting = false;

	public function new() {}
}

class SmStateInput {
	public var input:String;
	public var value:Dynamic;

	public function new() {}
}

class SmTransition {
	public var id:String;
	public var from:String;
	public var to:String;
	public final conditions:Array<SmCondition> = [];
	public var duration = 0.0;

	/** Null when absent. */
	public var exitTime:Null<Float>;

	public function new() {}
}

class SmCondition {
	public var input:String;
	public var op:String;
	public var value:Dynamic;

	public function new() {}
}

class SmListener {
	public var id:String;
	public var name:String;
	public var slot:String;

	/** "down", "up", "enter", "exit", "move" or "click". */
	public var event:String;

	public final actions:Array<SmAction> = [];

	public function new() {}
}

/** A listener action; which fields are set depends on `type`. */
class SmAction {
	public var type:String;
	public var input:String;
	public var event:String;
	public var script:String;
	public var fn:String;
	public var sound:String;
	public var slot:String;
	public var value:Dynamic;
	public var volume:Null<Float>;
	public var fade:Null<Float>;
	public var emitting = false;
	public var count = 0.0;

	/** setMute: bus id (null = the master) and the new state (null = "toggle"). */
	public var bus:String;

	public var muted:Null<Bool>;

	public function new() {}
}
