// OpenBoneAudio: plays a document's audio commands with AVFoundation (one AVAudioPlayer per voice).
// Apple platforms only. NOT run on Apple hardware by the package's own tests (they run on Linux); see README.
// SPDX-License-Identifier: MIT
#if canImport(AVFoundation)
import AVFoundation
import Foundation

/// Plays a document's sounds: each file is read once (a `data:` URL or a path relative to the document), and every
/// voice follows its command's volume × bus × master, rate (0.5…2, AVAudioPlayer's range), looping, fade-in, stop
/// fades and fades.
///
/// `OpenBoneView` makes one for its instance (`isAudioEnabled`, on by default). Use it directly with an instance of
/// your own:
///
///     let audio = OpenBoneAudio(document: doc)
///     inst.onAudio = { audio.handle($0) }
///
/// Use it from the main thread. It does not configure `AVAudioSession`; set the category your app needs (the
/// default, `.soloAmbient`, silences other apps' audio and follows the ring / silent switch).
public final class OpenBoneAudio {
    public let document: OpenBoneDocument
    public let mixer: OpenBoneAudioMixer
    private let output: AVAudioPlayerOutput

    /// Extra gain on everything this player plays.
    public var volume: Double {
        get { mixer.volume }
        set { mixer.volume = newValue }
    }

    public init(document: OpenBoneDocument) {
        self.document = document
        output = AVAudioPlayerOutput(document: document)
        mixer = OpenBoneAudioMixer(document: document, output: output)
        output.mixer = mixer
    }

    deinit { mixer.stopAll() }

    /// Handles one audio command (give it everything `OpenBoneInstance.onAudio` receives).
    public func handle(_ command: OpenBoneAudioCommand) { mixer.handle(command) }

    /// Stops every voice this player started.
    public func stopAll(fade: Double = 0) { mixer.stopAll(fade: fade) }
}

/// An `OpenBoneAudioOutput` with an AVAudioPlayer per voice (fades through `setVolume(_:fadeDuration:)`).
final class AVAudioPlayerOutput: NSObject, OpenBoneAudioOutput, AVAudioPlayerDelegate {
    weak var mixer: OpenBoneAudioMixer?
    private let document: OpenBoneDocument
    /// File bytes by asset id (nil = could not be read; not retried).
    private var files: [String: Data?] = [:]
    private var players: [Int: AVAudioPlayer] = [:]
    private var voiceOf: [ObjectIdentifier: Int] = [:]

    init(document: OpenBoneDocument) {
        self.document = document
    }

    private func bytes(_ asset: OpenBoneDocument.AudioAsset) -> Data? {
        if let cached = files[asset.id] { return cached }
        let data = document.audioData(for: asset.source)
        if data == nil { NSLog("OpenBone: cannot read sound \"%@\" (%@)", asset.name, String(asset.source.prefix(80))) }
        files[asset.id] = .some(data)
        return data
    }

    func startVoice(_ voice: Int, asset: OpenBoneDocument.AudioAsset, gain: Double, rate: Double, loop: Bool) -> Bool {
        guard let data = bytes(asset) else { return false }
        let player: AVAudioPlayer
        do {
            player = try AVAudioPlayer(data: data)
        } catch {
            NSLog("OpenBone: cannot decode sound \"%@\": %@", asset.name, error.localizedDescription)
            files[asset.id] = .some(nil)
            return false
        }
        player.delegate = self
        player.numberOfLoops = loop ? -1 : 0
        if rate != 1 {
            player.enableRate = true  // before prepareToPlay
            player.rate = Float(min(max(rate, 0.5), 2))
        }
        player.volume = Float(gain)
        player.prepareToPlay()
        guard player.play() else { return false }
        players[voice] = player
        voiceOf[ObjectIdentifier(player)] = voice
        return true
    }

    func setVoiceGain(_ voice: Int, to gain: Double, duration: Double) {
        guard let p = players[voice] else { return }
        if duration > 0 { p.setVolume(Float(gain), fadeDuration: duration) } else { p.volume = Float(gain) }
    }

    func stopVoice(_ voice: Int, fade: Double) {
        guard let p = players.removeValue(forKey: voice) else { return }
        voiceOf.removeValue(forKey: ObjectIdentifier(p))
        guard fade > 0, p.isPlaying else {
            p.stop()
            return
        }
        p.setVolume(0, fadeDuration: fade)
        // The closure keeps the player alive until its fade-out is done.
        DispatchQueue.main.asyncAfter(deadline: .now() + fade) { p.stop() }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        let finish = { [weak self] in
            guard let self, let voice = self.voiceOf.removeValue(forKey: id) else { return }
            self.players.removeValue(forKey: voice)
            self.mixer?.voiceFinished(voice)
        }
        if Thread.isMainThread { finish() } else { DispatchQueue.main.async(execute: finish) }
    }
}
#endif
