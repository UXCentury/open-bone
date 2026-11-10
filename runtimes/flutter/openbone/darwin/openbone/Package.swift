// swift-tools-version: 5.9
// Swift Package Manager build of the openbone Flutter plugin for iOS and macOS (shared darwin sources): compiles the
// OpenBone C++ runtime and QuickJS (quickjs-ng, MIT) into a dynamic library. Xcode embeds it as openbone.framework, the
// same name the CocoaPods build (darwin/openbone.podspec) produces, so dart:ffi opens it the same way.
// In the repository, Sources/openbone/{src,cpp-include,third_party} and Sources/openbone_quickjs/vendor are symlinks
// into runtimes/cpp; tool/bundle.sh replaces them with copies for the published package.
// SPDX-License-Identifier: MIT
import PackageDescription

// Results must match the reference bit for bit: no fused multiply-add contraction (matters on ARM64). The runtime sources
// also say so with a pragma (cpp/src/exact_math.h); the flags are allowed here because Flutter's generated package uses
// this one by path, and SwiftPM only refuses unsafe flags in packages resolved by version.
let exactMath: [String] = ["-ffp-contract=off", "-fno-fast-math"]

let targets: [Target] = [
    .target(
        name: "openbone",
        // Flutter requires every plugin package to depend on its generated FlutterFramework package.
        dependencies: [.product(name: "FlutterFramework", package: "FlutterFramework"), "openbone_quickjs"],
        path: "Sources/openbone",
        exclude: ["cpp-include", "third_party"],
        sources: ["src"],
        publicHeadersPath: "include",
        cxxSettings: [
            .headerSearchPath("cpp-include"),
            .headerSearchPath("third_party"),
            .headerSearchPath("src"),
            .define("OPENBONE_WITH_SCRIPTS", to: "1"),
            .unsafeFlags(exactMath),
        ]
    ),
    .target(
        name: "openbone_quickjs",
        path: "Sources/openbone_quickjs",
        sources: ["vendor/cutils.c", "vendor/libregexp.c", "vendor/libunicode.c", "vendor/quickjs.c", "vendor/xsum.c"],
        publicHeadersPath: "include",
        cSettings: [
            .define("_GNU_SOURCE"),
            .unsafeFlags(["-funsigned-char", "-w"] + exactMath),
        ]
    ),
]

let package = Package(
    name: "openbone",
    platforms: [.iOS("13.0"), .macOS("10.15")],
    products: [
        // Dynamic: Dart looks the C API up by name at run time, so nothing references it at link time and a static
        // library's symbols could be dropped by the linker.
        .library(name: "openbone", type: .dynamic, targets: ["openbone"]),
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
    ],
    targets: targets,
    cxxLanguageStandard: .cxx17
)
