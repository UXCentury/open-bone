// The platform-neutral half of the renderer (framing, mesh building, batching), which the Metal views draw.
// SPDX-License-Identifier: MIT
import Foundation
import OpenBone
import XCTest

final class RenderGeometryTests: XCTestCase {
    func instance(_ path: String, _ setup: (OpenBoneInstance) throws -> Void = { _ in }) throws -> OpenBoneInstance {
        let doc = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent(path))
        let inst = try OpenBoneInstance(document: doc)
        try setup(inst)
        inst.advance(0)
        return inst
    }

    func testViewportRoundTripAndFit() {
        let content = OpenBoneRect(minX: -100, minY: -50, maxX: 100, maxY: 150) // 200 × 200
        let v = OpenBoneViewport(content: content, width: 400, height: 200, fit: .contain)
        XCTAssertEqual(v.scaleX, 1, accuracy: 1e-12)
        // Top-left of the content lands at the top of the view, centred horizontally.
        let tl = v.toView(OpenBonePoint(x: -100, y: 150))
        XCTAssertEqual(tl.x, 100, accuracy: 1e-9)
        XCTAssertEqual(tl.y, 0, accuracy: 1e-9)
        let p = OpenBonePoint(x: 12.5, y: -7.25)
        let back = v.toSkeleton(v.toView(p))
        XCTAssertEqual(back.x, p.x, accuracy: 1e-9)
        XCTAssertEqual(back.y, p.y, accuracy: 1e-9)
        XCTAssertEqual(OpenBoneViewport(content: content, width: 400, height: 200, fit: .cover).scaleX, 2, accuracy: 1e-12)
        let fill = OpenBoneViewport(content: content, width: 400, height: 200, fit: .fill)
        XCTAssertEqual(fill.scaleX, 2, accuracy: 1e-12)
        XCTAssertEqual(fill.scaleY, 1, accuracy: 1e-12)
        // NDC: the view's corners map to ±1 (y up).
        let ndc = v.ndcTransform
        func toNDC(_ q: OpenBonePoint) -> (Float, Float) { (Float(q.x) * ndc.x + ndc.z, Float(q.y) * ndc.y + ndc.w) }
        let c = toNDC(v.toSkeleton(OpenBonePoint(x: 0, y: 0)))
        XCTAssertEqual(c.0, -1, accuracy: 1e-5)
        XCTAssertEqual(c.1, 1, accuracy: 1e-5)
        let d = toNDC(v.toSkeleton(OpenBonePoint(x: 400, y: 200)))
        XCTAssertEqual(d.0, 1, accuracy: 1e-5)
        XCTAssertEqual(d.1, -1, accuracy: 1e-5)
    }

    func testArtboardPointerMatchesDocumentConversion() throws {
        let doc = try OpenBoneDocument(contentsOf: repoRoot.appendingPathComponent("conformance/fixtures/interactive.obone"))
        let a = doc.artboard
        // An artboard-sized view with .fill: view points are artboard pixels.
        let v = OpenBoneViewport(content: a.skeletonRect, width: a.width, height: a.height, fit: .fill)
        let mine = v.toSkeleton(OpenBonePoint(x: 30, y: 40)), ref = doc.artboardToSkeleton(x: 30, y: 40)
        XCTAssertEqual(mine.x, ref.x, accuracy: 1e-9)
        XCTAssertEqual(mine.y, ref.y, accuracy: 1e-9)
    }

    func testMeshMatchesDrawList() throws {
        for path in ["examples/knight.obone", "conformance/fixtures/meshes.obone", "conformance/fixtures/dynamics.obone",
                     "examples/campfire.obone", "conformance/fixtures/interactive.obone"] {
            let inst = try instance(path) { i in
                if !i.document.stateMachines.isEmpty { try i.useStateMachine() } else { try i.play(i.document.animations[0].name) }
            }
            inst.advance(0.5)
            let list = inst.drawList()
            var mesh = OpenBoneRenderMesh()
            mesh.build(from: inst)
            XCTAssertEqual(mesh.clips.count, list.clips.count, path)
            // Every index is in range, commands tile the item indices in order without gaps.
            XCTAssertTrue(mesh.indices.allSatisfy { Int($0) < mesh.vertexCount }, path)
            let clipIndices = mesh.clips.reduce(0) { $0 + $1.indexCount }
            var next = clipIndices
            for c in mesh.commands {
                XCTAssertEqual(c.indexStart, next, path)
                XCTAssertEqual(c.indexCount % 3, 0, path)
                next += c.indexCount
                if let k = c.clip { XCTAssertLessThan(k, mesh.clips.count, path) }
            }
            XCTAssertEqual(next, mesh.indices.count, path)
            // Non-text, non-stroked geometry is copied verbatim: same triangles in skeleton space.
            let plain = list.items.filter { $0.kind != .text && $0.stroke == nil }
            let expected = plain.reduce(0) { $0 + $1.indices.count }
            let fromItems = mesh.commands.filter { if case .text = $0.texture { return false }; return true }
                .reduce(0) { $0 + $1.indexCount }
            XCTAssertGreaterThanOrEqual(fromItems, expected, path)
            // Adjacent commands always differ (merging works).
            for (a, b) in zip(mesh.commands, mesh.commands.dropFirst()) {
                XCTAssertFalse(a.texture == b.texture && a.blend == b.blend && a.clip == b.clip, path)
            }
            if let first = plain.first(where: { !$0.indices.isEmpty }) {
                let i0 = Int(first.indices[0])
                let v0 = Int(mesh.indices[clipIndices]) * OpenBoneRenderMesh.floatsPerVertex
                XCTAssertEqual(mesh.vertices[v0], first.vertices[i0 * 2], path)
                XCTAssertEqual(mesh.vertices[v0 + 1], first.vertices[i0 * 2 + 1], path)
            }
        }
    }

    func testTextAndParticles() throws {
        let inst = try instance("conformance/fixtures/dynamics.obone") { try $0.play($0.document.animations[0].name) }
        inst.advance(1)
        var mesh = OpenBoneRenderMesh()
        mesh.build(from: inst)
        let list = inst.drawList()
        if let text = list.items.first(where: { $0.kind == .text })?.text {
            let cmd = mesh.commands.first { if case .text = $0.texture { return true }; return false }
            XCTAssertNotNil(cmd)
            XCTAssertEqual(cmd?.indexCount, 6)
            // The quad's centre is the text matrix origin.
            if let c = cmd {
                var cx: Float = 0, cy: Float = 0
                for k in Set(mesh.indices[c.indexStart ..< c.indexStart + 6]) {
                    cx += mesh.vertices[Int(k) * 12] / 4
                    cy += mesh.vertices[Int(k) * 12 + 1] / 4
                }
                XCTAssertEqual(Double(cx), text.matrix.tx, accuracy: 1e-3)
                XCTAssertEqual(Double(cy), text.matrix.ty, accuracy: 1e-3)
            }
        }
        if list.items.contains(where: { $0.kind == .particles && !$0.indices.isEmpty }) {
            XCTAssertTrue(mesh.commands.contains { $0.texture == .particleDot })
        }
        let dot = openBoneParticleDotPixels(size: 64)
        XCTAssertEqual(dot.count, 64 * 64 * 4)
        XCTAssertEqual(dot[(32 * 64 + 32) * 4 + 3], 255)
        XCTAssertEqual(dot[3], 0)
    }
}
