// swift-tools-version:5.9
// OpenBone for Swift (runtimes/swift): the C++ runtime (runtimes/cpp, compiled from source) behind its C API, an
// idiomatic Swift layer, and Metal views for UIKit / AppKit / SwiftUI. This manifest sits at the repository root so
// apps can add the package by URL:
//
//     .package(url: "https://github.com/UXCentury/open-bone", from: "0.2.0")
//
// It is the only manifest for the Swift runtime (local development too: `swift build` / `swift test` from the root).
// It must not use unsafeFlags, which SwiftPM rejects in versioned dependencies: no FMA contraction comes from
// runtimes/cpp/src/exact_math.h and the QuickJS wrappers in runtimes/swift/Sources/CQuickJS instead of -ffp-contract=off.
// SPDX-License-Identifier: MIT
import PackageDescription

let package = Package(
    name: "OpenBone",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15)],
    products: [
        .library(name: "OpenBone", targets: ["OpenBone"]),
    ],
    targets: [
        // The C++ runtime: Sources/COpenBone/{src,cpp-include,third_party} are symlinks into runtimes/cpp.
        .target(
            name: "COpenBone",
            dependencies: ["CQuickJS"],
            path: "runtimes/swift/Sources/COpenBone",
            exclude: ["cpp-include", "third_party"],
            sources: ["src"],
            publicHeadersPath: "include",
            cxxSettings: [
                .headerSearchPath("cpp-include"),
                .headerSearchPath("third_party"),
                .headerSearchPath("src"),
                .define("OPENBONE_STATIC"),
                .define("OPENBONE_WITH_SCRIPTS", to: "1"),
            ]
        ),
        // QuickJS (quickjs-ng, MIT) for document scripts: Sources/CQuickJS/vendor is a symlink to the copy vendored in
        // runtimes/cpp/third_party/quickjs, compiled through the wrapper .c files next to it.
        .target(
            name: "CQuickJS",
            path: "runtimes/swift/Sources/CQuickJS",
            exclude: ["vendor"],
            publicHeadersPath: "include",
            cSettings: [
                .define("_GNU_SOURCE"),
            ],
            linkerSettings: [
                .linkedLibrary("m", .when(platforms: [.linux, .android])),
                .linkedLibrary("dl", .when(platforms: [.linux])),
                .linkedLibrary("pthread", .when(platforms: [.linux, .android])),
            ]
        ),
        .target(
            name: "OpenBone",
            dependencies: ["COpenBone"],
            path: "runtimes/swift/Sources/OpenBone"
        ),
        .testTarget(
            name: "OpenBoneTests",
            dependencies: ["OpenBone"],
            path: "runtimes/swift/Tests/OpenBoneTests"
        ),
    ],
    cxxLanguageStandard: .cxx17
)
