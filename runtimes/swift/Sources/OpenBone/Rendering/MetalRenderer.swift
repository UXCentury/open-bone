// Metal renderer for the draw list: premultiplied-alpha pipeline, the four blend modes, two-colour tint, stencil
// clipping, atlas pages (straight or premultiplied), the particle sprite and CoreText-rasterised text.
// Apple platforms only. NOT run on Apple hardware by the package's own tests (they run on Linux); see README.
// SPDX-License-Identifier: MIT
#if canImport(Metal) && canImport(CoreGraphics) && canImport(ImageIO) && canImport(CoreText)
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Metal

private let shaderSource = """
#include <metal_stdlib>
using namespace metal;

struct Vertex { float2 pos; float2 uv; float4 color; float4 dark; };
struct Out { float4 position [[position]]; float2 uv; float4 color; float3 dark; };

vertex Out ob_vertex(const device Vertex* vertices [[buffer(0)]], constant float4& ndc [[buffer(1)]],
                     uint vid [[vertex_id]]) {
  Vertex v = vertices[vid];
  Out o;
  o.position = float4(v.pos * ndc.xy + ndc.zw, 0.0, 1.0);
  o.uv = v.uv;
  o.color = v.color;
  o.dark = v.dark.rgb;
  return o;
}

// Textures are premultiplied in memory. Two-colour tint in premultiplied form:
// straight rgb = dark + (light - dark) * tex.rgb / tex.a  →  premultiplied = (dark * tex.a + (light - dark) * tex.rgb) * light.a
fragment float4 ob_fragment(Out in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler smp [[sampler(0)]]) {
  float4 t = tex.sample(smp, in.uv);
  float a = t.a * in.color.a;
  float3 rgb = (in.dark * t.a + (in.color.rgb - in.dark) * t.rgb) * in.color.a;
  return float4(rgb, a);
}

fragment float4 ob_mask(Out in [[stage_in]]) { return float4(0.0); }
"""

/// Draws `OpenBoneRenderMesh`es with Metal. Create one per view (pixel formats) and keep it; textures are cached
/// per document.
public final class OpenBoneMetalRenderer {
    public let device: MTLDevice
    public let colorPixelFormat: MTLPixelFormat
    public let stencilPixelFormat: MTLPixelFormat
    /// Points → pixels for text rasterisation (the view's contents scale).
    public var contentsScale: Double = 2

    private let pipelines: [OpenBoneBlendMode: MTLRenderPipelineState]
    private let maskPipeline: MTLRenderPipelineState
    private let sampler: MTLSamplerState
    private let noClip: MTLDepthStencilState
    private let writeMask: MTLDepthStencilState
    private let testMask: MTLDepthStencilState
    private let white: MTLTexture
    private let dot: MTLTexture
    private var documentTextures: [String: MTLTexture] = [:]
    private var suppliedTextures: [String: MTLTexture] = [:]
    private var textTextures: [OpenBoneTextKey: MTLTexture] = [:]
    private weak var cachedDocument: OpenBoneDocument?
    private var vertexBuffer: MTLBuffer?
    private var indexBuffer: MTLBuffer?

    public init(device: MTLDevice, colorPixelFormat: MTLPixelFormat = .bgra8Unorm,
                stencilPixelFormat: MTLPixelFormat = .stencil8) throws {
        self.device = device
        self.colorPixelFormat = colorPixelFormat
        self.stencilPixelFormat = stencilPixelFormat
        let library = try device.makeLibrary(source: shaderSource, options: nil)
        let vfn = library.makeFunction(name: "ob_vertex"), ffn = library.makeFunction(name: "ob_fragment")
        var states: [OpenBoneBlendMode: MTLRenderPipelineState] = [:]
        for blend in OpenBoneBlendMode.allCases {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = vfn
            d.fragmentFunction = ffn
            d.stencilAttachmentPixelFormat = stencilPixelFormat
            let c = d.colorAttachments[0]!
            c.pixelFormat = colorPixelFormat
            c.isBlendingEnabled = true
            c.rgbBlendOperation = .add
            c.alphaBlendOperation = .add
            c.sourceAlphaBlendFactor = .one
            c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            switch blend { // premultiplied source
            case .normal:
                c.sourceRGBBlendFactor = .one
                c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            case .additive:
                c.sourceRGBBlendFactor = .one
                c.destinationRGBBlendFactor = .one
            case .multiply:
                c.sourceRGBBlendFactor = .destinationColor
                c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            case .screen:
                c.sourceRGBBlendFactor = .one
                c.destinationRGBBlendFactor = .oneMinusSourceColor
            }
            states[blend] = try device.makeRenderPipelineState(descriptor: d)
        }
        pipelines = states
        let m = MTLRenderPipelineDescriptor()
        m.vertexFunction = vfn
        m.fragmentFunction = library.makeFunction(name: "ob_mask")
        m.stencilAttachmentPixelFormat = stencilPixelFormat
        m.colorAttachments[0].pixelFormat = colorPixelFormat
        m.colorAttachments[0].writeMask = []
        maskPipeline = try device.makeRenderPipelineState(descriptor: m)

        let s = MTLSamplerDescriptor()
        s.minFilter = .linear
        s.magFilter = .linear
        s.sAddressMode = .clampToEdge
        s.tAddressMode = .clampToEdge
        guard let smp = device.makeSamplerState(descriptor: s) else { throw OpenBoneError("cannot create sampler") }
        sampler = smp

        func stencil(_ compare: MTLCompareFunction, _ pass: MTLStencilOperation) -> MTLDepthStencilState? {
            let st = MTLStencilDescriptor()
            st.stencilCompareFunction = compare
            st.depthStencilPassOperation = pass
            st.stencilFailureOperation = .keep
            st.depthFailureOperation = .keep
            let d = MTLDepthStencilDescriptor()
            d.frontFaceStencil = st
            d.backFaceStencil = st
            return device.makeDepthStencilState(descriptor: d)
        }
        guard let a = stencil(.always, .keep), let w = stencil(.always, .replace), let t = stencil(.equal, .keep) else {
            throw OpenBoneError("cannot create stencil states")
        }
        noClip = a
        writeMask = w
        testMask = t

        guard let wt = OpenBoneMetalRenderer.makeTexture(device, width: 1, height: 1, pixels: [255, 255, 255, 255]),
              let dt = OpenBoneMetalRenderer.makeTexture(device, width: 64, height: 64, pixels: openBoneParticleDotPixels(size: 64))
        else { throw OpenBoneError("cannot create built-in textures") }
        white = wt
        dot = dt
    }

    /// Forgets cached textures (call after memory warnings, or to reload a document's images).
    public func purgeTextures() {
        documentTextures.removeAll()
        textTextures.removeAll()
    }

    /// Supplies a texture for a document image / atlas page id yourself (premultiplied RGBA expected), e.g. from an
    /// asset catalogue. Overrides decoding the document's `src`.
    public func setTexture(_ texture: MTLTexture?, forID id: String) { suppliedTextures[id] = texture }

    /// Encodes `mesh` into `encoder` (whose render pass has a stencil attachment of `stencilPixelFormat`).
    public func encode(_ mesh: OpenBoneRenderMesh, document: OpenBoneDocument, viewport: OpenBoneViewport,
                       into encoder: MTLRenderCommandEncoder) {
        if cachedDocument !== document {
            documentTextures.removeAll()
            cachedDocument = document
        }
        guard !mesh.commands.isEmpty, mesh.vertexCount > 0 else { return }
        let vbytes = mesh.vertices.count * MemoryLayout<Float>.stride
        let ibytes = mesh.indices.count * MemoryLayout<UInt32>.stride
        // One shared buffer pair, grown as needed: the caller must not encode the next frame before the GPU has read
        // this one (OpenBoneView waits for its command buffer). A ring of buffers would allow frames in flight.
        if (vertexBuffer?.length ?? 0) < vbytes { vertexBuffer = device.makeBuffer(length: max(vbytes, 1 << 16), options: .storageModeShared) }
        if (indexBuffer?.length ?? 0) < ibytes { indexBuffer = device.makeBuffer(length: max(ibytes, 1 << 15), options: .storageModeShared) }
        guard let vb = vertexBuffer, let ib = indexBuffer else { return }
        mesh.vertices.withUnsafeBytes { vb.contents().copyMemory(from: $0.baseAddress!, byteCount: vbytes) }
        mesh.indices.withUnsafeBytes { ib.contents().copyMemory(from: $0.baseAddress!, byteCount: ibytes) }

        var ndc = viewport.ndcTransform
        encoder.setVertexBuffer(vb, offset: 0, index: 0)
        encoder.setVertexBytes(&ndc, length: MemoryLayout<SIMD4<Float>>.stride, index: 1)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.setCullMode(.none)
        encoder.setDepthStencilState(noClip)

        var activeClip: Int? = nil
        var stencilValue: UInt32 = 0
        var currentBlend: OpenBoneBlendMode? = nil
        for cmd in mesh.commands {
            if cmd.clip != activeClip {
                if let k = cmd.clip, k < mesh.clips.count {
                    // Each mask gets a fresh stencil value, so earlier masks need no clearing (the pass clears to 0;
                    // values wrap after 255 masks in one frame).
                    stencilValue = stencilValue % 255 + 1
                    let range = mesh.clips[k]
                    encoder.setRenderPipelineState(maskPipeline)
                    currentBlend = nil
                    encoder.setDepthStencilState(writeMask)
                    encoder.setStencilReferenceValue(stencilValue)
                    encoder.setFragmentTexture(white, index: 0)
                    encoder.drawIndexedPrimitives(type: .triangle, indexCount: range.indexCount, indexType: .uint32,
                                                  indexBuffer: ib, indexBufferOffset: range.indexStart * 4)
                    encoder.setDepthStencilState(testMask)
                } else {
                    encoder.setDepthStencilState(noClip)
                }
                activeClip = cmd.clip
            }
            if currentBlend != cmd.blend, let p = pipelines[cmd.blend] {
                encoder.setRenderPipelineState(p)
                currentBlend = cmd.blend
            }
            encoder.setFragmentTexture(texture(for: cmd.texture, document: document, viewport: viewport), index: 0)
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: cmd.indexCount, indexType: .uint32,
                                          indexBuffer: ib, indexBufferOffset: cmd.indexStart * 4)
        }
    }

    private func texture(for key: OpenBoneTextureKey, document: OpenBoneDocument, viewport: OpenBoneViewport) -> MTLTexture {
        switch key {
        case .white: return white
        case .particleDot: return dot
        case let .document(id):
            if let t = suppliedTextures[id] ?? documentTextures[id] { return t }
            let info = document.textures.first { $0.id == id }
            let t = info.flatMap { i in
                document.textureData(for: i.source).flatMap {
                    OpenBoneMetalRenderer.decode($0, premultiplied: i.isAtlasPage && i.premultipliedAlpha, device: device)
                }
            } ?? white
            documentTextures[id] = t // also caches failures (as white) so a missing file is not re-read every frame
            return t
        case let .text(k):
            if let t = textTextures[k] { return t }
            if textTextures.count > 128 { textTextures.removeAll() }
            let scale = max(1, min(4, contentsScale * max(viewport.scaleX, viewport.scaleY)))
            let t = OpenBoneMetalRenderer.rasterize(k, scale: scale, device: device) ?? white
            textTextures[k] = t
            return t
        }
    }

    static func makeTexture(_ device: MTLDevice, width: Int, height: Int, pixels: [UInt8]) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { return nil }
        pixels.withUnsafeBytes {
            t.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: $0.baseAddress!,
                      bytesPerRow: width * 4)
        }
        return t
    }

    /// Decodes PNG / JPEG / WebP… bytes into a premultiplied RGBA8 texture. `premultiplied`: the image's colour
    /// values are already multiplied by alpha (premultiplied atlas pages); CoreGraphics premultiplies again while
    /// drawing, so that is undone once.
    static func decode(_ data: Data, premultiplied: Bool, device: MTLDevice) -> MTLTexture? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let w = image.width, h = image.height
        guard w > 0, h > 0 else { return nil }
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let drawn: Bool = px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
            else { return false }
            ctx.setBlendMode(.copy)
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        if premultiplied {
            for i in stride(from: 0, to: px.count, by: 4) {
                let a = Int(px[i + 3])
                guard a > 0, a < 255 else { continue }
                for k in 0 ..< 3 { px[i + k] = UInt8(min(255, (Int(px[i + k]) * 255 + a / 2) / a)) }
            }
        }
        return makeTexture(device, width: w, height: h, pixels: px)
    }

    /// Rasterises a text box (fill and outline, alignment, wrapping) into a premultiplied texture.
    static func rasterize(_ k: OpenBoneTextKey, scale: Double, device: MTLDevice) -> MTLTexture? {
        let w = max(1, Int((k.width * scale).rounded(.up))), h = max(1, Int((k.height * scale).rounded(.up)))
        guard w <= 8192, h <= 8192 else { return nil }
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
            else { return false }
            ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
            let size = CGFloat(max(1, k.size))
            let family = k.font.split(separator: ",").first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) } ?? ""
            var traits: [CFString: Any] = [kCTFontWeightTrait: CGFloat((k.weight - 400) / 500)]
            if k.weight >= 600 { traits[kCTFontSymbolicTrait] = CTFontSymbolicTraits.traitBold.rawValue }
            var attrs: [CFString: Any] = [kCTFontTraitsAttribute: traits]
            if !family.isEmpty, !["sans-serif", "serif", "system-ui", "monospace"].contains(family.lowercased()) {
                attrs[kCTFontFamilyNameAttribute] = family
            }
            let font = CTFontCreateWithFontDescriptor(CTFontDescriptorCreateWithAttributes(attrs as CFDictionary), size, nil)
            var alignment: CTTextAlignment = k.align == 0 ? .left : k.align == 2 ? .right : .center
            let paragraph = withUnsafeMutablePointer(to: &alignment) { p -> CTParagraphStyle in
                var setting = CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: p)
                return CTParagraphStyleCreate(&setting, 1)
            }
            func cg(_ c: [Float]) -> CGColor {
                CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: c.map { CGFloat($0) })
                    ?? CGColor(gray: 1, alpha: 1)
            }
            var stringAttrs: [CFString: Any] = [
                kCTFontAttributeName: font, kCTForegroundColorAttributeName: cg(k.fill), kCTParagraphStyleAttributeName: paragraph,
            ]
            if let o = k.outline, k.outlineWidth > 0 {
                stringAttrs[kCTStrokeColorAttributeName] = cg(o)
                // Negative = fill and stroke; the width is a percentage of the font size.
                stringAttrs[kCTStrokeWidthAttributeName] = -k.outlineWidth / Double(size) * 100
            }
            guard let attributed = CFAttributedStringCreate(nil, k.content as CFString, stringAttrs as CFDictionary) else { return false }
            let setter = CTFramesetterCreateWithAttributedString(attributed)
            let box = CGSize(width: k.width, height: k.height)
            let fit = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil,
                                                                   CGSize(width: box.width, height: .greatestFiniteMagnitude), nil)
            // Vertically centred in the box (CoreGraphics is y up: origin bottom-left).
            let top = (box.height + fit.height) / 2
            let rect = CGRect(x: 0, y: top - fit.height - 1, width: box.width, height: fit.height + 2)
            let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
            CTFrameDraw(frame, ctx)
            return true
        }
        return ok ? makeTexture(device, width: w, height: h, pixels: px) : nil
    }
}
#endif
