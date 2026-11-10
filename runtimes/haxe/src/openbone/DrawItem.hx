package openbone;

import openbone.MathUtil;
import openbone.data.Model;

/** The texture a draw item samples: an image or an atlas page (by id), with its pixel size. */
class TextureRef {
	public final id:String;
	public final width:Float;
	public final height:Float;

	public function new(id:String, width:Float, height:Float) {
		this.id = id;
		this.width = width;
		this.height = height;
	}
}

/** A clipping mask in world space: outline polygon and its triangulation. Shared by consecutive items under it. */
class ClipRegion {
	public final slot:Slot;
	public final polygon:Array<Float>;
	public final indices:Array<Int>;

	public function new(slot:Slot, polygon:Array<Float>, indices:Array<Int>) {
		this.slot = slot;
		this.polygon = polygon;
		this.indices = indices;
	}
}

/** Shape outline stroke. */
class Stroke {
	public final color:Array<Float>;
	public final width:Float;
	public final outline:Array<Float>;

	public function new(color:Array<Float>, width:Float, outline:Array<Float>) {
		this.color = color;
		this.width = width;
		this.outline = outline;
	}
}

/** Text to draw in the item's box (content already filled in from its template). */
class DrawText {
	public var content:String;
	public var font:String;
	public var align:String;
	public var size = 0.0;
	public var weight = 0.0;
	public var width = 0.0;
	public var height = 0.0;
	public var outlineWidth = 0.0;
	public var fill:Array<Float>;
	public var outline:Array<Float>;

	/** Box centre to world (skeleton space, y-up). */
	public var matrix:Affine;

	public function new() {}
}

/**
 * One renderable piece of the draw list, in draw order. Vertices are world x,y pairs (skeleton space, y up), uvs are
 * in `texture` space (0..1, v down). Values are float32-rounded, held in doubles.
 */
class DrawItem {
	/** Texture id of the built-in soft round particle sprite (renderers generate it, see `particleDotAlpha`). */
	public static inline final PARTICLE_DOT_TEXTURE = "@openbone/particle-dot";

	public static inline final PARTICLE_DOT_SIZE = 64;

	/** Alpha of the soft round particle sprite at distance r from its centre (0 = centre, 1 = edge). */
	public static function particleDotAlpha(r:Float):Float {
		return Math.pow(r >= 1 ? 0 : r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65, 1.6);
	}

	public var slot:Slot;
	public var attachment:Attachment;

	/** The image drawn, or null (solid fill, text, particles without an image). */
	public var image:ImageAsset;

	public var texture:TextureRef;

	/** For packed images: the image's rect inside the page (pixels, y-down), or null. */
	public var textureRect:Array<Float>;

	public var vertices:Array<Float>;
	public var uvs:Array<Float>;
	public var indices:Array<Int>;

	/** Slot tint × attachment colour, RGBA. */
	public var color:Array<Float>;

	/** Two-colour tint dark RGB(A), or null for black. */
	public var dark:Array<Float>;

	/** "normal", "additive", "multiply" or "screen". */
	public var blend:String;

	public var stroke:Stroke;
	public var clip:ClipRegion;

	/** Per-vertex RGBA for particles (replaces `color`), or null. */
	public var colors:Array<Float>;

	/** Particle batches: look ("circle", "square", "spark", "image") and quad count; null otherwise. */
	public var particleLook:String;

	public var particleCount = 0;
	public var text:DrawText;

	public function new() {}

	/** "particles", "text" or the attachment type. */
	public function kind():String {
		return particleLook != null ? "particles" : text != null ? "text" : attachment.type;
	}
}
