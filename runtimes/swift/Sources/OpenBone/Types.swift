// Value types shared by the Swift API.
// SPDX-License-Identifier: MIT
import COpenBone

/// A failure reported by the runtime (`ob_last_error()`).
public struct OpenBoneError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }

    /// The runtime's last error on this thread, or `fallback` when it is empty.
    static func last(_ fallback: String) -> OpenBoneError {
        let m = String(cString: ob_last_error())
        return OpenBoneError(m.isEmpty ? fallback : m)
    }
}

@inline(__always)
func check(_ result: Int32, _ what: @autoclosure () -> String) throws {
    if result == 0 { throw OpenBoneError.last(what()) }
}

@inline(__always)
func optionalString(_ p: UnsafePointer<CChar>?) -> String? {
    p.map { String(cString: $0) }
}

/// The library: version and build features.
public enum OpenBoneRuntime {
    /// `OB_API_VERSION` of the linked C API.
    public static var apiVersion: Int { Int(ob_api_version()) }
    public static var version: String { String(cString: ob_version()) }
    /// True when built with the QuickJS script host (see `scripts/fetch-quickjs.sh`).
    public static var hasScripts: Bool { ob_has_scripts() != 0 }
}

/// A 2D point in skeleton space (x right, y up, document pixels).
public struct OpenBonePoint: Equatable, Hashable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// An axis-aligned rectangle (skeleton space unless noted).
public struct OpenBoneRect: Equatable, Hashable {
    public var minX, minY, maxX, maxY: Double
    public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }
    public var width: Double { maxX - minX }
    public var height: Double { maxY - minY }
    public var isEmpty: Bool { !(maxX > minX && maxY > minY) }
}

/// An affine matrix: x' = a·x + b·y + tx, y' = c·x + d·y + ty (the runtime's convention).
public struct OpenBoneMatrix: Equatable, Hashable {
    public var a, b, c, d, tx, ty: Double
    public init(a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double) {
        self.a = a
        self.b = b
        self.c = c
        self.d = d
        self.tx = tx
        self.ty = ty
    }
    public static let identity = OpenBoneMatrix(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)
    public func apply(_ p: OpenBonePoint) -> OpenBonePoint {
        OpenBonePoint(x: a * p.x + b * p.y + tx, y: c * p.x + d * p.y + ty)
    }
}

public enum OpenBoneBlendMode: Int, Equatable, CaseIterable {
    case normal = 0, additive = 1, multiply = 2, screen = 3

    init(_ b: ob_blend) { self = OpenBoneBlendMode(rawValue: Int(b.rawValue)) ?? .normal }

    /// The name the document format and the conformance suite use.
    public var name: String {
        switch self {
        case .normal: return "normal"
        case .additive: return "additive"
        case .multiply: return "multiply"
        case .screen: return "screen"
        }
    }
}

public enum OpenBoneItemKind: Int, Equatable, CaseIterable {
    case region = 0, mesh = 1, sequence = 2, shape = 3, text = 4, particles = 5

    init(_ k: ob_item_kind) { self = OpenBoneItemKind(rawValue: Int(k.rawValue)) ?? .region }

    /// The draw item `type` of the TypeScript runtime and the conformance suite.
    public var name: String {
        switch self {
        case .region: return "region"
        case .mesh: return "mesh"
        case .sequence: return "sequence"
        case .shape: return "shape"
        case .text: return "text"
        case .particles: return "particles"
        }
    }
}

public enum OpenBonePointerType: Equatable {
    case down, up, move
    var c: ob_pointer_type {
        switch self {
        case .down: return OB_POINTER_DOWN
        case .up: return OB_POINTER_UP
        case .move: return OB_POINTER_MOVE
        }
    }
}

/// A state-machine input value.
public enum OpenBoneValue: Equatable, Hashable, CustomStringConvertible {
    case bool(Bool)
    case number(Double)
    case string(String)

    init?(_ v: ob_value) {
        switch v.type {
        case OB_VALUE_BOOL: self = .bool(v.b != 0)
        case OB_VALUE_NUMBER: self = .number(v.n)
        case OB_VALUE_STRING: self = .string(v.s.map { String(cString: $0) } ?? "")
        default: return nil
        }
    }

    public var description: String {
        switch self {
        case let .bool(b): return String(b)
        case let .number(n): return String(n)
        case let .string(s): return s
        }
    }
}

/// An event keyed in an animation, emitted by a listener or a script.
public struct OpenBoneEvent: Equatable {
    public var name: String
    public var id: String
    public var time: Double
    public var intValue: Double
    public var floatValue: Double
    public var stringValue: String
    /// The animation that keyed it ("" for listener and script events).
    public var animation: String
    /// The sound the event plays, if any (the matching audio command arrives through `onAudio`).
    public var audio: String?

    init(_ e: ob_event) {
        name = optionalString(e.name) ?? ""
        id = optionalString(e.id) ?? ""
        time = e.time
        intValue = e.int_value
        floatValue = e.float_value
        stringValue = optionalString(e.string_value) ?? ""
        animation = optionalString(e.animation) ?? ""
        audio = optionalString(e.audio)
    }
}

/// What the document asks the host's audio engine to do. Playback is up to the app (AVAudioEngine, …).
public enum OpenBoneAudioCommand: Equatable {
    /// Start a sound. `id` names this playing instance; later `stop` / `fade` commands refer to it.
    case play(id: String, sound: String, asset: String, bus: String?, volume: Double, rate: Double, loop: Bool,
              fadeIn: Double, source: String)
    /// Stop a playing instance, fading out over `fade` seconds.
    case stop(id: String, fade: Double)
    /// Fade a playing instance to `volume` over `duration` seconds.
    case fade(id: String, volume: Double, duration: Double)

    init(_ c: ob_audio_command) {
        let id = optionalString(c.id) ?? ""
        switch c.type {
        case OB_AUDIO_PLAY:
            self = .play(id: id, sound: optionalString(c.sound) ?? "", asset: optionalString(c.asset) ?? "",
                         bus: optionalString(c.bus), volume: c.volume, rate: c.rate, loop: c.loop != 0,
                         fadeIn: c.fade_in, source: optionalString(c.source) ?? "")
        case OB_AUDIO_STOP:
            self = .stop(id: id, fade: c.fade)
        default:
            self = .fade(id: id, volume: c.volume, duration: c.duration)
        }
    }

    public var id: String {
        switch self {
        case let .play(id, _, _, _, _, _, _, _, _), let .stop(id, _), let .fade(id, _, _): return id
        }
    }
}

/// A bone of a posed skeleton.
public struct OpenBoneBone: Equatable {
    public var name: String
    public var parent: String?
    public var length: Double
    /// World transform (skeleton space).
    public var world: OpenBoneMatrix
    /// False for skin bones whose skin is not active.
    public var active: Bool
}

/// A slot of a posed skeleton: what it shows and how it is tinted.
public struct OpenBoneSlot: Equatable {
    public var name: String
    public var bone: String
    /// The attachment shown, or nil when the slot is empty.
    public var attachment: String?
    /// Tint, straight alpha (r, g, b, a in 0…1).
    public var color: SIMD4<Float>
    /// Dark tint for two-colour tinting, or nil.
    public var dark: SIMD3<Float>?
    public var blend: OpenBoneBlendMode
}
