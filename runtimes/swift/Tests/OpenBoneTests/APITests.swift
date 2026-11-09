// The Swift API around the conformance suite: loading, listings, inputs, callbacks, draw list, lifetimes.
// SPDX-License-Identifier: MIT
import Foundation
import OpenBone
import XCTest

final class APITests: XCTestCase {
    let fixtures = repoRoot.appendingPathComponent("conformance/fixtures")
    let binaryData = repoRoot.appendingPathComponent("runtimes/cpp/tests/data")

    func load(_ name: String) throws -> OpenBoneDocument {
        try OpenBoneDocument(contentsOf: fixtures.appendingPathComponent(name + ".obone"))
    }

    func testLibrary() {
        XCTAssertGreaterThanOrEqual(OpenBoneRuntime.apiVersion, 1)
        XCTAssertFalse(OpenBoneRuntime.version.isEmpty)
    }

    func testLoadErrors() {
        XCTAssertThrowsError(try OpenBoneDocument(contentsOf: URL(fileURLWithPath: "/nonexistent/x.obone"))) { e in
            XCTAssertFalse((e as? OpenBoneError)?.message.isEmpty ?? true)
        }
        XCTAssertThrowsError(try OpenBoneDocument(data: Data("not a document".utf8)))
        XCTAssertThrowsError(try OpenBoneDocument(data: Data()))
    }

    func testDocumentListings() throws {
        let doc = try load("interactive")
        XCTAssertGreaterThan(doc.artboard.width, 0)
        XCTAssertEqual(doc.stateMachines.count, 1)
        let inputs = doc.stateMachines[0].inputs
        XCTAssertFalse(inputs.isEmpty)
        XCTAssertTrue(inputs.contains { $0.isTrigger })
        let knight = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("examples/knight.obone"))
        XCTAssertFalse(knight.animations.isEmpty)
        XCTAssertTrue(knight.animations.allSatisfy { $0.duration > 0 })
        XCTAssertFalse(knight.textures.isEmpty)
        for t in knight.textures { XCTAssertNotNil(knight.textureData(for: t.source), t.id) }
    }

    func testBinaryMatchesJSON() throws {
        // The .obonb fixture and its decoded .obone pose identically.
        let bin = try OpenBoneDocument(data: Data(contentsOf: binaryData.appendingPathComponent("dynamics.obonb")))
        let json = try OpenBoneDocument(contentsOf: binaryData.appendingPathComponent("dynamics.decoded.obone"))
        let a = try OpenBoneInstance(document: bin), b = try OpenBoneInstance(document: json)
        let anim = bin.animations[0].name
        try a.play(anim)
        try b.play(anim)
        for _ in 0 ..< 30 {
            a.advance(1.0 / 60)
            b.advance(1.0 / 60)
        }
        XCTAssertEqual(a.bones, b.bones)
        XCTAssertEqual(a.drawList(), b.drawList())
    }

    func testStateMachineInputsAndCallbacks() throws {
        let doc = try load("interactive")
        let inst = try OpenBoneInstance(document: doc)
        var transitions: [String] = []
        inst.onStateChange = { layer, _, to in transitions.append("\(layer):\(to)") }
        try inst.useStateMachine()
        XCTAssertTrue(inst.isRunningStateMachine)
        inst.advance(0)
        XCTAssertFalse(inst.activeStates.isEmpty)
        XCTAssertFalse(transitions.isEmpty, "entering the first state reports a transition")
        for input in doc.stateMachines[0].inputs where !input.isTrigger {
            switch input.defaultValue {
            case .bool?: try inst.setInput(input.name, true); XCTAssertEqual(inst.input(input.name), .bool(true))
            case .number?: try inst.setInput(input.name, 0.25); XCTAssertEqual(inst.input(input.name), .number(0.25))
            case .string?: try inst.setInput(input.name, "hi"); XCTAssertEqual(inst.input(input.name), .string("hi"))
            case nil: break
            }
        }
        XCTAssertThrowsError(try inst.setInput("no such input", 1.0))
        XCTAssertNil(inst.input("no such input"))
        XCTAssertThrowsError(try inst.fire("no such trigger"))
    }

    func testPointerFiresListenerEventAndAudio() throws {
        // Replays the interactive case that clicks the hit box and checks the Swift callbacks see the event.
        let expected = try JSONDecoder().decode(
            JSON.self, from: Data(contentsOf: repoRoot.appendingPathComponent("conformance/expected/interactive.json")))
        guard let c = expected["cases"].array.first(where: { cs in cs["actions"].array.contains { $0.has("pointer") } })
        else { return XCTFail("no pointer case") }
        let inst = try OpenBoneInstance(document: try load("interactive"))
        var events: [OpenBoneEvent] = []
        var audio: [OpenBoneAudioCommand] = []
        inst.onEvent = { events.append($0) }
        inst.onAudio = { audio.append($0) }
        try inst.useStateMachine(c["stateMachine"].string)
        inst.advance(0)
        let refEvents = c["samples"].array.flatMap { $0["events"].array }.compactMap { $0["name"].string }
        let refAudio = c["samples"].array.reduce(0) { $0 + $1["audio"].count }
        let steps = Int((c["duration"].double ?? 0) * 60 + 0.5)
        for i in 1 ... steps {
            let t = Double(i - 1) / 60
            for a in c["actions"].array where abs((a["t"].double ?? -1) - t) <= 1.0 / 120 {
                if let p = a["pointer"].string {
                    try inst.pointer(p == "down" ? .down : p == "up" ? .up : .move, x: a["x"].double!, y: a["y"].double!)
                } else if let f = a["fire"].string { try inst.fire(f) }
                else if let n = a["input"].string, case let .number(v) = a["value"] { try inst.setInput(n, v) }
                else if let n = a["input"].string, case let .bool(v) = a["value"] { try inst.setInput(n, v) }
                else if let n = a["input"].string, case let .string(v) = a["value"] { try inst.setInput(n, v) }
            }
            inst.advance(1.0 / 60)
        }
        XCTAssertEqual(events.map(\.name), refEvents)
        XCTAssertEqual(audio.count, refAudio)
    }

    func testPointerWithoutStateMachineThrows() throws {
        let inst = try OpenBoneInstance(document: try load("transforms"))
        XCTAssertThrowsError(try inst.pointer(.down, x: 0, y: 0))
    }

    func testAnimationsSkinsAndDrawList() throws {
        let doc = try load("rigging")
        let inst = try OpenBoneInstance(document: doc)
        for skin in doc.skins { try inst.setSkin(skin) }
        try inst.setSkin(nil)
        XCTAssertThrowsError(try inst.setSkin("no such skin"))
        XCTAssertThrowsError(try inst.play("no such animation"))
        try inst.play(doc.animations[0].name, loop: true)
        try inst.queue(doc.animations[0].name, loop: false, delay: 0.5)
        inst.advance(0.1)
        let list = inst.drawList()
        XCTAssertFalse(list.items.isEmpty)
        for it in list.items {
            XCTAssertEqual(it.vertices.count % 2, 0)
            XCTAssertTrue(it.indices.allSatisfy { Int($0) < it.vertices.count / 2 })
        }
        // The zero-copy view agrees with the copy.
        let viaView = inst.withDrawList { v in Array(v.items.map(OpenBoneDrawItem.init)) }
        XCTAssertEqual(viaView, list.items)
        XCTAssertFalse(inst.bounds.isEmpty)
        XCTAssertNotNil(inst.bone(named: inst.bones[0].name))
        XCTAssertEqual(inst.slot(named: inst.slots[0].name), inst.slots[0])
        inst.clearTracks()
    }

    func testClipsAndText() throws {
        let meshes = try OpenBoneInstance(document: try load("meshes"))
        meshes.advance(0)
        let list = meshes.drawList()
        XCTAssertFalse(list.clips.isEmpty)
        for it in list.items { if let c = it.clip { XCTAssertLessThan(c, list.clips.count) } }
        let dynamics = try OpenBoneInstance(document: try load("dynamics"))
        dynamics.advance(0)
        let text = dynamics.drawList().items.first { $0.kind == .text }
        XCTAssertNotNil(text?.text)
        if let t = text { try dynamics.setText(slot: t.slot, "fixed"); dynamics.advance(0) }
        XCTAssertEqual(dynamics.drawList().items.first { $0.kind == .text }?.text?.content, "fixed")
    }

    func testLifetimes() throws {
        // The instance keeps its document alive; both go away with the last reference, and the callback box with them.
        weak var weakDoc: OpenBoneDocument?
        weak var weakInst: OpenBoneInstance?
        do {
            let inst = try OpenBoneInstance(document: try load("interactive"))
            weakDoc = inst.document
            weakInst = inst
            inst.onEvent = { [weak inst] _ in _ = inst?.boneCount }
            try inst.useStateMachine()
            inst.advance(0.5)
            XCTAssertNotNil(weakDoc)
        }
        XCTAssertNil(weakInst)
        XCTAssertNil(weakDoc)
    }

    func testManyInstancesShareADocument() throws {
        let doc = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("examples/campfire.obone"))
        for _ in 0 ..< 50 {
            let inst = try OpenBoneInstance(document: doc)
            if let first = doc.stateMachines.first { try inst.useStateMachine(first.name) } else { try inst.play(doc.animations[0].name) }
            inst.advance(1.0 / 30)
            _ = inst.drawList()
        }
    }
}
