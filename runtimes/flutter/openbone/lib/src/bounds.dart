// OpenBoneSkeletonBounds: bounding-box queries (ob_bounds, docs/runtime-spec.md §8.10), like Spine's SkeletonBounds.
// SPDX-License-Identifier: MIT
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'bindings.g.dart';
import 'instance.dart';
import 'native.dart';

/// One active bounding box: the world polygon of a slot's current bounding-box attachment.
class OpenBoneBoundingBox {
  const OpenBoneBoundingBox({
    required this.index,
    required this.slot,
    required this.attachment,
    required this.vertices,
    required this.minX,
    required this.minY,
    required this.maxX,
    required this.maxY,
  });

  /// Position in [OpenBoneSkeletonBounds.boxes] (draw order).
  final int index;
  final String slot;
  final String attachment;

  /// World x,y pairs (skeleton space, y up: the draw list's coordinates).
  final Float32List vertices;

  /// The polygon's own axis-aligned bounds.
  final double minX, minY, maxX, maxY;

  @override
  String toString() => 'OpenBoneBoundingBox($index, $slot/$attachment)';
}

/// The active bounding boxes of an instance for one pose: every slot, in draw order, whose bone is active and whose
/// current attachment is a bounding box. A snapshot: call [update] (or [OpenBoneInstance.boundingBoxes] again) after
/// the pose changes. All coordinates are skeleton space. With no box, [aabb] is null and every query returns nothing.
///
/// Native memory is released by [dispose], or by a finalizer when the object is garbage collected.
class OpenBoneSkeletonBounds implements Finalizable {
  OpenBoneSkeletonBounds([OpenBoneInstance? instance]) : _ptr = OpenBoneNative.bindings.ob_bounds_create() {
    _finalizer.attach(this, _ptr.cast(), detach: this, externalSize: 4096);
    if (instance != null) update(instance);
  }

  static final NativeFinalizer _finalizer =
      NativeFinalizer(OpenBoneNative.library.lookup<NativeFinalizerFunction>('ob_bounds_free'));

  static OpenBoneBindings get _b => OpenBoneNative.bindings;

  Pointer<ob_bounds> _ptr;
  List<OpenBoneBoundingBox> _boxes = const [];

  /// The boxes of the last [update], in draw order.
  List<OpenBoneBoundingBox> get boxes => _boxes;

  bool get isDisposed => _ptr == nullptr;

  Pointer<ob_bounds> get _handle {
    if (_ptr == nullptr) throw StateError('OpenBoneSkeletonBounds was disposed');
    return _ptr;
  }

  /// Recomputes the polygons from the instance's current pose.
  OpenBoneSkeletonBounds update(OpenBoneInstance instance) => using((arena) {
        final h = _handle;
        final n = _b.ob_bounds_update(h, instance.handle);
        final box = arena<ob_bounding_box>();
        _boxes = List.unmodifiable([
          for (var i = 0; i < n; i++)
            if (_b.ob_bounds_box(h, i, box) != 0)
              OpenBoneBoundingBox(
                index: i,
                slot: box.ref.slot.dart,
                attachment: box.ref.attachment.dart,
                vertices: box.ref.vertex_count > 0 && box.ref.vertices != nullptr
                    ? Float32List.fromList(box.ref.vertices.asTypedList(box.ref.vertex_count * 2))
                    : Float32List(0),
                minX: box.ref.min_x,
                minY: box.ref.min_y,
                maxX: box.ref.max_x,
                maxY: box.ref.max_y,
              ),
        ]);
        return this;
      });

  /// Overall (minX, minY, maxX, maxY) of every box, or null when there is none.
  (double, double, double, double)? get aabb => using((arena) {
        final out = arena<Double>(4);
        return _b.ob_bounds_aabb(_handle, out) != 0 ? (out[0], out[1], out[2], out[3]) : null;
      });

  /// True if the point is inside the overall AABB (edges included).
  bool aabbContainsPoint(double x, double y) => _b.ob_bounds_aabb_contains_point(_handle, x, y) != 0;

  /// True if the overall AABB overlaps the rectangle (edges included).
  bool aabbIntersects(double minX, double minY, double maxX, double maxY) =>
      _b.ob_bounds_aabb_intersects(_handle, minX, minY, maxX, maxY) != 0;

  /// The first box (draw order) containing the point, or null. The last match is the one drawn on top.
  OpenBoneBoundingBox? containsPoint(double x, double y) => _box(_b.ob_bounds_contains_point(_handle, x, y));

  /// Every box containing the point, in draw order.
  List<OpenBoneBoundingBox> containsPointAll(double x, double y) =>
      _collect((out, cap) => _b.ob_bounds_contains_point_all(_handle, x, y, out, cap));

  /// The first box the segment touches (crosses an edge or starts inside), or null.
  OpenBoneBoundingBox? intersectsSegment(double x1, double y1, double x2, double y2) =>
      _box(_b.ob_bounds_intersects_segment(_handle, x1, y1, x2, y2));

  /// Every box the segment touches, in draw order.
  List<OpenBoneBoundingBox> intersectsSegmentAll(double x1, double y1, double x2, double y2) =>
      _collect((out, cap) => _b.ob_bounds_intersects_segment_all(_handle, x1, y1, x2, y2, out, cap));

  /// The first overlapping pair between these boxes and another snapshot's (mine in draw order, then theirs), or
  /// null.
  (OpenBoneBoundingBox mine, OpenBoneBoundingBox theirs)? intersectsBounds(OpenBoneSkeletonBounds other) =>
      using((arena) {
        final mine = arena<Int>(), theirs = arena<Int>();
        if (_b.ob_bounds_intersects_bounds(_handle, other._handle, mine, theirs) == 0) return null;
        final a = _box(mine.value), b = other._box(theirs.value);
        return a != null && b != null ? (a, b) : null;
      });

  /// Releases the native snapshot (the copied [boxes] stay readable).
  void dispose() {
    if (_ptr == nullptr) return;
    _finalizer.detach(this);
    _b.ob_bounds_free(_ptr);
    _ptr = nullptr;
  }

  OpenBoneBoundingBox? _box(int i) => i >= 0 && i < _boxes.length ? _boxes[i] : null;

  List<OpenBoneBoundingBox> _collect(int Function(Pointer<Int> out, int capacity) query) {
    if (_boxes.isEmpty) return const [];
    return using((arena) {
      final out = arena<Int>(_boxes.length);
      final n = query(out, _boxes.length);
      return [for (var k = 0; k < n && k < _boxes.length; k++) ?_box(out[k])];
    });
  }
}
