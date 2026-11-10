// swift-tools-version: 5.9
// Swift Package Manager build of the openbone Flutter plugin for iOS and macOS (shared darwin sources): compiles the
// OpenBone C++ runtime (runtimes/cpp, through the symlinks in Sources/openbone) into a dynamic library. Xcode embeds it
// as openbone.framework, the same name the CocoaPods build (darwin/openbone.podspec) produces, so dart:ffi opens it the same
// way. Document scripts need QuickJS: run tool/fetch_quickjs.sh once (it fills runtimes/dart/third_party/quickjs);
// without it the library builds with scripts disabled (ob_has_scripts() == 0).
// SPDX-License-Identifier: MIT
import Foundation
import PackageDescription

let quickJS = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Sources/openbone_quickjs/vendor/quickjs.c")

// Results must match the reference bit for bit: no fused multiply-add contraction (matters on ARM64).
let exactMath: [String] = ["-ffp-contract=off", "-fno-fast-math"]

// Flutter requires every plugin package to depend on its generated FlutterFramework package.
var openboneDependencies: [Target.Dependency] = [.product(name: "FlutterFramework", package: "FlutterFramework")]
if quickJS {
    openboneDependencies.append("openbone_quickjs")
}

var targets: [Target] = [
    .target(
        name: "openbone",
        dependencies: openboneDependencies,
        path: "Sources/openbone",
        exclude: ["cpp-include", "third_party"],
        sources: ["src"],
        publicHeadersPath: "include",
        cxxSettings: [
            .headerSearchPath("cpp-include"),
            .headerSearchPath("third_party"),
            .headerSearchPath("src"),
            .define("OPENBONE_WITH_SCRIPTS", to: quickJS ? "1" : "0"),
            .unsafeFlags(exactMath),
        ]
    ),
]

if quickJS {
    targets.append(
        .target(
            name: "openbone_quickjs",
            path: "Sources/openbone_quickjs",
            sources: ["vendor/cutils.c", "vendor/libregexp.c", "vendor/libunicode.c", "vendor/quickjs.c", "vendor/xsum.c"],
            publicHeadersPath: "include",
            cSettings: [
                .define("_GNU_SOURCE"),
                .unsafeFlags(["-funsigned-char", "-w"] + exactMath),
            ]
        )
    )
}

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
