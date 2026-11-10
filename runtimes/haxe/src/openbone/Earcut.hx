package openbone;

/**
 * Polygon triangulation: a port of mapbox earcut 3.2.4 (ISC licence, Copyright (c) 2024 Mapbox) for simple polygons
 * without holes. Results match the JavaScript library exactly (the conformance suite compares indices).
 */
class Earcut {
	/** Triangles (index triplets) of a polygon given as flat x,y pairs. */
	public static function triangulate(data:Array<Float>):Array<Int> {
		var triangles:Array<Int> = [];
		var outerLen = data.length;
		var outerNode = linkedList(data, 0, outerLen, true);
		if (outerNode == null || outerNode.next == outerNode.prev)
			return [];
		var minX = 0.0, minY = 0.0, invSize = 0.0;
		if (data.length > 80 * 2) {
			minX = data[0];
			minY = data[1];
			var maxX = minX, maxY = minY;
			var i = 2;
			while (i < outerLen) {
				var x = data[i], y = data[i + 1];
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
				i += 2;
			}
			invSize = Math.max(maxX - minX, maxY - minY);
			invSize = invSize != 0 ? 32767 / invSize : 0;
		}
		earcutLinked(outerNode, triangles, minX, minY, invSize, new EarState());
		return triangles;
	}

	static function linkedList(data:Array<Float>, start:Int, end:Int, clockwise:Bool):EarNode {
		var last:EarNode = null;
		if (clockwise == (signedArea(data, start, end) > 0)) {
			var i = start;
			while (i < end) {
				last = insertNode(Std.int(i / 2), data[i], data[i + 1], last);
				i += 2;
			}
		} else {
			var i = end - 2;
			while (i >= start) {
				last = insertNode(Std.int(i / 2), data[i], data[i + 1], last);
				i -= 2;
			}
		}
		if (last != null && equals(last, last.next)) {
			removeNode(last);
			last = last.next;
		}
		return last;
	}

	static function filterPoints(start:EarNode, end:EarNode, st:EarState):EarNode {
		var full = end == start;
		var p = start;
		var again:Bool;
		do {
			again = false;
			if (p != p.next && (equals(p, p.next) || area(p.prev, p, p.next) == 0)) {
				if (full || p == end)
					end = p.prev;
				st.filteredOut = true;
				removeNode(p);
				p = p.prev;
				again = true;
			} else if (full || p != end) {
				p = p.next;
				again = !full;
			}
		} while (again || p != end);
		return end;
	}

	static function earcutLinked(ear:EarNode, triangles:Array<Int>, minX:Float, minY:Float, invSize:Float, st:EarState):Void {
		if (invSize != 0)
			indexCurve(ear, minX, minY, invSize);
		var stop = ear;
		var cured = false;
		while (ear.prev != ear.next) {
			var prev = ear.prev;
			var next = ear.next;
			if (area(prev, ear, next) < 0 && (invSize != 0 ? isEarHashed(ear, minX, minY, invSize) : isEar(ear))) {
				triangles.push(prev.i);
				triangles.push(ear.i);
				triangles.push(next.i);
				removeNode(ear);
				ear = next;
				stop = next;
				continue;
			}
			ear = next;
			if (ear == stop) {
				st.filteredOut = false;
				ear = filterPoints(ear, ear, st);
				if (st.filteredOut) {
					stop = ear;
					continue;
				}
				if (!cured) {
					ear = cureLocalIntersections(ear, triangles, st);
					stop = ear;
					cured = true;
					continue;
				}
				splitEarcut(ear, triangles, minX, minY, invSize, st);
				break;
			}
		}
	}

	static function isEar(ear:EarNode):Bool {
		var a = ear.prev, b = ear, c = ear.next;
		var ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
		var x0 = Math.min(ax, Math.min(bx, cx)), y0 = Math.min(ay, Math.min(by, cy));
		var x1 = Math.max(ax, Math.max(bx, cx)), y1 = Math.max(ay, Math.max(by, cy));
		var p = c.next;
		while (p != a) {
			if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && !(ax == p.x && ay == p.y)
				&& pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0)
				return false;
			p = p.next;
		}
		return true;
	}

	static function isEarHashed(ear:EarNode, minX:Float, minY:Float, invSize:Float):Bool {
		var a = ear.prev, b = ear, c = ear.next;
		var ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
		var x0 = Math.min(ax, Math.min(bx, cx)), y0 = Math.min(ay, Math.min(by, cy));
		var x1 = Math.max(ax, Math.max(bx, cx)), y1 = Math.max(ay, Math.max(by, cy));
		var minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
		var p = ear.prevZ;
		while (p != null && p.z >= minZ) {
			if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p != c && !(ax == p.x && ay == p.y)
				&& pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0)
				return false;
			p = p.prevZ;
		}
		var n = ear.nextZ;
		while (n != null && n.z <= maxZ) {
			if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n != c && !(ax == n.x && ay == n.y)
				&& pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0)
				return false;
			n = n.nextZ;
		}
		return true;
	}

	static function cureLocalIntersections(start:EarNode, triangles:Array<Int>, st:EarState):EarNode {
		var p = start;
		var cured = false;
		do {
			var a = p.prev, b = p.next.next;
			if (intersects(a, p, p.next, b, false) && locallyInside(a, b) && locallyInside(b, a)) {
				triangles.push(a.i);
				triangles.push(p.i);
				triangles.push(b.i);
				removeNode(p);
				removeNode(p.next);
				p = start = b;
				cured = true;
			}
			p = p.next;
		} while (p != start);
		return cured ? filterPoints(p, p, st) : p;
	}

	static function splitEarcut(start:EarNode, triangles:Array<Int>, minX:Float, minY:Float, invSize:Float, st:EarState):Void {
		var a = start;
		do {
			var b = a.next.next;
			while (b != a.prev) {
				if (a.i != b.i && isValidDiagonal(a, b)) {
					var c = splitPolygon(a, b);
					a = filterPoints(a, a.next, st);
					c = filterPoints(c, c.next, st);
					earcutLinked(a, triangles, minX, minY, invSize, st);
					earcutLinked(c, triangles, minX, minY, invSize, st);
					return;
				}
				b = b.next;
			}
			a = a.next;
		} while (a != start);
	}

	static function indexCurve(start:EarNode, minX:Float, minY:Float, invSize:Float):Void {
		var nodes:Array<EarNode> = [];
		var p = start;
		do {
			p.z = zOrder(p.x, p.y, minX, minY, invSize);
			nodes.push(p);
			p = p.next;
		} while (p != start);
		// Stable sort by z (earcut uses insertion sort / LSD radix, both stable).
		haxe.ds.ArraySort.sort(nodes, (u, v) -> u.z < v.z ? -1 : u.z > v.z ? 1 : 0);
		var prev:EarNode = null;
		for (node in nodes) {
			node.prevZ = prev;
			if (prev != null)
				prev.nextZ = node;
			prev = node;
		}
		prev.nextZ = null;
	}

	static function zOrder(xd:Float, yd:Float, minX:Float, minY:Float, invSize:Float):Int {
		var x = Std.int((xd - minX) * invSize);
		var y = Std.int((yd - minY) * invSize);
		x = (x | (x << 8)) & 0x00FF00FF;
		x = (x | (x << 4)) & 0x0F0F0F0F;
		x = (x | (x << 2)) & 0x33333333;
		x = (x | (x << 1)) & 0x55555555;
		y = (y | (y << 8)) & 0x00FF00FF;
		y = (y | (y << 4)) & 0x0F0F0F0F;
		y = (y | (y << 2)) & 0x33333333;
		y = (y | (y << 1)) & 0x55555555;
		return x | (y << 1);
	}

	static inline function pointInTriangle(ax:Float, ay:Float, bx:Float, by:Float, cx:Float, cy:Float, px:Float, py:Float):Bool {
		return (cx - px) * (ay - py) >= (ax - px) * (cy - py)
			&& (ax - px) * (by - py) >= (bx - px) * (ay - py)
			&& (bx - px) * (cy - py) >= (cx - px) * (by - py);
	}

	static function isValidDiagonal(a:EarNode, b:EarNode):Bool {
		var zeroLength = equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0;
		return a.next.i != b.i
			&& (zeroLength || locallyInside(a, b) && locallyInside(b, a) && (area(a.prev, a, b.prev) != 0 || area(a, b.prev, b) != 0))
			&& !intersectsPolygon(a, b)
			&& (zeroLength || middleInside(a, b));
	}

	static inline function area(p:EarNode, q:EarNode, r:EarNode):Float {
		return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
	}

	static inline function equals(p1:EarNode, p2:EarNode):Bool {
		return p1.x == p2.x && p1.y == p2.y;
	}

	static function intersects(p1:EarNode, q1:EarNode, p2:EarNode, q2:EarNode, includeBoundary:Bool):Bool {
		var o1 = area(p1, q1, p2), o2 = area(p1, q1, q2), o3 = area(p2, q2, p1), o4 = area(p2, q2, q1);
		if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
			return true;
		if (!includeBoundary)
			return false;
		if (o1 == 0 && onSegment(p1, p2, q1)) return true;
		if (o2 == 0 && onSegment(p1, q2, q1)) return true;
		if (o3 == 0 && onSegment(p2, p1, q2)) return true;
		if (o4 == 0 && onSegment(p2, q1, q2)) return true;
		return false;
	}

	static function onSegment(p:EarNode, q:EarNode, r:EarNode):Bool {
		return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
	}

	static function intersectsPolygon(a:EarNode, b:EarNode):Bool {
		var minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
		var p = a;
		do {
			var n = p.next;
			if ((p.x > maxX && n.x > maxX) || (p.x < minX && n.x < minX) || (p.y > maxY && n.y > maxY) || (p.y < minY && n.y < minY)) {
				p = n;
				continue;
			}
			if (p.i != a.i && n.i != a.i && p.i != b.i && n.i != b.i && intersects(p, n, a, b, true))
				return true;
			p = n;
		} while (p != a);
		return false;
	}

	static function locallyInside(a:EarNode, b:EarNode):Bool {
		return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
	}

	static function middleInside(a:EarNode, b:EarNode):Bool {
		var p = a;
		var inside = false;
		var px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
		do {
			var n = p.next;
			if (((p.y > py) != (n.y > py)) && (px < (n.x - p.x) * (py - p.y) / (n.y - p.y) + p.x))
				inside = !inside;
			p = n;
		} while (p != a);
		return inside;
	}

	static function splitPolygon(a:EarNode, b:EarNode):EarNode {
		var a2 = new EarNode(a.i, a.x, a.y), b2 = new EarNode(b.i, b.x, b.y), an = a.next, bp = b.prev;
		a.next = b;
		b.prev = a;
		a2.next = an;
		an.prev = a2;
		b2.next = a2;
		a2.prev = b2;
		bp.next = b2;
		b2.prev = bp;
		return b2;
	}

	static function insertNode(i:Int, x:Float, y:Float, last:EarNode):EarNode {
		var p = new EarNode(i, x, y);
		if (last == null) {
			p.prev = p;
			p.next = p;
		} else {
			p.next = last.next;
			p.prev = last;
			last.next.prev = p;
			last.next = p;
		}
		return p;
	}

	static function removeNode(p:EarNode):Void {
		p.next.prev = p.prev;
		p.prev.next = p.next;
		if (p.prevZ != null)
			p.prevZ.nextZ = p.nextZ;
		if (p.nextZ != null)
			p.nextZ.prevZ = p.prevZ;
	}

	static function signedArea(data:Array<Float>, start:Int, end:Int):Float {
		var sum = 0.0;
		var i = start, j = end - 2;
		while (i < end) {
			sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
			j = i;
			i += 2;
		}
		return sum;
	}
}

private class EarNode {
	public final i:Int;
	public final x:Float;
	public final y:Float;
	public var prev:EarNode;
	public var next:EarNode;
	public var prevZ:EarNode;
	public var nextZ:EarNode;
	public var z:Int = 0;

	public function new(i:Int, x:Float, y:Float) {
		this.i = i;
		this.x = x;
		this.y = y;
	}
}

private class EarState {
	public var filteredOut = false;

	public function new() {}
}
