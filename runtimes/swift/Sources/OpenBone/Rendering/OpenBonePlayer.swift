// OpenBonePlayer: SwiftUI wrapper around OpenBoneView (UIViewRepresentable / NSViewRepresentable).
// Apple platforms only. NOT run on Apple hardware by the package's own tests (they run on Linux); see README.
// SPDX-License-Identifier: MIT
#if canImport(SwiftUI) && canImport(MetalKit) && (canImport(UIKit) || canImport(AppKit))
import MetalKit
import SwiftUI

/// Plays an `OpenBoneInstance` in SwiftUI. Drive it through the instance (inputs, triggers, animations, callbacks);
/// the view advances and draws it every frame and forwards touches / the mouse to the state machine.
///
///     let inst = try OpenBoneInstance(document: doc)
///     try inst.useStateMachine()
///     OpenBonePlayer(instance: inst).frame(height: 300)
public struct OpenBonePlayer {
    public var instance: OpenBoneInstance
    public var fit: OpenBoneViewport.Fit
    public var framing: OpenBoneFraming
    public var speed: Double
    public var isPaused: Bool
    public var isPointerEnabled: Bool
    /// Play the document's sounds (`OpenBoneView.isAudioEnabled`); `instance.onAudio` gets the commands either way.
    public var isAudioEnabled: Bool
    public var onFrame: ((OpenBoneInstance, Double) -> Void)?

    public init(instance: OpenBoneInstance, fit: OpenBoneViewport.Fit = .contain, framing: OpenBoneFraming = .artboard,
                speed: Double = 1, isPaused: Bool = false, isPointerEnabled: Bool = true, isAudioEnabled: Bool = true,
                onFrame: ((OpenBoneInstance, Double) -> Void)? = nil) {
        self.instance = instance
        self.fit = fit
        self.framing = framing
        self.speed = speed
        self.isPaused = isPaused
        self.isPointerEnabled = isPointerEnabled
        self.isAudioEnabled = isAudioEnabled
        self.onFrame = onFrame
    }

    @MainActor
    func makeView() -> OpenBoneView {
        let v = OpenBoneView(device: MTLCreateSystemDefaultDevice())
        update(v)
        return v
    }

    @MainActor
    func update(_ v: OpenBoneView) {
        v.isAudioEnabled = isAudioEnabled  // before the instance, whose first advance may already play sounds
        if v.instance !== instance { v.instance = instance }
        v.fit = fit
        v.framing = framing
        v.speed = speed
        v.isPaused = isPaused
        v.isPointerEnabled = isPointerEnabled
        v.onFrame = onFrame
    }
}

#if canImport(UIKit)
extension OpenBonePlayer: UIViewRepresentable {
    public func makeUIView(context: Context) -> OpenBoneView { makeView() }
    public func updateUIView(_ view: OpenBoneView, context: Context) { update(view) }
}
#else
extension OpenBonePlayer: NSViewRepresentable {
    public func makeNSView(context: Context) -> OpenBoneView { makeView() }
    public func updateNSView(_ view: OpenBoneView, context: Context) { update(view) }
}
#endif
#endif
