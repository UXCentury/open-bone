# OpenBone documentation

← [Back to the project README](../README.md) · These docs are also on the [website](https://uxcentury.github.io/open-bone/), with guides and live examples.

| Document | Read it when you want to… |
|---|---|
| [**Architecture**](architecture.md) | understand how the editor, the op registry, the runtime, rendering, audio and scripts fit together |
| [**File format**](format.md) | read or write `.obone` (JSON) and `.obonb` (binary) documents |
| [**Runtime specification**](runtime-spec.md) | port the runtime to another language, or check exactly how a pose, a draw list or a state machine is computed |
| [**MCP server**](mcp.md) | let an AI agent build and edit animations, or drive the editor live |
| [**Engine and platform exports**](engine-exports.md) | ship sprite sheets or WebView packages to engines from the Export dialog |
| [**Releasing and desktop installers**](releasing.md) | build the Windows, macOS and Linux installers, cut a release, or set up code signing |

More reference material lives next to the code:

| Where | What |
|---|---|
| [`conformance/`](../conformance/README.md) | The reference results every runtime is tested against, and how to run a case |
| [`runtimes/cpp`](../runtimes/cpp/README.md) · [`csharp`](../runtimes/csharp/README.md) · [`java`](../runtimes/java/README.md) · [`swift`](../runtimes/swift/README.md) · [`flutter`](../runtimes/flutter/openbone/README.md) | Building, testing and using each native runtime and its engine integrations |
| [`packages/`](../packages) | The web packages (runtime, renderers, player, engine runtimes, MCP, CLI); several have their own README |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed in each version |
