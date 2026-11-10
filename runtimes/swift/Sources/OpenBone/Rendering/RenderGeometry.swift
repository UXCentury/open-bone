// Platform-neutral half of the renderer: framing (skeleton ↔ view coordinates) and turning a draw list into one
// vertex / index buffer plus batched draw commands. The Metal renderer uploads exactly this; it is plain Swift, so it
// is unit-tested on every platform.
// SPDX-License-Identifier: MIT
import Foundation

/// How a skeleton-space rectangle is placed into a view (view space: points, origin top-left, y down).
public struct OpenBoneViewport: Equatable {
    public enum Fit: Equatable {
        /// Whole content visible, aspect kept (letterboxed).
        case contain
        /// View filled, aspect kept (content cropped).
        case cover
        /// Stretched to the view.
        case fill
        /// Fixed scale (view points per document pixel), centred.
        case scale(Double)
    }

    /// View points per skeleton unit, horizontally and vertically.
    public var scaleX: Double
    public var scaleY: Double
    /// View position of skeleton (0, 0).
    public var originX: Double
    public var originY: Double
    /// View size in points.
    public var width: Double
    public var height: Double

    public init(scaleX: Double, scaleY: Double, originX: Double, originY: Double, width: Double, height: Double) {
        self.scaleX = scaleX
        self.scaleY = scaleY
        self.originX = originX
        self.originY = originY
        self.width = width
        self.height = height
    }

    /// Places `content` (skeleton space) centred in a `width` × `height` view.
    public init(content: OpenBoneRect, width: Double, height: Double, fit: Fit = .contain) {
        let cw = max(content.width, 1e-9), ch = max(content.height, 1e-9)
        var sx = width / cw, sy = height / ch
        switch fit {
        case .contain: sx = min(sx, sy); sy = sx
        case .cover: sx = max(sx, sy); sy = sx
        case .fill: break
        case let .scale(s): sx = s; sy = s
        }
        let cx = (content.minX + content.maxX) / 2, cy = (content.minY + content.maxY) / 2
        self.init(scaleX: sx, scaleY: sy, originX: width / 2 - cx * sx, originY: height / 2 + cy * sy,
                  width: width, height: height)
    }

    /// Skeleton space (y up) → view space (y down).
    public func toView(_ p: OpenBonePoint) -> OpenBonePoint {
        OpenBonePoint(x: originX + p.x * scaleX, y: originY - p.y * scaleY)
    }

    /// View space (y down) → skeleton space (y up), e.g. for pointer events.
    public func toSkeleton(_ p: OpenBonePoint) -> OpenBonePoint {
        OpenBonePoint(x: (p.x - originX) / scaleX, y: (originY - p.y) / scaleY)
    }

    /// Skeleton → normalised device coordinates as `ndc = pos * (x, y) + (z, w)` (Metal / GL clip space, y up).
    public var ndcTransform: SIMD4<Float> {
        let w = max(width, 1e-9), h = max(height, 1e-9)
        return SIMD4(Float(2 * scaleX / w), Float(2 * scaleY / h), Float(2 * originX / w - 1), Float(1 - 2 * originY / h))
    }
}

/// What a batch samples.
public enum OpenBoneTextureKey: Hashable {
    /// No texture: solid colour (shapes, strokes).
    case white
    /// A document image or atlas page, by id (`OpenBoneDocument.textures`).
    case document(String)
    /// The built-in soft particle sprite.
    case particleDot
    /// Rasterised text (the renderer draws `OpenBoneText` into a texture).
    case text(OpenBoneTextKey)
}

/// Everything that changes how a text texture looks (not where it is drawn).
public struct OpenBoneTextKey: Hashable {
    public var content: String
    public var font: String
    public var size: Double
    public var weight: Double
    public var align: Int
    public var width: Double
    public var height: Double
    public var fill: [Float]
    public var outline: [Float]?
    public var outlineWidth: Double

    public init(_ t: OpenBoneText) {
        content = t.content
        font = t.font
        size = t.size
        weight = t.weight
        align = t.align.rawValue
        width = t.width
        height = t.height
        fill = [t.fill.x, t.fill.y, t.fill.z, t.fill.w]
        outline = t.outline.map { [$0.x, $0.y, $0.z, $0.w] }
        outlineWidth = t.outlineWidth
    }
}

/// One draw call: a range of `OpenBoneRenderMesh.indices` with one texture, blend mode and clip mask.
public struct OpenBoneDrawCommand: Equatable {
    public var texture: OpenBoneTextureKey
    public var blend: OpenBoneBlendMode
    /// Index into `OpenBoneRenderMesh.clips`, or nil.
    public var clip: Int?
    public var indexStart: Int
    public var indexCount: Int
}

/// A clipping mask's triangles, as a range of `OpenBoneRenderMesh.indices` (vertices carry no colour).
public struct OpenBoneClipRange: Equatable {
    public var indexStart: Int
    public var indexCount: Int
}

/// A whole frame as GPU-ready buffers. Vertex layout (12 floats, 48 bytes):
/// `x, y, u, v, r, g, b, a, darkR, darkG, darkB, 0` — colour straight alpha, dark (0, 0, 0) = plain multiply.
public struct OpenBoneRenderMesh {
    public static let floatsPerVertex = 12

    public private(set) var vertices: [Float] = []
    public private(set) var indices: [UInt32] = []
    public private(set) var commands: [OpenBoneDrawCommand] = []
    public private(set) var clips: [OpenBoneClipRange] = []

    public init() {}

    public var vertexCount: Int { vertices.count / OpenBoneRenderMesh.floatsPerVertex }

    public mutating func removeAll() {
        vertices.removeAll(keepingCapacity: true)
        indices.removeAll(keepingCapacity: true)
        commands.removeAll(keepingCapacity: true)
        clips.removeAll(keepingCapacity: true)
    }

    /// Rebuilds the mesh from an instance's current pose.
    public mutating func build(from instance: OpenBoneInstance) {
        instance.withDrawList { build(from: $0) }
    }

    /// Rebuilds the mesh from a draw list view.
    public mutating func build(from list: OpenBoneDrawListView) {
        removeAll()
        for c in 0 ..< list.clipCount {
            let clip = list.clip(c)
            let base = UInt32(vertexCount)
            let p = clip.polygon
            for i in 0 ..< p.count / 2 { appendVertex(p[i * 2], p[i * 2 + 1], 0, 0, SIMD4(1, 1, 1, 1), SIMD3(0, 0, 0)) }
            let start = indices.count
            for i in clip.indices { indices.append(base + UInt32(i)) }
            clips.append(OpenBoneClipRange(indexStart: start, indexCount: indices.count - start))
        }
        for item in list.items { append(item) }
    }

    mutating func appendVertex(_ x: Float, _ y: Float, _ u: Float, _ v: Float, _ c: SIMD4<Float>, _ d: SIMD3<Float>) {
        vertices.append(contentsOf: [x, y, u, v, c.x, c.y, c.z, c.w, d.x, d.y, d.z, 0])
    }

    /// Adds triangles to the current command, starting a new one when texture, blend or clip change.
    mutating func emit(_ texture: OpenBoneTextureKey, _ blend: OpenBoneBlendMode, _ clip: Int?, _ start: Int) {
        let count = indices.count - start
        guard count > 0 else { return }
        if var last = commands.last, last.texture == texture, last.blend == blend, last.clip == clip,
           last.indexStart + last.indexCount == start {
            last.indexCount += count
            commands[commands.count - 1] = last
        } else {
            commands.append(OpenBoneDrawCommand(texture: texture, blend: blend, clip: clip, indexStart: start, indexCount: count))
        }
    }

    mutating func append(_ item: OpenBoneDrawItemView) {
        let dark = item.dark ?? SIMD3(0, 0, 0)
        if item.kind == .text, let text = item.text {
            appendText(text, color: item.color, dark: dark, blend: item.blend, clip: item.clip)
            return
        }
        let texture: OpenBoneTextureKey
        switch item.textureID {
        case nil: texture = .white
        case "@openbone/particle-dot"?: texture = .particleDot
        case let id?: texture = .document(id)
        }
        let v = item.vertices, uv = item.uvs, colors = item.colors
        let n = item.vertexCount
        let base = UInt32(vertexCount)
        for i in 0 ..< n {
            let u: Float = uv.count >= (i + 1) * 2 ? uv[i * 2] : 0
            let w: Float = uv.count >= (i + 1) * 2 ? uv[i * 2 + 1] : 0
            var c = item.color
            if let cs = colors, cs.count >= (i + 1) * 4 { c = SIMD4(cs[i * 4], cs[i * 4 + 1], cs[i * 4 + 2], cs[i * 4 + 3]) }
            appendVertex(v[i * 2], v[i * 2 + 1], u, w, c, dark)
        }
        let start = indices.count
        for i in item.indices where Int(i) < n { indices.append(base + UInt32(i)) }
        emit(texture, item.blend, item.clip, start)
        if let stroke = item.stroke, stroke.width > 0, n >= 2 {
            appendStroke(v, count: n, stroke: stroke, tint: item.color, blend: item.blend, clip: item.clip)
        }
    }

    /// A closed outline as one quad per edge (miter-free; joins overlap).
    mutating func appendStroke(_ v: UnsafeBufferPointer<Float>, count n: Int, stroke: OpenBoneStroke, tint: SIMD4<Float>,
                               blend: OpenBoneBlendMode, clip: Int?) {
        let half = Float(stroke.width / 2)
        let color = stroke.color * SIMD4(1, 1, 1, tint.w)
        let start = indices.count
        for i in 0 ..< n {
            let j = (i + 1) % n
            let ax = v[i * 2], ay = v[i * 2 + 1], bx = v[j * 2], by = v[j * 2 + 1]
            let dx = bx - ax, dy = by - ay
            let len = (dx * dx + dy * dy).squareRoot()
            guard len > 0 else { continue }
            let nx = -dy / len * half, ny = dx / len * half
            let ex = dx / len * half, ey = dy / len * half // extend each edge by half the width to cover the joins
            let base = UInt32(vertexCount)
            appendVertex(ax - ex + nx, ay - ey + ny, 0, 0, color, SIMD3(0, 0, 0))
            appendVertex(bx + ex + nx, by + ey + ny, 0, 0, color, SIMD3(0, 0, 0))
            appendVertex(bx + ex - nx, by + ey - ny, 0, 0, color, SIMD3(0, 0, 0))
            appendVertex(ax - ex - nx, ay - ey - ny, 0, 0, color, SIMD3(0, 0, 0))
            indices.append(contentsOf: [base, base + 1, base + 2, base, base + 2, base + 3])
        }
        emit(.white, blend, clip, start)
    }

    /// A text box as a textured quad; the texture (fill and outline baked in) is tinted by the item colour.
    mutating func appendText(_ t: OpenBoneText, color: SIMD4<Float>, dark: SIMD3<Float>, blend: OpenBoneBlendMode, clip: Int?) {
        guard t.width > 0, t.height > 0, !t.content.isEmpty else { return }
        let hw = t.width / 2, hh = t.height / 2
        // Box space is y down (as in the TypeScript renderer); the text matrix maps (x, −y) to skeleton space.
        let corners: [(Double, Double, Float, Float)] = [(-hw, -hh, 0, 0), (hw, -hh, 1, 0), (hw, hh, 1, 1), (-hw, hh, 0, 1)]
        let base = UInt32(vertexCount)
        for (bx, by, u, v) in corners {
            let p = t.matrix.apply(OpenBonePoint(x: bx, y: -by))
            appendVertex(Float(p.x), Float(p.y), u, v, color, dark)
        }
        let start = indices.count
        indices.append(contentsOf: [base, base + 1, base + 2, base, base + 2, base + 3])
        emit(.text(OpenBoneTextKey(t)), blend, clip, start)
    }
}

/// Alpha of the built-in particle sprite at distance `r` from its centre (0 centre … 1 edge), as the runtimes use.
public func openBoneParticleDotAlpha(_ r: Double) -> Double {
    let base = r >= 1 ? 0 : r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65
    return Foundation.pow(base, 1.6)
}

/// RGBA8 pixels (premultiplied = straight here, the sprite is white) of the particle sprite, `size` × `size`.
public func openBoneParticleDotPixels(size: Int = 64) -> [UInt8] {
    var px = [UInt8](repeating: 0, count: size * size * 4)
    for y in 0 ..< size {
        for x in 0 ..< size {
            let dx = (Double(x) + 0.5) / Double(size) * 2 - 1, dy = (Double(y) + 0.5) / Double(size) * 2 - 1
            let a = UInt8((openBoneParticleDotAlpha((dx * dx + dy * dy).squareRoot()) * 255).rounded())
            let o = (y * size + x) * 4
            // Premultiplied white: rgb = alpha.
            px[o] = a
            px[o + 1] = a
            px[o + 2] = a
            px[o + 3] = a
        }
    }
    return px
}
