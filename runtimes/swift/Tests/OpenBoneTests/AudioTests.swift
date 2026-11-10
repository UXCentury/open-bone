// Sound playback logic: the document's audio listings and OpenBoneAudioMixer (gain, voices, fades) with a recording
// output, so it runs without an audio device (the AVFoundation output is Apple-only and not run here).
// SPDX-License-Identifier: MIT
import Foundation
import OpenBone
import XCTest

final class RecordingOutput: OpenBoneAudioOutput {
    enum Call: Equatable {
        case start(voice: Int, asset: String, gain: Double, rate: Double, loop: Bool)
        case gain(voice: Int, gain: Double, duration: Double)
        case stop(voice: Int, fade: Double)
    }

    var calls: [Call] = []
    var failing: Set<String> = []

    func startVoice(_ voice: Int, asset: OpenBoneDocument.AudioAsset, gain: Double, rate: Double, loop: Bool) -> Bool {
        calls.append(.start(voice: voice, asset: asset.id, gain: gain, rate: rate, loop: loop))
        return !failing.contains(asset.id)
    }

    func setVoiceGain(_ voice: Int, to gain: Double, duration: Double) {
        calls.append(.gain(voice: voice, gain: gain, duration: duration))
    }

    func stopVoice(_ voice: Int, fade: Double) { calls.append(.stop(voice: voice, fade: fade)) }
}

final class AudioTests: XCTestCase {
    let assets = [OpenBoneDocument.AudioAsset(id: "a", source: "a.wav"), OpenBoneDocument.AudioAsset(id: "b", source: "b.wav")]
    let buses = [OpenBoneDocument.AudioBus(id: "sfx", volume: 0.5), OpenBoneDocument.AudioBus(id: "muted", volume: 1, isMuted: true)]

    func play(_ id: String, asset: String = "a", bus: String? = "sfx", volume: Double = 1, rate: Double = 1,
              loop: Bool = false, fadeIn: Double = 0) -> OpenBoneAudioCommand {
        .play(id: id, sound: "s", asset: asset, bus: bus, volume: volume, rate: rate, loop: loop, fadeIn: fadeIn, source: "")
    }

    func testDocumentListings() throws {
        let doc = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("examples/button.obone"))
        XCTAssertEqual(doc.audioAssets.map(\.name), ["click", "hover"])
        XCTAssertEqual(doc.audioBuses.map(\.id), ["bus_sfx", "bus_music", "bus_ui"])
        XCTAssertEqual(doc.audioMaster, 1)
        for a in doc.audioAssets {
            XCTAssertGreaterThan(a.duration, 0)
            let bytes = try XCTUnwrap(doc.audioData(for: a.source), a.source)
            XCTAssertEqual(String(decoding: bytes.prefix(4), as: UTF8.self), "RIFF")
        }
        let none = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("conformance/fixtures/transforms.obone"))
        XCTAssertTrue(none.audioAssets.isEmpty)
        XCTAssertEqual(none.audioMaster, 1)
    }

    func testGain() {
        let out = RecordingOutput()
        let m = OpenBoneAudioMixer(assets: assets, buses: buses, master: 0.8, output: out)
        XCTAssertEqual(m.busGain("sfx"), 0.4, accuracy: 1e-12)
        XCTAssertEqual(m.busGain("muted"), 0)
        XCTAssertEqual(m.busGain(nil), 0.8)
        XCTAssertEqual(m.busGain("unknown"), 0.8)
        m.handle(play("p1", volume: 0.5, rate: 1.5, loop: true))
        XCTAssertEqual(out.calls, [.start(voice: 1, asset: "a", gain: 0.2, rate: 1.5, loop: true)])
        XCTAssertEqual(m.voices["p1"]?.handle, 1)
        XCTAssertEqual(m.voices["p1"]?.bus, "sfx")
        XCTAssertEqual(m.voices["p1"]?.soundVolume, 0.5)
    }

    func testFadeInFadeAndStop() {
        let out = RecordingOutput()
        let m = OpenBoneAudioMixer(assets: assets, buses: buses, master: 1, output: out)
        m.handle(play("p1", volume: 1, fadeIn: 0.25))
        // A fade gives the sound's new volume; the voice keeps its bus gain.
        m.handle(.fade(id: "p1", volume: 0.2, duration: 1))
        m.handle(.fade(id: "nope", volume: 1, duration: 1))
        m.handle(.stop(id: "p1", fade: 0.5))
        m.handle(.stop(id: "p1", fade: 0.5))
        XCTAssertEqual(out.calls, [
            .start(voice: 1, asset: "a", gain: 0, rate: 1, loop: false),
            .gain(voice: 1, gain: 0.5, duration: 0.25),
            .gain(voice: 1, gain: 0.1, duration: 1),
            .stop(voice: 1, fade: 0.5),
        ])
        XCTAssertTrue(m.voices.isEmpty)
    }

    func testVolumeAppliesToPlayingVoices() {
        let out = RecordingOutput()
        let m = OpenBoneAudioMixer(assets: assets, buses: buses, master: 1, output: out)
        m.handle(play("p1", volume: 0.5))
        out.calls = []
        m.volume = 0.5
        XCTAssertEqual(out.calls, [.gain(voice: 1, gain: 0.125, duration: 0)])
    }

    func testMuteButtons() {
        // mix commands (setMute listener actions): a bus goes silent and comes back; muting everything silences all,
        // also sounds started afterwards; a bus the document mutes can be unmuted. (Voices re-gain in any order.)
        let out = RecordingOutput()
        let m = OpenBoneAudioMixer(assets: assets, buses: buses, master: 0.8, output: out)
        m.handle(play("p1", volume: 0.5, loop: true))
        m.handle(play("p2", asset: "b", bus: nil, loop: true))
        func step(_ c: OpenBoneAudioCommand, _ want: [RecordingOutput.Call]) {
            out.calls = []
            m.handle(c)
            XCTAssertEqual(Set(out.calls.map { "\($0)" }), Set(want.map { "\($0)" }), "\(c)")
        }
        step(.mix(bus: "sfx", muted: true), [.gain(voice: 1, gain: 0, duration: 0), .gain(voice: 2, gain: 0.8, duration: 0)])
        step(.mix(bus: "sfx", muted: false), [.gain(voice: 1, gain: 0.2, duration: 0), .gain(voice: 2, gain: 0.8, duration: 0)])
        step(.mix(bus: nil, muted: true), [.gain(voice: 1, gain: 0, duration: 0), .gain(voice: 2, gain: 0, duration: 0)])
        step(play("p3", bus: nil), [.start(voice: 3, asset: "a", gain: 0, rate: 1, loop: false)])
        m.handle(.mix(bus: nil, muted: false))
        m.handle(.mix(bus: "muted", muted: false))
        XCTAssertEqual(m.busGain("muted"), 0.8, accuracy: 1e-12)
        XCTAssertEqual(OpenBoneAudioCommand.mix(bus: "sfx", muted: true).id, "")
    }

    func testVoiceBookkeeping() {
        let out = RecordingOutput()
        out.failing = ["b"]
        let m = OpenBoneAudioMixer(assets: assets, buses: buses, master: 1, output: out)
        m.handle(play("x", asset: "missing"))  // unknown asset: nothing starts
        m.handle(play("y", asset: "b"))         // the output cannot play it: forgotten
        XCTAssertTrue(m.voices.isEmpty)
        m.handle(play("p1"))
        m.handle(play("p2", bus: nil))
        m.handle(play("p1"))                    // the same id again replaces the old voice
        XCTAssertEqual(out.calls.suffix(4), [
            .start(voice: 2, asset: "a", gain: 0.5, rate: 1, loop: false),
            .start(voice: 3, asset: "a", gain: 1, rate: 1, loop: false),
            .stop(voice: 2, fade: 0),
            .start(voice: 4, asset: "a", gain: 0.5, rate: 1, loop: false),
        ])
        m.voiceFinished(3)
        XCTAssertEqual(Set(m.voices.keys), ["p1"])
        m.handle(.stop(id: "p2", fade: 0))      // already finished: no call
        out.calls = []
        m.stopAll(fade: 0.1)
        XCTAssertEqual(out.calls, [.stop(voice: 4, fade: 0.1)])
        XCTAssertTrue(m.voices.isEmpty)
    }

    func testInstanceCommandsDriveTheMixer() throws {
        // The button's state machine plays its hover sound when the pointer enters: route onAudio into a mixer.
        let doc = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("examples/button.obone"))
        let inst = try OpenBoneInstance(document: doc)
        let out = RecordingOutput()
        let mixer = OpenBoneAudioMixer(document: doc, output: out)
        var commands = 0
        inst.onAudio = {
            commands += 1
            mixer.handle($0)
        }
        try inst.useStateMachine()
        inst.advance(0)
        let a = doc.artboard
        for (type, x, y) in [(OpenBonePointerType.move, 0.0, 0.0), (.move, a.width / 2, a.height / 2),
                             (.down, a.width / 2, a.height / 2), (.up, a.width / 2, a.height / 2)] {
            try inst.pointer(type, artboardX: x, artboardY: y)
            inst.advance(1.0 / 60)
        }
        for _ in 0 ..< 60 { inst.advance(1.0 / 60) }
        XCTAssertGreaterThan(commands, 0, "the button plays sounds on hover / click")
        let starts = out.calls.filter { if case .start = $0 { return true } else { return false } }
        XCTAssertFalse(starts.isEmpty)
        let ids = Set(doc.audioAssets.map(\.id))
        for case let .start(_, asset, gain, _, _) in starts {
            XCTAssertTrue(ids.contains(asset))
            XCTAssertGreaterThan(gain, 0)
        }
    }
}
