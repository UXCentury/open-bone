// Draw list: textured triangles in draw order, as the C API hands them out (ob_draw_item / ob_clip).
// SPDX-License-Identifier: MIT
import COpenBone

public enum OpenBoneTextAlign: Int, Equatable {
    case left = 0, center = 1, right = 2
}

/// Resolved text of a text attachment. The box (`width` × `height`) is centred on `matrix`'s origin.
public struct OpenBoneText: Equatable {
    public var content: String
    public var font: String
    public var size: Double
    public var weight: Double
    public var align: OpenBoneTextAlign
    public var width: Double
    public var height: Double
    public var fill: SIMD4<Float>
    public var outline: SIMD4<Float>?
    public var outlineWidth: Double
    /// Box centre → skeleton space.
    public var matrix: OpenBoneMatrix
}

/// Stroke of a shape attachment (the item's vertices are the outline).
public struct OpenBoneStroke: Equatable {
    public var color: SIMD4<Float>
    public var width: Double
}

/// A zero-copy view of one draw item. Its buffers point into the instance and are valid only inside the
/// `withDrawList` closure that produced it.
public struct OpenBoneDrawItemView {
    let raw: ob_draw_item

    public var slot: String { optionalString(raw.slot) ?? "" }
    public var attachment: String { optionalString(raw.attachment) ?? "" }
    public var kind: OpenBoneItemKind { OpenBoneItemKind(raw.kind) }
    public var blend: OpenBoneBlendMode { OpenBoneBlendMode(raw.blend) }
    /// Image or atlas page id, `"@openbone/particle-dot"`, or nil for untextured (solid colour) items.
    public var textureID: String? { optionalString(raw.texture_id) }
    public var textureSource: String? { optionalString(raw.texture_src) }
    public var textureSize: (width: Double, height: Double) { (raw.texture_width, raw.texture_height) }
    public var vertexCount: Int { Int(raw.vertex_count) }
    /// x, y pairs in skeleton space.
    public var vertices: UnsafeBufferPointer<Float> { UnsafeBufferPointer(start: raw.vertices, count: vertexCount * 2) }
    /// u, v pairs (0…1, v down).
    public var uvs: UnsafeBufferPointer<Float> {
        UnsafeBufferPointer(start: raw.uvs, count: raw.uvs == nil ? 0 : vertexCount * 2)
    }
    public var indices: UnsafeBufferPointer<UInt16> { UnsafeBufferPointer(start: raw.indices, count: Int(raw.index_count)) }
    /// Tint, straight alpha. Ignored when `colors` is set.
    public var color: SIMD4<Float> { SIMD4(raw.color.0, raw.color.1, raw.color.2, raw.color.3) }
    /// Dark tint (two-colour tint: rgb = dark + (color − dark) × texture.rgb), or nil for a plain multiply.
    public var dark: SIMD3<Float>? { raw.has_dark != 0 ? SIMD3(raw.dark.0, raw.dark.1, raw.dark.2) : nil }
    /// Per-vertex RGBA (particles), or nil.
    public var colors: UnsafeBufferPointer<Float>? {
        if raw.colors != nil { return UnsafeBufferPointer(start: raw.colors, count: vertexCount * 4) }
        return kind == .particles ? UnsafeBufferPointer(start: nil, count: 0) : nil
    }
    /// Index into the instance's clipping masks, or nil when not clipped.
    public var clip: Int? { raw.clip >= 0 ? Int(raw.clip) : nil }

    public var text: OpenBoneText? {
        guard let content = raw.text else { return nil }
        let m = raw.text_matrix
        return OpenBoneText(
            content: String(cString: content), font: optionalString(raw.font) ?? "", size: raw.font_size,
            weight: raw.font_weight, align: OpenBoneTextAlign(rawValue: Int(raw.text_align)) ?? .center,
            width: raw.text_width, height: raw.text_height,
            fill: SIMD4(raw.text_fill.0, raw.text_fill.1, raw.text_fill.2, raw.text_fill.3),
            outline: raw.has_outline != 0
                ? SIMD4(raw.text_outline.0, raw.text_outline.1, raw.text_outline.2, raw.text_outline.3) : nil,
            outlineWidth: raw.outline_width,
            matrix: OpenBoneMatrix(a: m.0, b: m.1, c: m.2, d: m.3, tx: m.4, ty: m.5))
    }

    public var stroke: OpenBoneStroke? {
        guard raw.has_stroke != 0 else { return nil }
        return OpenBoneStroke(color: SIMD4(raw.stroke_color.0, raw.stroke_color.1, raw.stroke_color.2, raw.stroke_color.3),
                              width: raw.stroke_width)
    }
}

/// A zero-copy view of a clipping mask (valid inside `withDrawList`).
public struct OpenBoneClipView {
    let raw: ob_clip
    public var slot: String { optionalString(raw.slot) ?? "" }
    /// x, y pairs in skeleton space.
    public var polygon: UnsafeBufferPointer<Float> { UnsafeBufferPointer(start: raw.polygon, count: Int(raw.vertex_count) * 2) }
    /// Triangulation of the polygon.
    public var indices: UnsafeBufferPointer<UInt16> { UnsafeBufferPointer(start: raw.indices, count: Int(raw.index_count)) }
}

/// The draw list of the current pose, borrowed from the instance (see `OpenBoneInstance.withDrawList`).
public struct OpenBoneDrawListView {
    let handle: OpaquePointer
    public let count: Int
    public let clipCount: Int

    public func item(_ index: Int) -> OpenBoneDrawItemView {
        var it = ob_draw_item()
        precondition(index >= 0 && index < count && ob_instance_draw_item(handle, Int32(index), &it) != 0,
                     "draw item index out of range")
        return OpenBoneDrawItemView(raw: it)
    }

    public func clip(_ index: Int) -> OpenBoneClipView {
        var c = ob_clip()
        precondition(index >= 0 && index < clipCount && ob_instance_clip(handle, Int32(index), &c) != 0,
                     "clip index out of range")
        return OpenBoneClipView(raw: c)
    }

    public var items: LazyMapSequence<Range<Int>, OpenBoneDrawItemView> { (0 ..< count).lazy.map { item($0) } }
}

/// One draw item, copied out of the instance (safe to keep).
public struct OpenBoneDrawItem: Equatable {
    public var slot: String
    public var attachment: String
    public var kind: OpenBoneItemKind
    public var blend: OpenBoneBlendMode
    public var textureID: String?
    public var textureSource: String?
    public var textureWidth: Double
    public var textureHeight: Double
    public var vertices: [Float]
    public var uvs: [Float]
    public var indices: [UInt16]
    public var color: SIMD4<Float>
    public var dark: SIMD3<Float>?
    public var colors: [Float]?
    public var clip: Int?
    public var text: OpenBoneText?
    public var stroke: OpenBoneStroke?

    public init(_ v: OpenBoneDrawItemView) {
        slot = v.slot
        attachment = v.attachment
        kind = v.kind
        blend = v.blend
        textureID = v.textureID
        textureSource = v.textureSource
        (textureWidth, textureHeight) = v.textureSize
        vertices = Array(v.vertices)
        uvs = Array(v.uvs)
        indices = Array(v.indices)
        color = v.color
        dark = v.dark
        colors = v.colors.map { Array($0) }
        clip = v.clip
        text = v.text
        stroke = v.stroke
    }
}

/// A clipping mask, copied.
public struct OpenBoneClip: Equatable {
    public var slot: String
    public var polygon: [Float]
    public var indices: [UInt16]

    public init(_ v: OpenBoneClipView) {
        slot = v.slot
        polygon = Array(v.polygon)
        indices = Array(v.indices)
    }
}

/// A copied draw list.
public struct OpenBoneDrawList: Equatable {
    public var items: [OpenBoneDrawItem]
    public var clips: [OpenBoneClip]
}
