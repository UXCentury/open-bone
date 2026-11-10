// Conformance: replays every case of conformance/expected/*.json (see conformance/README.md) through the Swift API
// and compares each sample with the suite's tolerances — the same rules as runtimes/cpp/tests/conformance.cpp.
// SPDX-License-Identifier: MIT
import Foundation
import OpenBone
import XCTest

/// Repository root, from this file's location (runtimes/swift/Tests/OpenBoneTests/…).
let repoRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

private let dt = 1.0 / 60
private let sampleEvery = 10
private let slack = 5e-5 + 1e-9 // reference values are rounded to 4 decimals

private func r4(_ n: Double) -> Double {
    let v = (n * 1e4 + 0.5).rounded(.down) / 1e4
    return v == 0 ? 0 : v
}

/// Samples a running instance the way generate.ts does.
private final class Recorder {
    /// Bounding-box queries of the file (`queries`), and the other skeleton per `queries.others` placement.
    var queries: JSON?
    var others: [OpenBoneSkeletonBounds] = []
    var boundsErrors: [String] = []
    var events: [JSON] = []
    var audio: [JSON] = []
    var ids: [String: String] = [:]

    func attach(_ inst: OpenBoneInstance) {
        inst.onEvent = { [unowned self] e in
            events.append(.object(["name": .string(e.name), "time": .number(r4(e.time)), "int": .number(e.intValue),
                                   "float": .number(r4(e.floatValue)), "string": .string(e.stringValue)]))
        }
        inst.onAudio = { [unowned self] c in
            let id = ids[c.id] ?? "p\(ids.count + 1)"
            ids[c.id] = id
            switch c {
            case let .play(_, sound, asset, bus, volume, rate, loop, fadeIn, source):
                audio.append(.object(["type": .string("play"), "id": .string(id), "sound": .string(sound),
                                      "asset": .string(asset), "bus": .opt(bus), "volume": .number(r4(volume)),
                                      "rate": .number(r4(rate)), "loop": .bool(loop), "fadeIn": .number(r4(fadeIn)),
                                      "source": .string(source)]))
            case let .stop(_, fade):
                audio.append(.object(["type": .string("stop"), "id": .string(id), "fade": .number(r4(fade))]))
            case let .fade(_, volume, duration):
                audio.append(.object(["type": .string("fade"), "id": .string(id), "volume": .number(r4(volume)),
                                      "duration": .number(r4(duration))]))
            }
        }
    }

    func sample(_ inst: OpenBoneInstance, t: Double, machine: Bool) -> JSON {
        var s: [String: JSON] = ["t": .number(r4(t))]
        s["bones"] = .array(inst.bones.map { b in
            .nums([b.world.a, b.world.b, b.world.c, b.world.d, b.world.tx, b.world.ty])
        })
        s["slots"] = .array(inst.slots.map { sl in
            .array([.opt(sl.attachment), .nums([sl.color.x, sl.color.y, sl.color.z, sl.color.w]),
                    sl.dark.map { .nums([$0.x, $0.y, $0.z]) } ?? .null])
        })
        s["draw"] = inst.withDrawList { list -> JSON in
            var clipsUsed: [Int] = []
            return .array(list.items.map { it -> JSON in
                var d: [String: JSON] = [
                    "slot": .string(it.slot), "attachment": .string(it.attachment), "type": .string(it.kind.name),
                    "blend": .string(it.blend.name), "texture": .opt(it.textureID),
                    "vertices": .nums(it.vertices), "uvs": .nums(it.uvs), "indices": .ints(it.indices),
                    "color": .nums([it.color.x, it.color.y, it.color.z, it.color.w]),
                ]
                if let k = it.dark { d["dark"] = .nums([k.x, k.y, k.z]) }
                if let c = it.colors { d["colors"] = .nums(c) }
                if let clip = it.clip {
                    // Clip indices are renumbered in order of use within the sample, like the reference.
                    if let i = clipsUsed.firstIndex(of: clip) { d["clip"] = .number(Double(i)) }
                    else {
                        clipsUsed.append(clip)
                        d["clip"] = .number(Double(clipsUsed.count - 1))
                    }
                }
                if let text = it.text { d["text"] = .string(text.content) }
                return .object(d)
            })
        }
        s["events"] = .array(events)
        s["audio"] = .array(audio)
        if machine {
            var st: [String: JSON] = [:]
            for l in inst.activeStates { st[l.layer] = .opt(l.state) }
            s["states"] = .object(st)
        }
        if let q = queries { s["bounds"] = recordBounds(inst, q) }
        events = []
        audio = []
        return .object(s)
    }
}

extension Recorder {
    /// conformance/README.md "Bounding-box queries": the record of one sample.
    func recordBounds(_ inst: OpenBoneInstance, _ q: JSON) -> JSON {
        let b = inst.boundingBoxes()
        let idx = { (list: [OpenBoneBoundingBox]) -> JSON in .ints(list.map(\.index)) }
        var r: [String: JSON] = [:]
        r["boxes"] = .array(b.boxes.map { x in
            .object(["slot": .string(x.slot), "attachment": .string(x.attachment), "vertices": .nums(x.vertices)])
        })
        r["aabb"] = b.aabb.map { .nums([$0.minX, $0.minY, $0.maxX, $0.maxY]) } ?? .null
        r["points"] = .array(q["points"].array.map { p in
            let x = p[0].double ?? 0, y = p[1].double ?? 0
            let all = b.containsPointAll(x: x, y: y)
            if b.containsPoint(x: x, y: y)?.index != all.first?.index { boundsErrors.append("containsPoint disagrees with containsPointAll") }
            return idx(all)
        })
        r["segments"] = .array(q["segments"].array.map { s in
            let v = (0 ..< 4).map { s[$0].double ?? 0 }
            let all = b.intersectsSegmentAll(x1: v[0], y1: v[1], x2: v[2], y2: v[3])
            if b.intersectsSegment(x1: v[0], y1: v[1], x2: v[2], y2: v[3])?.index != all.first?.index {
                boundsErrors.append("intersectsSegment disagrees with intersectsSegmentAll")
            }
            return idx(all)
        })
        r["aabbs"] = .array(q["aabbs"].array.map { a in
            .bool(b.aabbIntersects(OpenBoneRect(minX: a[0].double ?? 0, minY: a[1].double ?? 0,
                                                maxX: a[2].double ?? 0, maxY: a[3].double ?? 0)))
        })
        r["others"] = .array(others.map { o in
            b.intersectsBounds(o).map { .ints([$0.mine.index, $0.theirs.index]) } ?? .null
        })
        return .object(r)
    }
}

/// Collects mismatches (first `max` of them) like the C++ runner's `Compare`.
private struct Compare {
    var errors: [String] = []
    var max = 12

    mutating func fail(_ path: String, _ what: String) {
        if errors.count < max { errors.append("\(path): \(what)") }
        else if errors.count == max { errors.append("…") }
    }

    static func show(_ j: JSON) -> String {
        let s = j.description
        return s.count > 200 ? String(s.prefix(200)) + "…" : s
    }

    mutating func num(_ path: String, _ mine: JSON, _ ref: JSON, _ tol: Double) {
        let mineMissing = mine.isNull || (mine.double?.isNaN ?? false)
        if ref.isNull {
            if !mineMissing { fail(path, "expected null/NaN, got \(Compare.show(mine))") }
            return
        }
        guard let a = mine.double, let b = ref.double else {
            return fail(path, "expected \(Compare.show(ref)), got \(Compare.show(mine))")
        }
        if !(abs(a - b) <= tol + slack) {
            fail(path, String(format: "%.6f vs reference %.6f (diff %.2e, tol %.0e)", a, b, abs(a - b), tol))
        }
    }

    mutating func nums(_ path: String, _ mine: JSON, _ ref: JSON, _ tol: Double) {
        guard case let .array(r) = ref, case let .array(m) = mine, m.count == r.count else {
            return fail(path, "length \(mine.count) vs reference \(ref.count)")
        }
        for i in 0 ..< r.count { num("\(path)[\(i)]", m[i], r[i], tol) }
    }

    mutating func exact(_ path: String, _ mine: JSON, _ ref: JSON) {
        if mine != ref { fail(path, "\(Compare.show(mine)) vs reference \(Compare.show(ref))") }
    }

    mutating func sample(_ p: String, _ m: JSON, _ r: JSON) {
        num("\(p).t", m["t"], r["t"], 1e-9)
        let mb = m["bones"], rb = r["bones"]
        if mb.count != rb.count { fail("\(p).bones", "count \(mb.count) vs \(rb.count)") }
        else {
            for i in 0 ..< rb.count {
                for k in 0 ..< 6 { num("\(p).bones[\(i)][\(k)]", mb[i][k], rb[i][k], k < 4 ? 1e-4 : 1e-3) }
            }
        }
        let ms = m["slots"], rs = r["slots"]
        if ms.count != rs.count { fail("\(p).slots", "count \(ms.count) vs \(rs.count)") }
        else {
            for i in 0 ..< rs.count {
                let q = "\(p).slots[\(i)]"
                exact("\(q).attachment", ms[i][0], rs[i][0])
                nums("\(q).color", ms[i][1], rs[i][1], 1.0 / 255)
                if rs[i][2].isNull || ms[i][2].isNull {
                    exact("\(q).dark", ms[i][2].isNull ? .null : .string("set"), rs[i][2].isNull ? .null : .string("set"))
                } else {
                    nums("\(q).dark", ms[i][2], rs[i][2], 1.0 / 255)
                }
            }
        }
        let md = m["draw"], rd = r["draw"]
        if md.count != rd.count {
            let a = md.array.map { $0["slot"].string ?? "?" }.joined(separator: " ")
            let b = rd.array.map { $0["slot"].string ?? "?" }.joined(separator: " ")
            fail("\(p).draw", "count \(md.count) vs \(rd.count) [\(a)] vs [\(b)]")
        } else {
            for i in 0 ..< rd.count {
                let x = md[i], y = rd[i]
                let q = "\(p).draw[\(i)](\(y["slot"].string ?? "?"))"
                for k in ["slot", "attachment", "type", "blend", "texture"] { exact("\(q).\(k)", x[k], y[k]) }
                let particles = y["type"] == .string("particles")
                nums("\(q).vertices", x["vertices"], y["vertices"], particles ? 1e-2 : 1e-3)
                nums("\(q).uvs", x["uvs"], y["uvs"], 1e-3)
                exact("\(q).indices", x["indices"], y["indices"])
                nums("\(q).color", x["color"], y["color"], 1.0 / 255)
                for k in ["dark", "colors"] {
                    if y.has(k) != x.has(k) { fail("\(q).\(k)", x.has(k) ? "unexpected" : "missing") }
                    else if y.has(k) { nums("\(q).\(k)", x[k], y[k], 1.0 / 255) }
                }
                exact("\(q).clip", x["clip"], y["clip"])
                exact("\(q).text", x["text"], y["text"])
            }
        }
        let me = m["events"], re = r["events"]
        if me.count != re.count { fail("\(p).events", "\(Compare.show(me)) vs reference \(Compare.show(re))") }
        else {
            for i in 0 ..< re.count {
                let q = "\(p).events[\(i)]"
                exact("\(q).name", me[i]["name"], re[i]["name"])
                exact("\(q).string", me[i]["string"], re[i]["string"])
                num("\(q).time", me[i]["time"], re[i]["time"], 1e-4)
                num("\(q).int", me[i]["int"], re[i]["int"], 1e-9)
                num("\(q).float", me[i]["float"], re[i]["float"], 1e-4)
            }
        }
        let ma = m["audio"], ra = r["audio"]
        if ma.count != ra.count { fail("\(p).audio", "\(Compare.show(ma)) vs reference \(Compare.show(ra))") }
        else {
            for i in 0 ..< ra.count {
                let q = "\(p).audio[\(i)]"
                guard case let .object(ro) = ra[i] else { continue }
                for (key, value) in ro.sorted(by: { $0.key < $1.key }) {
                    if case .number = value { num("\(q).\(key)", ma[i][key], value, 1e-4) }
                    else { exact("\(q).\(key)", ma[i][key], value) }
                }
                if ma[i].count != ra[i].count { fail(q, "\(Compare.show(ma[i])) vs reference \(Compare.show(ra[i]))") }
            }
        }
        if r.has("bounds") != m.has("bounds") { fail("\(p).bounds", m.has("bounds") ? "unexpected" : "missing") }
        else if r.has("bounds") {
            let mb = m["bounds"], rb = r["bounds"]
            let mx = mb["boxes"].array, rx = rb["boxes"].array
            if mx.count != rx.count { fail("\(p).bounds.boxes", "\(Compare.show(mb["boxes"])) vs reference \(Compare.show(rb["boxes"]))") }
            else {
                for i in 0 ..< rx.count {
                    let q = "\(p).bounds.boxes[\(i)]"
                    exact("\(q).slot", mx[i]["slot"], rx[i]["slot"])
                    exact("\(q).attachment", mx[i]["attachment"], rx[i]["attachment"])
                    nums("\(q).vertices", mx[i]["vertices"], rx[i]["vertices"], 1e-3)
                }
            }
            if rb["aabb"].isNull || mb["aabb"].isNull { exact("\(p).bounds.aabb", mb["aabb"], rb["aabb"]) }
            else { nums("\(p).bounds.aabb", mb["aabb"], rb["aabb"], 1e-3) }
            for k in ["points", "segments", "aabbs", "others"] { exact("\(p).bounds.\(k)", mb[k], rb[k]) }
        }
        if r.has("states") || m.has("states") { exact("\(p).states", m["states"], r["states"]) }
    }
}

/// Runs one case and returns its samples.
private func runCase(_ doc: OpenBoneDocument, _ c: JSON, queries: JSON?, others: [OpenBoneSkeletonBounds],
                     boundsErrors: inout [String]) throws -> [JSON] {
    let kind = c["kind"].string ?? ""
    let steps = Int((c["duration"].double ?? 0) / dt + 0.5)
    let inst = try OpenBoneInstance(document: doc)
    let rec = Recorder()
    rec.queries = queries
    rec.others = others
    defer { boundsErrors = rec.boundsErrors }
    let machine = kind == "stateMachine"
    if !machine, let skin = c["skin"].string { try inst.setSkin(skin) }
    if kind == "animation" { try inst.play(c["animation"].string ?? "", loop: true) }
    if machine { try inst.useStateMachine(c["stateMachine"].string) }
    rec.attach(inst)
    var out: [JSON] = []
    inst.advance(0)
    out.append(rec.sample(inst, t: 0, machine: machine))
    let actions = c["actions"].array
    for i in 1 ... max(steps, 1) where steps > 0 {
        let t = Double(i - 1) * dt
        for a in actions where abs((a["t"].double ?? -1) - t) <= dt / 2 {
            do {
                if let trigger = a["fire"].string { try inst.fire(trigger) }
                else if let input = a["input"].string {
                    switch a["value"] {
                    case let .bool(b): try inst.setInput(input, b)
                    case let .number(n): try inst.setInput(input, n)
                    case let .string(s): try inst.setInput(input, s)
                    default: break
                    }
                } else if let p = a["pointer"].string {
                    try inst.pointer(p == "down" ? .down : p == "up" ? .up : .move,
                                     x: a["x"].double ?? 0, y: a["y"].double ?? 0)
                }
            } catch {
                print("  action failed: \(error)")
            }
        }
        inst.advance(dt)
        if i % sampleEvery == 0 { out.append(rec.sample(inst, t: Double(i) * dt, machine: machine)) }
    }
    return out
}

final class ConformanceTests: XCTestCase {
    static let expectedDir = repoRoot.appendingPathComponent("conformance/expected")

    /// Every reference file, by name. `testEveryFileIsListed` keeps this list in step with the directory.
    static let files = [
        "atlas-knight", "atlas-polygons", "atlas-walker", "bounds", "constraints", "dynamics", "example-button",
        "example-campfire", "example-crash", "example-fox", "example-knight", "example-robot", "example-rocket",
        "example-tail", "example-walker", "example-windswept", "interactive", "meshes", "mixing", "paths", "rigging", "transforms",
    ]

    func testEveryFileIsListed() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.expectedDir.path)
            .filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
        XCTAssertEqual(names, Self.files.sorted(), "conformance/expected changed: update ConformanceTests.files")
    }

    func testScriptsAvailable() {
        // The interactive fixture counts clicks with a script; without QuickJS it cannot match.
        XCTAssertTrue(OpenBoneRuntime.hasScripts, "built without QuickJS (runtimes/cpp/third_party/quickjs)")
    }

    /// Runs one reference file; returns (passed, total) cases.
    @discardableResult
    func run(_ name: String) throws -> (Int, Int) {
        let data = try Data(contentsOf: Self.expectedDir.appendingPathComponent(name + ".json"))
        let expected = try JSONDecoder().decode(JSON.self, from: data)
        let docURL = repoRoot.appendingPathComponent(expected["document"].string ?? "")
        let doc = try OpenBoneDocument(contentsOf: docURL)
        let queries: JSON? = expected.has("queries") ? expected["queries"] : nil
        // `others`: the same document in a second instance at each placement, setup pose, default skin.
        let others = try (queries?["others"].array ?? []).map { xy -> OpenBoneSkeletonBounds in
            let o = try OpenBoneInstance(document: doc)
            o.setTransform(x: xy[0].double ?? 0, y: xy[1].double ?? 0)
            o.advance(0)
            return o.boundingBoxes()
        }
        var passed = 0
        let cases = expected["cases"].array
        for c in cases {
            let caseName = c["name"].string ?? "?"
            var cmp = Compare()
            do {
                var boundsErrors: [String] = []
                let mine = try runCase(doc, c, queries: queries, others: others, boundsErrors: &boundsErrors)
                for e in boundsErrors { cmp.fail("bounds", e) }
                let ref = c["samples"].array
                if mine.count != ref.count { cmp.fail("samples", "count \(mine.count) vs \(ref.count)") }
                for i in 0 ..< min(mine.count, ref.count) {
                    cmp.sample(String(format: "t=%.4f", ref[i]["t"].double ?? 0), mine[i], ref[i])
                }
            } catch {
                cmp.fail("run", "error: \(error)")
            }
            if cmp.errors.isEmpty { passed += 1 }
            else { XCTFail("\(name) / \(caseName):\n    " + cmp.errors.joined(separator: "\n    ")) }
        }
        print("\(passed == cases.count ? "PASS" : "FAIL") \(name): \(passed)/\(cases.count) cases")
        XCTAssertGreaterThan(cases.count, 0, "\(name) has no cases")
        return (passed, cases.count)
    }

    func testAtlasKnight() throws { try run("atlas-knight") }
    func testAtlasPolygons() throws { try run("atlas-polygons") }
    func testAtlasWalker() throws { try run("atlas-walker") }
    func testBounds() throws { try run("bounds") }
    func testConstraints() throws { try run("constraints") }
    func testDynamics() throws { try run("dynamics") }
    func testExampleButton() throws { try run("example-button") }
    func testExampleCampfire() throws { try run("example-campfire") }
    func testExampleCrash() throws { try run("example-crash") }
    func testExampleFox() throws { try run("example-fox") }
    func testExampleKnight() throws { try run("example-knight") }
    func testExampleRobot() throws { try run("example-robot") }
    func testExampleRocket() throws { try run("example-rocket") }
    func testExampleTail() throws { try run("example-tail") }
    func testExampleWalker() throws { try run("example-walker") }
    func testExampleWindswept() throws { try run("example-windswept") }
    func testInteractive() throws { try run("interactive") }
    func testMeshes() throws { try run("meshes") }
    func testMixing() throws { try run("mixing") }
    func testPaths() throws { try run("paths") }
    func testRigging() throws { try run("rigging") }
    func testTransforms() throws { try run("transforms") }
}
