// OpenBoneSkeletonBounds: bounding-box queries (ob_bounds, docs/runtime-spec.md §8.10), like Spine's SkeletonBounds.
// SPDX-License-Identifier: MIT
import COpenBone

/// One active bounding box: the world polygon of a slot's current bounding-box attachment.
public struct OpenBoneBoundingBox: Equatable {
    /// Position in `OpenBoneSkeletonBounds.boxes` (draw order).
    public let index: Int
    public let slot: String
    public let attachment: String
    /// World x,y pairs (skeleton space, y up: the draw list's coordinates).
    public let vertices: [Float]
    /// The polygon's own axis-aligned bounds.
    public let bounds: OpenBoneRect
}

/// The active bounding boxes of an instance for one pose: every slot, in draw order, whose bone is active and whose
/// current attachment is a bounding box. A snapshot: call `update(_:)` (or `instance.boundingBoxes()` again) after
/// the pose changes. All coordinates are skeleton space. With no box, `aabb` is nil and every query returns nothing.
public final class OpenBoneSkeletonBounds {
    let handle: OpaquePointer

    /// The boxes of the last `update`, in draw order.
    public private(set) var boxes: [OpenBoneBoundingBox] = []

    public init() {
        handle = ob_bounds_create()!
    }

    public convenience init(_ instance: OpenBoneInstance) {
        self.init()
        update(instance)
    }

    deinit { ob_bounds_free(handle) }

    /// Recompute the polygons from the instance's current pose.
    @discardableResult
    public func update(_ instance: OpenBoneInstance) -> OpenBoneSkeletonBounds {
        let n = Int(ob_bounds_update(handle, instance.handle))
        boxes = (0 ..< n).compactMap { i in
            var b = ob_bounding_box()
            guard ob_bounds_box(handle, Int32(i), &b) != 0 else { return nil }
            let count = Int(b.vertex_count) * 2
            let vertices = b.vertices.map { Array(UnsafeBufferPointer(start: $0, count: count)) } ?? []
            return OpenBoneBoundingBox(index: i, slot: optionalString(b.slot) ?? "",
                                       attachment: optionalString(b.attachment) ?? "", vertices: vertices,
                                       bounds: OpenBoneRect(minX: b.min_x, minY: b.min_y, maxX: b.max_x, maxY: b.max_y))
        }
        return self
    }

    /// Overall axis-aligned bounds of every box, or nil when there is none.
    public var aabb: OpenBoneRect? {
        var b = [Double](repeating: 0, count: 4)
        let any = b.withUnsafeMutableBufferPointer { ob_bounds_aabb(handle, $0.baseAddress) }
        return any != 0 ? OpenBoneRect(minX: b[0], minY: b[1], maxX: b[2], maxY: b[3]) : nil
    }

    /// True if the point is inside the overall AABB (edges included).
    public func aabbContainsPoint(x: Double, y: Double) -> Bool {
        ob_bounds_aabb_contains_point(handle, x, y) != 0
    }

    /// True if the overall AABB overlaps the rectangle (edges included).
    public func aabbIntersects(_ r: OpenBoneRect) -> Bool {
        ob_bounds_aabb_intersects(handle, r.minX, r.minY, r.maxX, r.maxY) != 0
    }

    /// The first box (draw order) containing the point, or nil. The last match is the one drawn on top.
    public func containsPoint(x: Double, y: Double) -> OpenBoneBoundingBox? {
        box(ob_bounds_contains_point(handle, x, y))
    }

    /// Every box containing the point, in draw order.
    public func containsPointAll(x: Double, y: Double) -> [OpenBoneBoundingBox] {
        collect { ob_bounds_contains_point_all(handle, x, y, $0, $1) }
    }

    /// The first box the segment touches (crosses an edge or starts inside), or nil.
    public func intersectsSegment(x1: Double, y1: Double, x2: Double, y2: Double) -> OpenBoneBoundingBox? {
        box(ob_bounds_intersects_segment(handle, x1, y1, x2, y2))
    }

    /// Every box the segment touches, in draw order.
    public func intersectsSegmentAll(x1: Double, y1: Double, x2: Double, y2: Double) -> [OpenBoneBoundingBox] {
        collect { ob_bounds_intersects_segment_all(handle, x1, y1, x2, y2, $0, $1) }
    }

    /// The first overlapping pair between these boxes and another snapshot's (mine in draw order, then theirs), or nil.
    public func intersectsBounds(_ other: OpenBoneSkeletonBounds) -> (mine: OpenBoneBoundingBox, theirs: OpenBoneBoundingBox)? {
        var mine: Int32 = -1, theirs: Int32 = -1
        guard ob_bounds_intersects_bounds(handle, other.handle, &mine, &theirs) != 0,
              let a = box(mine), let b = other.box(theirs) else { return nil }
        return (a, b)
    }

    private func box(_ i: Int32) -> OpenBoneBoundingBox? {
        i >= 0 && Int(i) < boxes.count ? boxes[Int(i)] : nil
    }

    private func collect(_ query: (UnsafeMutablePointer<Int32>?, Int32) -> Int32) -> [OpenBoneBoundingBox] {
        guard !boxes.isEmpty else { return [] }
        var out = [Int32](repeating: 0, count: boxes.count)
        let n = out.withUnsafeMutableBufferPointer { query($0.baseAddress, Int32($0.count)) }
        return out.prefix(Int(n)).compactMap { box($0) }
    }
}

public extension OpenBoneInstance {
    /// The active bounding boxes in the current pose (world polygons, their AABB, point / segment / AABB / skeleton
    /// overlap queries). A snapshot: take a new one, or call `update(_:)` on it, after the pose changes.
    func boundingBoxes() -> OpenBoneSkeletonBounds { OpenBoneSkeletonBounds(self) }
}
