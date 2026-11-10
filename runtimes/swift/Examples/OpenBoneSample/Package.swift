// swift-tools-version:5.9
// SwiftUI sample for the OpenBone Swift package. macOS: `swift run` from this folder. iOS: add the two source files
// to an Xcode app target and the package (../..) as a local dependency. See ../../README.md.
// SPDX-License-Identifier: MIT
import PackageDescription

let package = Package(
    name: "OpenBoneSample",
    platforms: [.iOS(.v16), .macOS(.v13)],
    dependencies: [.package(name: "OpenBone", path: "../..")],
    targets: [
        .executableTarget(
            name: "OpenBoneSample",
            dependencies: [.product(name: "OpenBone", package: "OpenBone")],
            path: "Sources/OpenBoneSample"
        ),
    ]
)
