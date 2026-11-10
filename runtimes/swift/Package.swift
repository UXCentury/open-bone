// swift-tools-version:5.9
// OpenBone for Swift: the C++ runtime (runtimes/cpp, compiled from source through the symlinks in Sources/COpenBone)
// behind its C API, an idiomatic Swift layer, and Metal views for UIKit / AppKit / SwiftUI.
// SPDX-License-Identifier: MIT
import Foundation
import PackageDescription

// Document scripts run in QuickJS (quickjs-ng). Its sources are not committed: ./scripts/fetch-quickjs.sh downloads
// them into Sources/CQuickJS/vendor (the same release and checksum as the C++ CMake build). Without them the
// package still builds, with scripts disabled.
let quickJS = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Sources/CQuickJS/vendor/quickjs.c")
    && Context.environment["OPENBONE_NO_SCRIPTS"] == nil

// Results must match the reference bit for bit: no fused multiply-add contraction (matters on ARM64).
let exactMath: [String] = ["-ffp-contract=off", "-fno-fast-math"]

var targets: [Target] = [
    .target(
        name: "COpenBone",
        dependencies: quickJS ? ["CQuickJS"] : [],
        path: "Sources/COpenBone",
        exclude: ["cpp-include", "third_party"],
        sources: ["src"],
        publicHeadersPath: "include",
        cxxSettings: [
            .headerSearchPath("cpp-include"),
            .headerSearchPath("third_party"),
            .headerSearchPath("src"),
            .define("OPENBONE_STATIC"),
            .define("OPENBONE_WITH_SCRIPTS", to: quickJS ? "1" : "0"),
            .unsafeFlags(exactMath),
        ]
    ),
    .target(
        name: "OpenBone",
        dependencies: ["COpenBone"],
        path: "Sources/OpenBone"
    ),
    .testTarget(
        name: "OpenBoneTests",
        dependencies: ["OpenBone"],
        path: "Tests/OpenBoneTests"
    ),
]

if quickJS {
    targets.append(
        .target(
            name: "CQuickJS",
            path: "Sources/CQuickJS",
            exclude: ["vendor/LICENSE"],
            sources: ["vendor/cutils.c", "vendor/libregexp.c", "vendor/libunicode.c", "vendor/quickjs.c", "vendor/xsum.c"],
            publicHeadersPath: "include",
            cSettings: [
                .define("_GNU_SOURCE"),
                .unsafeFlags(["-funsigned-char", "-w"] + exactMath),
            ],
            linkerSettings: [
                .linkedLibrary("m", .when(platforms: [.linux, .android])),
                .linkedLibrary("dl", .when(platforms: [.linux])),
                .linkedLibrary("pthread", .when(platforms: [.linux, .android])),
            ]
        )
    )
}

let package = Package(
    name: "OpenBone",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15)],
    products: [
        .library(name: "OpenBone", targets: ["OpenBone"]),
    ],
    targets: targets,
    cxxLanguageStandard: .cxx17
)
