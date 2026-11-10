// A small JSON value for reading the conformance files and building samples to compare.
// SPDX-License-Identifier: MIT
import Foundation

enum JSON: Equatable, Decodable, CustomStringConvertible {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    subscript(key: String) -> JSON {
        if case let .object(o) = self { return o[key] ?? .null }
        return .null
    }

    subscript(index: Int) -> JSON {
        if case let .array(a) = self, index >= 0, index < a.count { return a[index] }
        return .null
    }

    func has(_ key: String) -> Bool {
        if case let .object(o) = self { return o[key] != nil }
        return false
    }

    var array: [JSON] {
        if case let .array(a) = self { return a }
        return []
    }

    var count: Int {
        switch self {
        case let .array(a): return a.count
        case let .object(o): return o.count
        default: return 0
        }
    }

    var double: Double? {
        if case let .number(n) = self { return n }
        return nil
    }

    var string: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    var isNull: Bool { self == .null }

    var description: String {
        switch self {
        case .null: return "null"
        case let .bool(b): return String(b)
        case let .number(n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case let .string(s): return "\"\(s)\""
        case let .array(a): return "[" + a.map(\.description).joined(separator: ",") + "]"
        case let .object(o): return "{" + o.keys.sorted().map { "\"\($0)\":\(o[$0]!)" }.joined(separator: ",") + "}"
        }
    }

    static func nums<S: Sequence>(_ s: S) -> JSON where S.Element: BinaryFloatingPoint {
        .array(s.map { .number(Double($0)) })
    }

    static func ints<S: Sequence>(_ s: S) -> JSON where S.Element: BinaryInteger {
        .array(s.map { .number(Double($0)) })
    }

    static func opt(_ s: String?) -> JSON { s.map { .string($0) } ?? .null }
}
