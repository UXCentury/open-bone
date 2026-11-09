// The sample's UI: document picker, animation / state-machine controls, live inputs, event and audio log.
// SPDX-License-Identifier: MIT
#if canImport(SwiftUI) && canImport(MetalKit)
import OpenBone
import SwiftUI
import UniformTypeIdentifiers

/// The repository's examples/ folder when running from source (swift run / Xcode with this checkout).
private let examplesFolder = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("examples")

final class SampleModel: ObservableObject {
    @Published var documents: [URL] = []
    @Published var instance: OpenBoneInstance?
    @Published var current: URL?
    @Published var log: [String] = []
    @Published var error: String?
    @Published var mode: Mode = .stateMachine
    @Published var animation = ""
    @Published var skin = ""
    @Published var values: [String: OpenBoneValue] = [:]
    @Published var speed = 1.0

    enum Mode: String, CaseIterable, Identifiable {
        case stateMachine = "State machine", animation = "Animation"
        var id: String { rawValue }
    }

    init() {
        documents = ((try? FileManager.default.contentsOfDirectory(at: examplesFolder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "obone" || $0.pathExtension == "obonb" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        if let first = documents.first(where: { $0.lastPathComponent == "button.obone" }) ?? documents.first { open(first) }
    }

    var document: OpenBoneDocument? { instance?.document }

    func open(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let doc = try OpenBoneDocument(contentsOf: url)
            mode = doc.stateMachines.isEmpty ? .animation : .stateMachine
            animation = doc.animations.first?.name ?? ""
            skin = ""
            try start(doc)
            current = url
            error = nil
        } catch {
            self.error = "\(error)"
        }
    }

    func restart() {
        guard let doc = document else { return }
        do { try start(doc) } catch { self.error = "\(error)" }
    }

    private func start(_ doc: OpenBoneDocument) throws {
        let inst = try OpenBoneInstance(document: doc)
        inst.onEvent = { [weak self] e in self?.append("event \(e.name)\(e.stringValue.isEmpty ? "" : " “\(e.stringValue)”")") }
        inst.onAudio = { [weak self] c in
            // A real app hands these to AVAudioEngine; the sample just logs them.
            switch c {
            case let .play(id, sound, _, bus, volume, _, loop, _, _):
                self?.append("audio play \(sound) [\(id)] bus=\(bus ?? "master") vol=\(volume)\(loop ? " loop" : "")")
            case let .stop(id, fade): self?.append("audio stop [\(id)] fade=\(fade)")
            case let .fade(id, volume, duration): self?.append("audio fade [\(id)] → \(volume) in \(duration)s")
            }
        }
        inst.onStateChange = { [weak self] layer, _, to in self?.append("\(layer) → \(to)") }
        inst.onLog = { [weak self] m, isError in self?.append((isError ? "script error: " : "script: ") + m) }
        if !skin.isEmpty { try inst.setSkin(skin) }
        switch mode {
        case .stateMachine: try inst.useStateMachine()
        case .animation: if !animation.isEmpty { try inst.play(animation) }
        }
        values = [:]
        for input in doc.stateMachines.first?.inputs ?? [] where !input.isTrigger {
            values[input.name] = input.defaultValue
        }
        instance = inst
    }

    func set(_ name: String, _ value: OpenBoneValue) {
        values[name] = value
        do { try instance?.setInput(name, value) } catch { self.error = "\(error)" }
    }

    func fire(_ name: String) {
        do { try instance?.fire(name) } catch { self.error = "\(error)" }
    }

    private func append(_ line: String) {
        log.append(line)
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }
}

struct ContentView: View {
    @StateObject private var model = SampleModel()
    @State private var importing = false

    var body: some View {
        #if os(macOS)
        HStack(spacing: 0) {
            controls.frame(width: 300)
            Divider()
            stage
        }
        #else
        VStack(spacing: 0) {
            stage.frame(maxHeight: .infinity)
            Divider()
            ScrollView { controls }.frame(maxHeight: 320)
        }
        #endif
    }

    private var stage: some View {
        ZStack {
            Color.gray.opacity(0.15)
            if let inst = model.instance {
                OpenBonePlayer(instance: inst, speed: model.speed).padding()
            } else {
                Text(model.error ?? "No document")
            }
        }
    }

    private var controls: some View {
        Form {
            Section("Document") {
                Picker("Example", selection: Binding(get: { model.current }, set: { if let u = $0 { model.open(u) } })) {
                    if model.current.map({ !model.documents.contains($0) }) ?? true { Text("—").tag(model.current) }
                    ForEach(model.documents, id: \.self) { Text($0.lastPathComponent).tag(Optional($0)) }
                }
                Button("Open…") { importing = true }
                if let e = model.error { Text(e).foregroundColor(.red).font(.caption) }
            }
            if let doc = model.document {
                Section("Playback") {
                    Picker("Mode", selection: $model.mode) {
                        ForEach(SampleModel.Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .onChange(of: model.mode) { _ in model.restart() }
                    if model.mode == .animation {
                        Picker("Animation", selection: $model.animation) {
                            ForEach(doc.animations, id: \.name) { Text($0.name).tag($0.name) }
                        }
                        .onChange(of: model.animation) { _ in model.restart() }
                    }
                    if !doc.skins.isEmpty {
                        Picker("Skin", selection: $model.skin) {
                            Text("(none)").tag("")
                            ForEach(doc.skins, id: \.self) { Text($0).tag($0) }
                        }
                        .onChange(of: model.skin) { _ in model.restart() }
                    }
                    Slider(value: $model.speed, in: 0 ... 2) { Text("Speed") }
                }
                if model.mode == .stateMachine, let machine = doc.stateMachines.first {
                    Section("Inputs — \(machine.name)") {
                        ForEach(machine.inputs, id: \.name) { input in inputRow(input) }
                    }
                }
            }
            Section("Log") {
                ForEach(Array(model.log.suffix(30).enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(.caption, design: .monospaced))
                }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data, .json]) { result in
            if case let .success(url) = result { model.open(url) }
        }
    }

    private func numberRange(_ input: OpenBoneDocument.Input) -> ClosedRange<Double> {
        if case let .number(d)? = input.defaultValue { return min(0, d) ... max(1, abs(d) * 2) }
        return 0 ... 1
    }

    @ViewBuilder
    private func inputRow(_ input: OpenBoneDocument.Input) -> some View {
        if input.isTrigger {
            Button("Fire \(input.name)") { model.fire(input.name) }
        } else {
            switch model.values[input.name] ?? input.defaultValue {
            case let .bool(b)?:
                Toggle(input.name, isOn: Binding(get: { b }, set: { model.set(input.name, .bool($0)) }))
            case let .number(n)?:
                VStack(alignment: .leading) {
                    Text("\(input.name): \(n, specifier: "%.2f")")
                    Slider(value: Binding(get: { n }, set: { model.set(input.name, .number($0)) }), in: numberRange(input))
                }
            case let .string(s)?:
                TextField(input.name, text: Binding(get: { s }, set: { model.set(input.name, .string($0)) }))
            case nil:
                Text(input.name)
            }
        }
    }
}
#endif
