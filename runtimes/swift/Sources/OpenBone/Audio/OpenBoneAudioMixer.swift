// OpenBoneAudioMixer: the platform-neutral half of sound playback — gain (command volume × bus × master), voice
// bookkeeping (command ids → voices), fade-in, stop fades and fades — driving an OpenBoneAudioOutput that makes noise.
// Builds everywhere (tested on Linux with a recording output); OpenBoneAudio pairs it with AVFoundation.
// SPDX-License-Identifier: MIT

/// What actually plays sounds. Voices are numbered by the mixer; a voice that ends by itself (a one-shot reaching its
/// end) must be reported back with `OpenBoneAudioMixer.voiceFinished(_:)`.
public protocol OpenBoneAudioOutput: AnyObject {
    /// Starts `asset` as voice `voice` at linear `gain`. Returns false when it cannot be played (missing or
    /// undecodable file); the mixer then forgets the voice.
    func startVoice(_ voice: Int, asset: OpenBoneDocument.AudioAsset, gain: Double, rate: Double, loop: Bool) -> Bool
    /// Ramps a voice's gain linearly to `gain` over `duration` seconds (0 = now).
    func setVoiceGain(_ voice: Int, to gain: Double, duration: Double)
    /// Stops a voice, fading it to silence over `fade` seconds first (0 = now).
    func stopVoice(_ voice: Int, fade: Double)
}

/// Turns a document's audio commands into calls on an `OpenBoneAudioOutput`.
///
/// The gain of a voice is `command volume × bus volume (0 when muted) × master (0 when the document is muted) ×
/// volume`. A `fade` command gives the sound's new volume; the voice keeps its bus and master gain.
public final class OpenBoneAudioMixer {
    public struct Voice: Equatable {
        /// The output's voice number.
        public var handle: Int
        public var bus: String?
        /// The sound's own volume (the command's, then the last fade's target).
        public var soundVolume: Double
    }

    public let assets: [OpenBoneDocument.AudioAsset]
    public let buses: [OpenBoneDocument.AudioBus]
    /// The document's master volume (0 when its audio is muted).
    public let master: Double
    public let output: OpenBoneAudioOutput

    /// Extra gain on everything this mixer plays; changing it applies to the playing voices at once.
    public var volume: Double = 1 {
        didSet {
            for v in voices.values { output.setVoiceGain(v.handle, to: v.soundVolume * busGain(v.bus), duration: 0) }
        }
    }

    /// Playing voices by command id.
    public private(set) var voices: [String: Voice] = [:]
    private var nextHandle = 1

    public init(assets: [OpenBoneDocument.AudioAsset], buses: [OpenBoneDocument.AudioBus], master: Double,
                output: OpenBoneAudioOutput) {
        self.assets = assets
        self.buses = buses
        self.master = master
        self.output = output
    }

    public convenience init(document: OpenBoneDocument, output: OpenBoneAudioOutput) {
        self.init(assets: document.audioAssets, buses: document.audioBuses, master: document.audioMaster, output: output)
    }

    /// `master × bus volume × volume` (0 when the bus is muted; an unknown or nil bus counts as 1).
    public func busGain(_ bus: String?) -> Double {
        var gain = master * volume
        if let bus, let b = buses.first(where: { $0.id == bus }) { gain *= b.isMuted ? 0 : b.volume }
        return gain
    }

    /// Handles one audio command (hand it everything `OpenBoneInstance.onAudio` receives).
    public func handle(_ command: OpenBoneAudioCommand) {
        switch command {
        case let .play(id, _, assetID, bus, volume, rate, loop, fadeIn, _):
            if let old = voices.removeValue(forKey: id) { output.stopVoice(old.handle, fade: 0) }
            guard let asset = assets.first(where: { $0.id == assetID }) else { return }
            let target = volume * busGain(bus)
            let handle = nextHandle
            nextHandle += 1
            guard output.startVoice(handle, asset: asset, gain: fadeIn > 0 ? 0 : target, rate: rate > 0 ? rate : 0.01,
                                    loop: loop) else { return }
            if fadeIn > 0 { output.setVoiceGain(handle, to: target, duration: fadeIn) }
            voices[id] = Voice(handle: handle, bus: bus, soundVolume: volume)
        case let .stop(id, fade):
            guard let v = voices.removeValue(forKey: id) else { return }
            output.stopVoice(v.handle, fade: max(0, fade))
        case let .fade(id, volume, duration):
            guard var v = voices[id] else { return }
            v.soundVolume = volume
            voices[id] = v
            output.setVoiceGain(v.handle, to: volume * busGain(v.bus), duration: max(0, duration))
        }
    }

    /// The output reports that a voice ended by itself.
    public func voiceFinished(_ handle: Int) {
        if let id = voices.first(where: { $0.value.handle == handle })?.key { voices.removeValue(forKey: id) }
    }

    /// Stops every voice (fading out over `fade` seconds).
    public func stopAll(fade: Double = 0) {
        let playing = voices.values
        voices.removeAll()
        for v in playing { output.stopVoice(v.handle, fade: fade) }
    }
}
