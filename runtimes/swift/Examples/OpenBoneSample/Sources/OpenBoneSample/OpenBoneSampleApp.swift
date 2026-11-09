// OpenBone SwiftUI sample: pick an example document, play its animations or drive its state machine.
// SPDX-License-Identifier: MIT
#if canImport(SwiftUI) && canImport(MetalKit)
import SwiftUI

@main
struct OpenBoneSampleApp: App {
    var body: some Scene {
        WindowGroup("OpenBone") {
            ContentView()
                #if os(macOS)
                .frame(minWidth: 820, minHeight: 560)
                #endif
        }
    }
}
#else
// Lets the sample compile on platforms without SwiftUI (Linux CI); the app itself needs iOS or macOS.
@main
enum OpenBoneSampleApp {
    static func main() {
        print("The OpenBone sample is a SwiftUI app: run it on macOS (swift run) or iOS (Xcode).")
    }
}
#endif
