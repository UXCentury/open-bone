// OpenBoneInstance: a posed, playing skeleton (ob_instance) — animations, state machines, input, draw list.
// SPDX-License-Identifier: MIT
import COpenBone

/// Closures the C callbacks forward to. Owned by the instance; the C side holds an unretained pointer to it, which
/// is safe because callbacks only fire inside calls on the instance and the handle is freed before the box.
final class CallbackBox {
    var onEvent: ((OpenBoneEvent) -> Void)?
    var onAudio: ((OpenBoneAudioCommand) -> Void)?
    /// The view's sound player (`OpenBoneView`); called after `onAudio`.
    var hostAudio: ((OpenBoneAudioCommand) -> Void)?
    var onStateChange: ((_ layer: String, _ from: String?, _ to: String) -> Void)?
    var onLog: ((_ message: String, _ isError: Bool) -> Void)?
}

private func box(_ user: UnsafeMutableRawPointer?) -> CallbackBox? {
    user.map { Unmanaged<CallbackBox>.fromOpaque($0).takeUnretainedValue() }
}

private let eventTrampoline: ob_event_fn = { user, event in
    guard let event, let f = box(user)?.onEvent else { return }
    f(OpenBoneEvent(event.pointee))
}

private let audioTrampoline: ob_audio_fn = { user, command in
    guard let command, let b = box(user), b.onAudio != nil || b.hostAudio != nil else { return }
    let c = OpenBoneAudioCommand(command.pointee)
    b.onAudio?(c)
    b.hostAudio?(c)
}

private let stateTrampoline: ob_state_fn = { user, layer, from, to in
    guard let f = box(user)?.onStateChange else { return }
    f(optionalString(layer) ?? "", optionalString(from), optionalString(to) ?? "")
}

private let logTrampoline: ob_log_fn = { user, message, isError in
    guard let f = box(user)?.onLog else { return }
    f(optionalString(message) ?? "", isError != 0)
}

/// A skeleton instance of a document: plays animations on tracks or runs a state machine, takes input and pointer
/// events, and produces a draw list. Not thread-safe; use one instance from one thread at a time (different
/// instances may run on different threads). Freed when the last reference goes away.
public final class OpenBoneInstance {
    public let document: OpenBoneDocument
    let handle: OpaquePointer
    private let callbacks = CallbackBox()

    /// - Parameter scripts: run the document's scripts in the embedded QuickJS sandbox (ignored when the package
    ///   was built without QuickJS, see `OpenBoneRuntime.hasScripts`).
    public init(document: OpenBoneDocument, scripts: Bool = true) throws {
        guard let h = ob_instance_create(document.handle, scripts ? OB_INSTANCE_SCRIPTS : 0) else {
            throw OpenBoneError.last("cannot create instance")
        }
        self.document = document
        handle = h
        let user = Unmanaged.passUnretained(callbacks).toOpaque()
        ob_instance_set_event_callback(h, eventTrampoline, user)
        ob_instance_set_audio_callback(h, audioTrampoline, user)
        ob_instance_set_state_callback(h, stateTrampoline, user)
        ob_instance_set_log_callback(h, logTrampoline, user)
    }

    deinit { ob_instance_free(handle) }

    // MARK: Callbacks

    /// Events fired during `advance` (animation keys, listeners, scripts).
    public var onEvent: ((OpenBoneEvent) -> Void)? {
        get { callbacks.onEvent }
        set { callbacks.onEvent = newValue }
    }

    /// Audio commands (play / stop / fade). `OpenBoneView` plays them itself (see `isAudioEnabled`) and this
    /// callback receives them either way; without a view, pass them to an `OpenBoneAudio` or your own engine.
    public var onAudio: ((OpenBoneAudioCommand) -> Void)? {
        get { callbacks.onAudio }
        set { callbacks.onAudio = newValue }
    }

    /// Set by `OpenBoneView` to its `OpenBoneAudio`; independent of `onAudio`.
    var hostAudio: ((OpenBoneAudioCommand) -> Void)? {
        get { callbacks.hostAudio }
        set { callbacks.hostAudio = newValue }
    }

    /// State-machine layer transitions: layer, previous state (nil at start), new state.
    public var onStateChange: ((_ layer: String, _ from: String?, _ to: String) -> Void)? {
        get { callbacks.onStateChange }
        set { callbacks.onStateChange = newValue }
    }

    /// Script `ob.log` output and script errors.
    public var onLog: ((_ message: String, _ isError: Bool) -> Void)? {
        get { callbacks.onLog }
        set { callbacks.onLog = newValue }
    }

    /// The last error the runtime recorded on this thread (e.g. a script failure inside `advance`), or "".
    public var lastError: String { String(cString: ob_last_error()) }

    // MARK: Skin and placement

    /// Sets the skin by name or id; nil = none (default skin attachments only).
    public func setSkin(_ skin: String?) throws {
        let r = skin.map { s in s.withCString { ob_instance_set_skin(handle, $0) } } ?? ob_instance_set_skin(handle, nil)
        try check(r, "cannot set skin")
    }

    /// Skeleton placement, applied to root bones. Defaults: 0, 0, 1, 1.
    public func setTransform(x: Double = 0, y: Double = 0, scaleX: Double = 1, scaleY: Double = 1) {
        ob_instance_set_transform(handle, x, y, scaleX, scaleY)
    }

    // MARK: Animations

    /// Plays an animation on a track (stops a running state machine), cross-fading from what was playing.
    public func play(_ animation: String, loop: Bool = true, track: Int = 0) throws {
        try check(animation.withCString { ob_instance_play(handle, $0, loop ? 1 : 0, Int32(track)) },
                  "cannot play \(animation)")
    }

    /// Queues an animation after the current one completes (or after `delay` seconds when > 0).
    public func queue(_ animation: String, loop: Bool = false, track: Int = 0, delay: Double = 0) throws {
        try check(animation.withCString { ob_instance_queue(handle, $0, loop ? 1 : 0, Int32(track), delay) },
                  "cannot queue \(animation)")
    }

    public func clearTracks() { ob_instance_clear_tracks(handle) }

    // MARK: State machines

    /// Starts a state machine by name or id (nil = the document's first).
    public func useStateMachine(_ name: String? = nil) throws {
        let r = name.map { n in n.withCString { ob_instance_use_state_machine(handle, $0) } }
            ?? ob_instance_use_state_machine(handle, nil)
        try check(r, "cannot start state machine")
    }

    public func setInput(_ input: String, _ value: Bool) throws {
        try check(input.withCString { ob_instance_set_bool(handle, $0, value ? 1 : 0) }, "cannot set \(input)")
    }

    public func setInput(_ input: String, _ value: Double) throws {
        try check(input.withCString { ob_instance_set_number(handle, $0, value) }, "cannot set \(input)")
    }

    public func setInput(_ input: String, _ value: String) throws {
        let r = input.withCString { i in value.withCString { ob_instance_set_string(handle, i, $0) } }
        try check(r, "cannot set \(input)")
    }

    public func setInput(_ input: String, _ value: OpenBoneValue) throws {
        switch value {
        case let .bool(b): try setInput(input, b)
        case let .number(n): try setInput(input, n)
        case let .string(s): try setInput(input, s)
        }
    }

    /// Fires a trigger input.
    public func fire(_ trigger: String) throws {
        try check(trigger.withCString { ob_instance_fire(handle, $0) }, "cannot fire \(trigger)")
    }

    /// Mutes, unmutes or toggles (`nil`) a sound bus by name or id ("music"), or the master with `nil` / "master", e.g.
    /// from music and sound-effect buttons outside the artboard. Same as a mute-button listener (and a bool input that
    /// owns the bus follows). Returns the new state, or nil when there is no such bus.
    @discardableResult
    public func setBusMuted(_ bus: String?, _ muted: Bool? = true) -> Bool? {
        let m: Int32 = muted.map { $0 ? 1 : 0 } ?? -1
        let r = bus.map { b in b.withCString { ob_instance_set_bus_muted(handle, $0, m) } } ?? ob_instance_set_bus_muted(handle, nil, m)
        return r < 0 ? nil : r == 1
    }

    /// Whether a bus (name or id; `nil` / "master" = the master) is muted now, or nil when there is no such bus.
    public func isBusMuted(_ bus: String?) -> Bool? {
        let r = bus.map { b in b.withCString { ob_instance_bus_muted(handle, $0) } } ?? ob_instance_bus_muted(handle, nil)
        return r < 0 ? nil : r == 1
    }

    /// Current value of a state-machine input, or nil (no machine running, unknown input).
    public func input(_ name: String) -> OpenBoneValue? {
        var v = ob_value()
        guard name.withCString({ ob_instance_get_input(handle, $0, &v) }) != 0 else { return nil }
        return OpenBoneValue(v)
    }

    /// A pointer event in skeleton space (y up), processed by the next `advance`. Throws when no state machine runs.
    public func pointer(_ type: OpenBonePointerType, x: Double, y: Double) throws {
        try check(ob_instance_pointer(handle, type.c, x, y), "pointer event rejected")
    }

    /// A pointer event in artboard coordinates (y down, origin top-left).
    public func pointer(_ type: OpenBonePointerType, artboardX: Double, artboardY: Double) throws {
        let p = document.artboardToSkeleton(x: artboardX, y: artboardY)
        try pointer(type, x: p.x, y: p.y)
    }

    public struct LayerState: Equatable {
        public var layer: String
        /// The active state ("exit", a state name), or nil.
        public var state: String?
    }

    /// The active state per state-machine layer (empty when no state machine runs).
    public var activeStates: [LayerState] {
        (0 ..< Int(ob_instance_layer_count(handle))).compactMap { i in
            var layer: UnsafePointer<CChar>?
            var state: UnsafePointer<CChar>?
            guard ob_instance_active_state(handle, Int32(i), &layer, &state) != 0 else { return nil }
            return LayerState(layer: optionalString(layer) ?? "", state: optionalString(state))
        }
    }

    /// True while a state machine runs (rather than animation tracks).
    public var isRunningStateMachine: Bool { ob_instance_layer_count(handle) > 0 }

    /// Shows fixed text (or a `{template}`) in a slot's text attachment; nil restores the attachment's own text.
    public func setText(slot: String, _ text: String?) throws {
        let r = slot.withCString { s in
            text.map { t in t.withCString { ob_instance_set_text(handle, s, $0) } } ?? ob_instance_set_text(handle, s, nil)
        }
        try check(r, "cannot set text of \(slot)")
    }

    // MARK: Time

    /// Steps time by `dt` seconds and poses the skeleton (fires callbacks). `advance(0)` poses without moving time.
    public func advance(_ dt: Double) { ob_instance_advance(handle, dt) }

    // MARK: Pose

    public var boneCount: Int { Int(ob_instance_bone_count(handle)) }

    public func bone(at index: Int) -> OpenBoneBone? {
        var b = ob_bone_info()
        guard ob_instance_bone(handle, Int32(index), &b) != 0 else { return nil }
        return OpenBoneBone(name: optionalString(b.name) ?? "", parent: optionalString(b.parent), length: b.length,
                            world: OpenBoneMatrix(a: b.a, b: b.b, c: b.c, d: b.d, tx: b.x, ty: b.y), active: b.active != 0)
    }

    public func bone(named name: String) -> OpenBoneBone? {
        let i = name.withCString { ob_instance_find_bone(handle, $0) }
        return i >= 0 ? bone(at: Int(i)) : nil
    }

    /// Bones in document order.
    public var bones: [OpenBoneBone] { (0 ..< boneCount).compactMap { bone(at: $0) } }

    public var slotCount: Int { Int(ob_instance_slot_count(handle)) }

    public func slot(at index: Int) -> OpenBoneSlot? {
        var s = ob_slot_info()
        guard ob_instance_slot(handle, Int32(index), &s) != 0 else { return nil }
        return OpenBoneSlot(name: optionalString(s.name) ?? "", bone: optionalString(s.bone) ?? "",
                            attachment: optionalString(s.attachment),
                            color: SIMD4(s.color.0, s.color.1, s.color.2, s.color.3),
                            dark: s.has_dark != 0 ? SIMD3(s.dark.0, s.dark.1, s.dark.2) : nil,
                            blend: OpenBoneBlendMode(s.blend))
    }

    public func slot(named name: String) -> OpenBoneSlot? {
        let i = name.withCString { ob_instance_find_slot(handle, $0) }
        return i >= 0 ? slot(at: Int(i)) : nil
    }

    /// Slots in document (setup) order.
    public var slots: [OpenBoneSlot] { (0 ..< slotCount).compactMap { slot(at: $0) } }

    /// Bounds of the drawn geometry and bones (skeleton space).
    public var bounds: OpenBoneRect {
        var b = [Double](repeating: 0, count: 4)
        b.withUnsafeMutableBufferPointer { ob_instance_bounds(handle, $0.baseAddress) }
        return OpenBoneRect(minX: b[0], minY: b[1], maxX: b[2], maxY: b[3])
    }

    // MARK: Draw list

    /// Rebuilds the draw list from the current pose and lends it to `body` without copying. The views and their
    /// buffers must not escape the closure.
    public func withDrawList<R>(_ body: (OpenBoneDrawListView) throws -> R) rethrows -> R {
        let n = Int(ob_instance_update_draw_list(handle))
        return try body(OpenBoneDrawListView(handle: handle, count: n, clipCount: Int(ob_instance_clip_count(handle))))
    }

    /// Rebuilds the draw list from the current pose and returns a copy.
    public func drawList() -> OpenBoneDrawList {
        withDrawList { list in
            OpenBoneDrawList(items: list.items.map(OpenBoneDrawItem.init),
                             clips: (0 ..< list.clipCount).map { OpenBoneClip(list.clip($0)) })
        }
    }
}
