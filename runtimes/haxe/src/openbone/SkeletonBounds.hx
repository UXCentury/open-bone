package openbone;

import openbone.data.Model;

/** One active bounding box: the world polygon of a slot's current bounding-box attachment. */
class BoundingBoxPolygon {
	public final slot:Slot;

	/** Attachment name. */
	public final attachment:String;

	/** World x,y pairs (float32 values; skeleton space, y up: the draw list's coordinates). */
	public final vertices:Array<Float>;

	public var minX = Math.POSITIVE_INFINITY;
	public var minY = Math.POSITIVE_INFINITY;
	public var maxX = Math.NEGATIVE_INFINITY;
	public var maxY = Math.NEGATIVE_INFINITY;

	public function new(slot:Slot, attachment:String, vertices:Array<Float>) {
		this.slot = slot;
		this.attachment = attachment;
		this.vertices = vertices;
		var i = 0;
		while (i + 1 < vertices.length) {
			minX = Math.min(minX, vertices[i]);
			minY = Math.min(minY, vertices[i + 1]);
			maxX = Math.max(maxX, vertices[i]);
			maxY = Math.max(maxY, vertices[i + 1]);
			i += 2;
		}
	}
}

/**
 * The active bounding boxes of a skeleton for one pose (like Spine's SkeletonBounds; runtime/src/bounds.ts,
 * docs/runtime-spec.md §8.10): every slot, in draw order, whose bone is active and whose current attachment is a
 * bounding box. Call `update` after the pose changes (or take a new one with `skeleton.boundingBoxes()`). All
 * coordinates are skeleton world space, the draw list's.
 *
 * When nothing is active the overall box is all zeros and every query returns nothing.
 */
class SkeletonBounds {
	public var boxes:Array<BoundingBoxPolygon> = [];
	public var minX = 0.0;
	public var minY = 0.0;
	public var maxX = 0.0;
	public var maxY = 0.0;

	public function new(?skeleton:Skeleton) {
		if (skeleton != null)
			update(skeleton);
	}

	/** Recompute the polygons from the skeleton's current world pose. */
	public function update(skeleton:Skeleton):SkeletonBounds {
		boxes = [];
		var x0 = Math.POSITIVE_INFINITY, y0 = Math.POSITIVE_INFINITY;
		var x1 = Math.NEGATIVE_INFINITY, y1 = Math.NEGATIVE_INFINITY;
		for (slot in skeleton.drawOrder) {
			if (!slot.bone.active)
				continue;
			var att = skeleton.getAttachment(slot);
			if (att == null || !Std.isOfType(att, BoundingBoxAttachment) || (cast att : BoundingBoxAttachment).vertices.length < 6)
				continue;
			var box = new BoundingBoxPolygon(slot, att.name, skeleton.attachmentWorldVertices(slot, att));
			x0 = Math.min(x0, box.minX);
			y0 = Math.min(y0, box.minY);
			x1 = Math.max(x1, box.maxX);
			y1 = Math.max(y1, box.maxY);
			boxes.push(box);
		}
		if (boxes.length == 0)
			x0 = y0 = x1 = y1 = 0;
		minX = x0;
		minY = y0;
		maxX = x1;
		maxY = y1;
		return this;
	}

	/** True if the point is inside the overall AABB (edges included). */
	public function aabbContainsPoint(x:Float, y:Float):Bool {
		return boxes.length > 0 && x >= minX && x <= maxX && y >= minY && y <= maxY;
	}

	/** True if the overall AABB overlaps the given rectangle (edges included). */
	public function aabbIntersects(x0:Float, y0:Float, x1:Float, y1:Float):Bool {
		return boxes.length > 0 && x0 <= maxX && x1 >= minX && y0 <= maxY && y1 >= minY;
	}

	/** The first box (in draw order) containing the point, or null. The last match is the one drawn on top. */
	public function containsPoint(x:Float, y:Float):Null<BoundingBoxPolygon> {
		for (b in boxes)
			if (boxContains(b, x, y))
				return b;
		return null;
	}

	/** Every box containing the point, in draw order. */
	public function containsPointAll(x:Float, y:Float):Array<BoundingBoxPolygon> {
		return [for (b in boxes) if (boxContains(b, x, y)) b];
	}

	/** The first box (in draw order) the segment touches: it crosses an edge or lies inside. Null if none. */
	public function intersectsSegment(x1:Float, y1:Float, x2:Float, y2:Float):Null<BoundingBoxPolygon> {
		for (b in boxes)
			if (boxSegment(b, x1, y1, x2, y2))
				return b;
		return null;
	}

	/** Every box the segment touches, in draw order. */
	public function intersectsSegmentAll(x1:Float, y1:Float, x2:Float, y2:Float):Array<BoundingBoxPolygon> {
		return [for (b in boxes) if (boxSegment(b, x1, y1, x2, y2)) b];
	}

	/**
	 * The first overlapping pair of polygons between these boxes and another skeleton's: `[mine, theirs]`, scanning
	 * mine in draw order and theirs in draw order for each. Polygons overlap when edges cross or one holds a vertex of
	 * the other. Null if none overlap.
	 */
	public function intersectsBounds(other:SkeletonBounds):Null<Array<BoundingBoxPolygon>> {
		if (!aabbIntersects(other.minX, other.minY, other.maxX, other.maxY))
			return null;
		for (a in boxes)
			for (b in other.boxes)
				if (polygonsOverlap(a, b))
					return [a, b];
		return null;
	}

	/** Closed segments p1-p2 and p3-p4 cross or touch (not counting parallel ones). */
	public static function segmentsIntersect(x1:Float, y1:Float, x2:Float, y2:Float, x3:Float, y3:Float, x4:Float, y4:Float):Bool {
		var d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
		if (d == 0)
			return false;
		var ua = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
		var ub = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
		return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
	}

	static function boxContains(b:BoundingBoxPolygon, x:Float, y:Float):Bool {
		return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && MathUtil.pointInPolygon(x, y, b.vertices);
	}

	/** Some edge of polygon v (`v[j] -> v[i]`, j the previous vertex, starting with j = last) crosses the segment. */
	static function edgeCrosses(v:Array<Float>, x1:Float, y1:Float, x2:Float, y2:Float):Bool {
		var n = v.length;
		var i = 0, j = n - 2;
		while (i < n) {
			if (segmentsIntersect(x1, y1, x2, y2, v[j], v[j + 1], v[i], v[i + 1]))
				return true;
			j = i;
			i += 2;
		}
		return false;
	}

	static function boxSegment(b:BoundingBoxPolygon, x1:Float, y1:Float, x2:Float, y2:Float):Bool {
		if (Math.max(x1, x2) < b.minX || Math.min(x1, x2) > b.maxX || Math.max(y1, y2) < b.minY || Math.min(y1, y2) > b.maxY)
			return false;
		return edgeCrosses(b.vertices, x1, y1, x2, y2) || MathUtil.pointInPolygon(x1, y1, b.vertices);
	}

	static function polygonsOverlap(a:BoundingBoxPolygon, b:BoundingBoxPolygon):Bool {
		if (a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
			return false;
		var v = a.vertices;
		var n = v.length;
		var i = 0, j = n - 2;
		while (i < n) {
			if (edgeCrosses(b.vertices, v[j], v[j + 1], v[i], v[i + 1]))
				return true;
			j = i;
			i += 2;
		}
		return MathUtil.pointInPolygon(v[0], v[1], b.vertices) || MathUtil.pointInPolygon(b.vertices[0], b.vertices[1], v);
	}
}
