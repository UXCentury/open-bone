// OpenBoneView: an MTKView that advances an instance every frame, draws it with OpenBoneMetalRenderer and forwards
// touches (UIKit) or the mouse (AppKit) to the state machine's listeners.
// Apple platforms only. NOT run on Apple hardware by the package's own tests (they run on Linux); see README.
// SPDX-License-Identifier: MIT
#if canImport(MetalKit) && (canImport(UIKit) || canImport(AppKit))
import Metal
import MetalKit
import QuartzCore
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// What part of skeleton space the view frames.
public enum OpenBoneFraming: Equatable {
    /// The document's artboard (stable while animating; the editor's framing).
    case artboard
    /// The current pose's bounds, measured once when the instance is set.
    case bounds
    /// A fixed rectangle in skeleton space.
    case rect(OpenBoneRect)
}

open class OpenBoneView: MTKView, MTKViewDelegate {
    /// The instance drawn and advanced. Setting it resets the frame clock.
    public var instance: OpenBoneInstance? {
        didSet {
            if oldValue !== instance {
                oldValue?.hostAudio = nil
                bindAudio()
            }
            lastTime = nil
            instance?.advance(0)
            frozenBounds = instance?.bounds
            setNeedsDisplayCompat()
        }
    }

    public var fit: OpenBoneViewport.Fit = .contain
    public var framing: OpenBoneFraming = .artboard
    /// Time scale (1 = real time, 0 = frozen).
    public var speed: Double = 1
    /// Forward touches / mouse to the running state machine.
    public var isPointerEnabled = true
    /// Called after every advance, before drawing (on the main thread).
    public var onFrame: ((OpenBoneInstance, Double) -> Void)?
    /// Play the document's sounds through `audio` (on by default). When false nothing is played, and
    /// `instance.onAudio` still receives every command either way.
    public var isAudioEnabled = true {
        didSet { if oldValue != isAudioEnabled { bindAudio() } }
    }
    /// The player of the current instance's sounds (nil when audio is disabled or there is no instance).
    public private(set) var audio: OpenBoneAudio?

    public private(set) var renderer: OpenBoneMetalRenderer?
    public private(set) var viewport = OpenBoneViewport(scaleX: 1, scaleY: 1, originX: 0, originY: 0, width: 1, height: 1)
    private var mesh = OpenBoneRenderMesh()
    private var commandQueue: MTLCommandQueue?
    private var lastTime: CFTimeInterval?
    private var frozenBounds: OpenBoneRect?
    private var pointerDown = false

    override public init(frame frameRect: CGRect, device: MTLDevice?) {
        super.init(frame: frameRect, device: device)
        setUp()
    }

    /// A view on the system default Metal device.
    public convenience init(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        self.init(frame: .zero, device: device)
    }

    /// A view playing `animation` (or running `stateMachine`, or the document's first state machine / animation).
    public convenience init(document: OpenBoneDocument, animation: String? = nil, stateMachine: String? = nil,
                            skin: String? = nil) throws {
        self.init(frame: .zero, device: MTLCreateSystemDefaultDevice())
        let inst = try OpenBoneInstance(document: document)
        if let skin { try inst.setSkin(skin) }
        if let animation { try inst.play(animation) }
        else if let stateMachine { try inst.useStateMachine(stateMachine) }
        else if !document.stateMachines.isEmpty { try inst.useStateMachine() }
        else if let first = document.animations.first { try inst.play(first.name) }
        instance = inst
    }

    public required init(coder: NSCoder) {
        super.init(coder: coder)
        if device == nil { device = MTLCreateSystemDefaultDevice() }
        setUp()
    }

    private func setUp() {
        delegate = self
        colorPixelFormat = .bgra8Unorm
        depthStencilPixelFormat = .stencil8
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        preferredFramesPerSecond = 60
        #if canImport(UIKit)
        isOpaque = false
        backgroundColor = .clear
        isMultipleTouchEnabled = false
        #else
        layer?.isOpaque = false
        #endif
        guard let device else { return }
        commandQueue = device.makeCommandQueue()
        renderer = try? OpenBoneMetalRenderer(device: device, colorPixelFormat: colorPixelFormat,
                                              stencilPixelFormat: depthStencilPixelFormat)
    }

    private func bindAudio() {
        audio?.stopAll()
        audio = nil
        guard let inst = instance else { return }
        guard isAudioEnabled else {
            inst.hostAudio = nil
            return
        }
        let player = OpenBoneAudio(document: inst.document)
        audio = player
        inst.hostAudio = { [weak player] in player?.handle($0) }
    }

    private func setNeedsDisplayCompat() {
        #if canImport(UIKit)
        setNeedsDisplay()
        #else
        needsDisplay = true
        #endif
    }

    private var contentsScaleFactor: Double {
        #if canImport(UIKit)
        return Double(contentScaleFactor)
        #else
        return Double(window?.backingScaleFactor ?? 2)
        #endif
    }

    private func contentRect(_ inst: OpenBoneInstance) -> OpenBoneRect {
        switch framing {
        case .artboard:
            let r = inst.document.artboard.skeletonRect
            return r.isEmpty ? (frozenBounds ?? inst.bounds) : r
        case .bounds: return frozenBounds ?? inst.bounds
        case let .rect(r): return r
        }
    }

    // MARK: MTKViewDelegate

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    public func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let dt = lastTime.map { min(now - $0, 0.25) } ?? 0
        lastTime = now
        guard let inst = instance else { return }
        inst.advance(dt * speed)
        onFrame?(inst, dt * speed)
        viewport = OpenBoneViewport(content: contentRect(inst), width: Double(bounds.width), height: Double(bounds.height), fit: fit)
        mesh.build(from: inst)
        guard let renderer, let queue = commandQueue, let pass = currentRenderPassDescriptor,
              let drawable = currentDrawable, let buffer = queue.makeCommandBuffer(),
              let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        renderer.contentsScale = contentsScaleFactor
        renderer.encode(mesh, document: inst.document, viewport: viewport, into: encoder)
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
        // The renderer reuses one vertex buffer; wait so the next frame does not overwrite it while the GPU reads.
        buffer.waitUntilCompleted()
    }

    // MARK: Pointer

    /// Sends a pointer event at a view point (points, origin top-left).
    public func sendPointer(_ type: OpenBonePointerType, at point: CGPoint) {
        guard isPointerEnabled, let inst = instance, inst.isRunningStateMachine else { return }
        let p = viewport.toSkeleton(OpenBonePoint(x: Double(point.x), y: Double(point.y)))
        try? inst.pointer(type, x: p.x, y: p.y)
    }

    // Leaving the window silences the view (like a game node leaving the scene tree).
    #if canImport(UIKit)
    override open func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { audio?.stopAll() }
    }
    #else
    override open func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { audio?.stopAll() }
    }
    #endif

    #if canImport(UIKit)
    override open func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let t = touches.first { sendPointer(.down, at: t.location(in: self)) }
        super.touchesBegan(touches, with: event)
    }

    override open func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let t = touches.first { sendPointer(.move, at: t.location(in: self)) }
        super.touchesMoved(touches, with: event)
    }

    override open func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let t = touches.first { sendPointer(.up, at: t.location(in: self)) }
        super.touchesEnded(touches, with: event)
    }

    override open func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let t = touches.first { sendPointer(.up, at: t.location(in: self)) }
        super.touchesCancelled(touches, with: event)
    }
    #else
    private var trackingArea: NSTrackingArea?

    override open func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingArea { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingArea = t
    }

    /// AppKit views are y up unless flipped; the viewport is y down.
    private func viewPoint(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return isFlipped ? p : CGPoint(x: p.x, y: bounds.height - p.y)
    }

    override open func mouseDown(with event: NSEvent) { sendPointer(.down, at: viewPoint(event)) }
    override open func mouseDragged(with event: NSEvent) { sendPointer(.move, at: viewPoint(event)) }
    override open func mouseUp(with event: NSEvent) { sendPointer(.up, at: viewPoint(event)) }
    override open func mouseMoved(with event: NSEvent) { sendPointer(.move, at: viewPoint(event)) }
    override open var acceptsFirstResponder: Bool { true }
    override open func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    #endif
}
#endif
