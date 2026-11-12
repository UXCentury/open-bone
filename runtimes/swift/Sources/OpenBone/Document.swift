// OpenBoneDocument: an immutable, loaded .obone / .obonb document (ob_document).
// SPDX-License-Identifier: MIT
import COpenBone
import Foundation

/// A loaded document. Immutable and shareable by many `OpenBoneInstance`s (each keeps its document alive).
public final class OpenBoneDocument {
    let handle: OpaquePointer
    /// Directory that relative texture / sound paths resolve against (the file's folder when loaded from a URL).
    public let baseURL: URL?

    /// Loads a `.obone` (JSON) or `.obonb` (binary) file.
    public convenience init(contentsOf url: URL) throws {
        guard url.isFileURL else {
            try self.init(data: try Data(contentsOf: url), baseURL: url.deletingLastPathComponent())
            return
        }
        guard let h = url.path.withCString({ ob_document_load_file($0) }) else {
            throw OpenBoneError.last("cannot load \(url.path)")
        }
        self.init(handle: h, baseURL: url.deletingLastPathComponent())
    }

    /// Loads `.obone` JSON or `.obonb` binary bytes (copied).
    public convenience init(data: Data, baseURL: URL? = nil) throws {
        let h: OpaquePointer? = data.withUnsafeBytes { raw in
            // ob_document_load_memory rejects NULL; give an empty buffer a valid pointer so the error says why.
            guard let base = raw.baseAddress else {
                var zero: UInt8 = 0
                return ob_document_load_memory(&zero, 0)
            }
            return ob_document_load_memory(base, raw.count)
        }
        guard let h else { throw OpenBoneError.last("cannot load document") }
        self.init(handle: h, baseURL: baseURL)
    }

    private init(handle: OpaquePointer, baseURL: URL?) {
        self.handle = handle
        self.baseURL = baseURL
    }

    deinit { ob_document_free(handle) }

    /// The artboard: size in document pixels and the skeleton origin inside it (artboard is y down, top-left).
    public struct Artboard: Equatable {
        public var width, height, originX, originY: Double
        /// The artboard rectangle in skeleton space (y up).
        public var skeletonRect: OpenBoneRect {
            OpenBoneRect(minX: -originX, minY: originY - height, maxX: width - originX, maxY: originY)
        }
    }

    public var artboard: Artboard {
        var a = Artboard(width: 0, height: 0, originX: 0, originY: 0)
        ob_document_size(handle, &a.width, &a.height, &a.originX, &a.originY)
        return a
    }

    /// Artboard coordinates (y down, origin top-left) → skeleton space (y up).
    public func artboardToSkeleton(x: Double, y: Double) -> OpenBonePoint {
        var p = OpenBonePoint(x: 0, y: 0)
        ob_artboard_to_skeleton(handle, x, y, &p.x, &p.y)
        return p
    }

    public struct Animation: Equatable {
        public var name: String
        /// Seconds.
        public var duration: Double
    }

    public var animations: [Animation] {
        (0 ..< Int(ob_document_animation_count(handle))).map { i in
            Animation(name: optionalString(ob_document_animation_name(handle, Int32(i))) ?? "",
                      duration: ob_document_animation_duration(handle, Int32(i)))
        }
    }

    public var skins: [String] {
        (0 ..< Int(ob_document_skin_count(handle))).map { optionalString(ob_document_skin_name(handle, Int32($0))) ?? "" }
    }

    public struct Input: Equatable {
        public var name: String
        public var isTrigger: Bool
        /// Default value (`.bool(false)` for triggers).
        public var defaultValue: OpenBoneValue?
    }

    public struct StateMachine: Equatable {
        public var name: String
        public var inputs: [Input]
    }

    public var stateMachines: [StateMachine] {
        (0 ..< Int(ob_document_state_machine_count(handle))).map { sm in
            let inputs = (0 ..< Int(ob_document_input_count(handle, Int32(sm)))).compactMap { i -> Input? in
                var name: UnsafePointer<CChar>?
                var def = ob_value()
                var trigger: Int32 = 0
                guard ob_document_input(handle, Int32(sm), Int32(i), &name, &def, &trigger) != 0 else { return nil }
                return Input(name: optionalString(name) ?? "", isTrigger: trigger != 0, defaultValue: OpenBoneValue(def))
            }
            return StateMachine(name: optionalString(ob_document_state_machine_name(handle, Int32(sm))) ?? "", inputs: inputs)
        }
    }

    /// A texture a renderer may need: an atlas page or an image asset.
    public struct Texture: Equatable {
        public var id: String
        public var name: String
        /// A `data:` URL or a path relative to the document.
        public var source: String
        public var width, height: Double
        public var isAtlasPage: Bool
        /// Atlas pages packed with premultiplied alpha.
        public var premultipliedAlpha: Bool
    }

    /// Atlas pages first, then images.
    public var textures: [Texture] {
        (0 ..< Int(ob_document_texture_count(handle))).compactMap { i in
            var t = ob_texture_info()
            guard ob_document_texture(handle, Int32(i), &t) != 0 else { return nil }
            return Texture(id: optionalString(t.id) ?? "", name: optionalString(t.name) ?? "",
                           source: optionalString(t.src) ?? "", width: t.width, height: t.height,
                           isAtlasPage: t.is_atlas_page != 0, premultipliedAlpha: t.premultiplied_alpha != 0)
        }
    }

    /// A sound file of the document (what an audio command's `asset` names).
    public struct AudioAsset: Equatable {
        public var id: String
        public var name: String
        /// A `data:` URL or a path relative to the document.
        public var source: String
        /// Seconds (0 if unknown).
        public var duration: Double

        public init(id: String, name: String = "", source: String, duration: Double = 0) {
            self.id = id
            self.name = name
            self.source = source
            self.duration = duration
        }
    }

    /// A mixer bus: its volume multiplies the volume of every sound played through it.
    public struct AudioBus: Equatable {
        public var id: String
        public var name: String
        public var volume: Double
        public var isMuted: Bool

        public init(id: String, name: String = "", volume: Double = 1, isMuted: Bool = false) {
            self.id = id
            self.name = name
            self.volume = volume
            self.isMuted = isMuted
        }
    }

    public var audioAssets: [AudioAsset] {
        (0 ..< Int(ob_document_audio_asset_count(handle))).compactMap { i in
            var a = ob_audio_asset()
            guard ob_document_audio_asset(handle, Int32(i), &a) != 0 else { return nil }
            return AudioAsset(id: optionalString(a.id) ?? "", name: optionalString(a.name) ?? "",
                              source: optionalString(a.src) ?? "", duration: a.duration)
        }
    }

    public var audioBuses: [AudioBus] {
        (0 ..< Int(ob_document_audio_bus_count(handle))).compactMap { i in
            var b = ob_audio_bus()
            guard ob_document_audio_bus(handle, Int32(i), &b) != 0 else { return nil }
            return AudioBus(id: optionalString(b.id) ?? "", name: optionalString(b.name) ?? "", volume: b.volume,
                            isMuted: b.muted != 0)
        }
    }

    /// Master volume: 0 when the document's audio is muted, 1 when it has no audio settings.
    public var audioMaster: Double { ob_document_audio_master(handle) }

    /// A font file shipped with the document. Text names `family` in its CSS-like font list
    /// ("Noto Serif JP, Georgia, serif"); see `font(family:weight:)` for how a text picks one.
    public struct FontAsset: Equatable {
        public var id: String
        public var name: String
        /// The family name text uses in its font list.
        public var family: String
        /// A `data:` URL or a path relative to the document.
        public var source: String
        /// 100...900.
        public var weight: Double
        /// "normal" or "italic".
        public var style: String

        public init(id: String, name: String = "", family: String, source: String, weight: Double = 400,
                    style: String = "normal") {
            self.id = id
            self.name = name
            self.family = family
            self.source = source
            self.weight = weight
            self.style = style
        }
    }

    public var fonts: [FontAsset] {
        (0 ..< Int(ob_document_font_count(handle))).compactMap { i in
            var f = ob_font_asset()
            guard ob_document_font(handle, Int32(i), &f) != 0 else { return nil }
            return FontAsset(id: optionalString(f.id) ?? "", name: optionalString(f.name) ?? "",
                             family: optionalString(f.family) ?? "", source: optionalString(f.src) ?? "",
                             weight: f.weight, style: optionalString(f.style) ?? "normal")
        }
    }

    /// The document's font for one family (case-insensitive) whose weight is closest to `weight` (the first wins a
    /// tie), or nil. Every runtime picks text fonts this way: for each family of the text's font list in order, the
    /// document's font of that family if it has one, else the installed font of that name.
    public func font(family: String, weight: Double = 400) -> FontAsset? {
        var best: FontAsset?
        for f in fonts where f.family.caseInsensitiveCompare(family) == .orderedSame {
            if best == nil || abs(f.weight - weight) < abs(best!.weight - weight) { best = f }
        }
        return best
    }

    /// The families of a CSS-like font list ("Noto Serif JP, 'Open Sans', serif"), trimmed and unquoted, in order.
    public static func fontFamilies(_ list: String) -> [String] {
        list.split(separator: ",").compactMap { part -> String? in
            var n = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if n.count >= 2, let q = n.first, q == "\"" || q == "'", n.last == q { n = String(n.dropFirst().dropLast()) }
            return n.isEmpty ? nil : n
        }
    }

    /// Bytes of a font source (a `data:` URL, or a path relative to `baseURL`), or nil when it cannot be resolved.
    public func fontData(for source: String) -> Data? {
        OpenBoneDocument.resolve(source: source, baseURL: baseURL)
    }

    /// Bytes of a sound source (a `data:` URL, or a path relative to `baseURL`), or nil when it cannot be resolved.
    public func audioData(for source: String) -> Data? {
        OpenBoneDocument.resolve(source: source, baseURL: baseURL)
    }

    /// Bytes of a texture source: decodes `data:` URLs (base64 or percent-encoded), reads relative paths from
    /// `baseURL`. Returns nil when the source cannot be resolved.
    public func textureData(for source: String) -> Data? {
        OpenBoneDocument.resolve(source: source, baseURL: baseURL)
    }

    static func resolve(source: String, baseURL: URL?) -> Data? {
        if source.hasPrefix("data:") {
            guard let comma = source.firstIndex(of: ",") else { return nil }
            let header = source[source.index(source.startIndex, offsetBy: 5) ..< comma]
            let payload = String(source[source.index(after: comma)...])
            if header.hasSuffix(";base64") { return Data(base64Encoded: payload, options: .ignoreUnknownCharacters) }
            return payload.removingPercentEncoding.map { Data($0.utf8) }
        }
        if source.isEmpty { return nil }
        let url: URL
        if source.hasPrefix("/") { url = URL(fileURLWithPath: source) }
        else if let base = baseURL { url = base.appendingPathComponent(source) }
        else { url = URL(fileURLWithPath: source) }
        return try? Data(contentsOf: url)
    }
}
