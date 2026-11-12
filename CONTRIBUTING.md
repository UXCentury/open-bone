# Contributing to OpenBone

Thank you for helping. OpenBone is MIT licensed and built in the open by
[UXCentury](https://uxcentury.com) and its community. Contributions of every kind are welcome: bug reports, fixes,
runtime ports, engine integrations, docs, examples, translations and ideas.

This page covers the rules every contribution has to follow, then the practices that get a pull request merged quickly.

- [Ways to help](#ways-to-help)
- [Rules](#rules)
- [Before you start](#before-you-start)
- [Setting up](#setting-up)
- [Best practices](#best-practices)
- [Checks to run](#checks-to-run)
- [Pull requests](#pull-requests)
- [Reporting bugs](#reporting-bugs)
- [Code of conduct](#code-of-conduct)

## Ways to help

- **Report a bug**: open an [issue](https://github.com/UXCentury/open-bone/issues) with steps or a `.obone` file that
  shows it.
- **Fix a bug or add a feature**: pick an open issue, or open one first for anything larger than a small fix.
- **Port or improve a runtime**: the [runtime specification](docs/runtime-spec.md) and the
  [conformance suite](conformance) say exactly what a runtime must do.
- **Improve the docs or the website**: every page has an "Edit page" link.
- **Share what you made**: example projects and engine samples help everyone.

## Rules

These are not negotiable; a pull request that breaks one cannot be merged.

1. **MIT, permissive dependencies only.** Everything you contribute is released under the [MIT licence](LICENSE).
   New dependencies must be permissively licensed (MIT, BSD, Apache-2.0, ISC, zlib, MPL-2.0 for unmodified files, or
   public domain). No GPL, LGPL, AGPL, SSPL, "non-commercial" or proprietary code. Add each new dependency to the
   credits table in the [README](README.md#open-source-credits).
2. **Clean room.** OpenBone is an independent implementation. Do not copy, translate or study the source of Spine's
   runtimes or editor, Rive's editor or runtimes, or any other proprietary animation tool, and do not contribute code
   derived from them. Build from public math and your own design. If you have worked on such code under a licence
   that forbids this, say so before contributing in that area.
3. **Your own work.** Only contribute code, art, sound and text you have the right to give under MIT (or, for assets, a
   licence listed next to them). Credit third-party assets and keep their licence file next to them, as
   [examples/assets](examples/assets) does.
4. **One format, every runtime.** A change to the file format or to how a pose, draw list or state machine is computed
   must update [docs/format.md](docs/format.md) and [docs/runtime-spec.md](docs/runtime-spec.md), the reference runtime,
   and the conformance results. Native runtimes must keep passing the conformance suite; if you cannot port a change to
   every runtime, say which ones still need it in the pull request.
5. **Every edit is an op.** Changes to a document go through the op registry in `packages/core/src/ops`, never by
   mutating the document directly from the editor, the MCP server or the CLI. That is what keeps undo, the live bridge
   and AI agents working.
6. **No secrets.** Never commit keys, tokens, passwords, signing certificates or personal data, not even in tests.
7. **Security problems are private.** Do not open a public issue for a vulnerability; follow [SECURITY.md](SECURITY.md).
8. **Be kind.** Follow the [code of conduct](#code-of-conduct) in issues, pull requests, reviews and discussions.

## Before you start

- For a small fix (a bug, a typo, a doc page), just open a pull request.
- For a feature, a format change, a new runtime or engine, or anything touching many packages, **open an issue first**
  and describe the problem and the approach. It saves you from writing code that cannot be merged.
- Check open issues and pull requests so two people do not build the same thing.

## Setting up

You need Node.js 22 or later and [pnpm](https://pnpm.io) 10.

```bash
git clone https://github.com/UXCentury/open-bone.git
cd open-bone
pnpm install
pnpm dev            # the editor at http://localhost:5180
pnpm website        # the documentation website
```

Each native runtime has its own toolchain and README: [C/C++](runtimes/cpp), [C#](runtimes/csharp),
[Java](runtimes/java), [Swift](runtimes/swift), [Flutter](runtimes/flutter/openbone) and [Haxe](runtimes/haxe). The
[architecture overview](docs/architecture.md) shows how the pieces fit together.

## Best practices

**Keep changes focused.** One pull request does one thing. A bug fix does not also reformat the file or rename things
around it. Split large work into reviewable steps.

**Match the code around you.** Follow the existing style, naming and structure of the package you are in, rather than
introducing a new pattern. TypeScript is strict; keep it that way (no `any` without a reason, no disabled checks).

**Test what you change.**
- Fix a bug with a test that fails before the fix and passes after.
- New ops need tests in `packages/core/test`; runtime behaviour belongs in the conformance suite so every runtime is
  checked against it.
- Editor changes: try them in the editor, including undo and redo, and saving and reopening the project.
- Engine changes: run the engine's sample and look at the result, not only its unit tests.

**Keep runtimes in step.** Runtimes are ports of one reference (`packages/runtime`). Keep the same names, the same
order of operations and the same edge cases, so a result in one engine matches the others. Regenerate the conformance
results with `pnpm conformance` only when the reference behaviour is meant to change, and explain why in the pull
request.

**Stay compatible.** Old `.obone` files must keep opening. Add new fields as optional with a sensible default, and do
not change the meaning of existing ones. Public APIs of published packages change only with a changelog entry and, if
it breaks callers, a note on how to migrate.

**Think about every surface.** A feature added to the editor usually also belongs in the MCP server (its tools come
from the op registry), the CLI, the validator, the docs and, when it affects playback, the runtimes and exports.

**Keep it fast and small.** The player and runtimes ship inside games and web pages. Avoid new dependencies in them,
avoid work every frame that can be cached, and avoid allocations in hot loops.

**Accessible, readable UI.** Editor controls need labels and keyboard access. Text in the UI and docs is plain, short
and specific.

**Document as you go.** Update the README of the package you changed, the relevant guide or reference page, and add a
line to [CHANGELOG.md](CHANGELOG.md) under an `## Unreleased` heading at the top (add the heading if it is not there)
describing the change for users.

**Commit messages.** Write a short summary line in the imperative or as a title ("Godot: Document set in the Inspector
loads", "Fix IK flip at 180°"), prefixed with the area when it helps, and explain the why in the body when it is not
obvious. Keep unrelated changes in separate commits.

**Versions are shared.** All packages carry one version. Do not edit version numbers by hand; maintainers run
`pnpm version:set` when releasing (see [releasing](docs/releasing.md)).

**Using AI assistants.** AI tools are welcome; OpenBone itself was built with their help. You are still responsible
for every line: read it, test it, make sure it follows the rules above (licences and clean room included), and do not
submit output you do not understand.

## Checks to run

Run the checks for what you changed before opening a pull request. CI runs them all again.

| Area | Commands |
|---|---|
| TypeScript (packages, editor, MCP, CLI) | `pnpm version:check`, `pnpm typecheck`, `pnpm test`, `pnpm build` |
| Conformance results | `pnpm conformance` (only when the reference behaviour changes) |
| Website | `pnpm website:build` |
| C / C++ | `cmake -S runtimes/cpp -B build && cmake --build build && ctest --test-dir build` |
| C# | in `runtimes/csharp`: `dotnet test`, `dotnet build unity/compile-check`, `dotnet test monogame/OpenBone.MonoGame.sln` |
| Java | in `runtimes/java`: `./gradlew build` |
| Swift | `swift test` |
| Flutter | in `runtimes/flutter/openbone`: `flutter test` |
| Haxe | in `runtimes/haxe`: `haxe test.hxml` |

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, following the rules and practices above.
3. Run the checks for the areas you touched.
4. Open a pull request that says **what** changed, **why**, and **how you tested it**. Link the issue it fixes. Add
   screenshots or a short recording for visual changes.
5. Keep the pull request up to date with `main` and answer review comments. A maintainer merges it once CI is green and
   the review is approved.

By opening a pull request you confirm that you have the right to contribute the work under the MIT licence.

## Reporting bugs

A good report has:

- what you did, what you expected and what happened instead;
- the OpenBone version (editor: **☰ Menu → About OpenBone**) and the engine, runtime or package and its version;
- your operating system, and browser for the web editor or player;
- the smallest `.obone` file, code sample or steps that show the problem;
- screenshots, logs or error messages.

Feature requests are welcome too: describe the problem you want solved, not only the solution.

## Code of conduct

We want OpenBone to be a welcoming place for everyone, whatever their experience, background or identity.

- Be respectful and patient. Assume good intent, and remember that many contributors work in a second language.
- Critique code and ideas, never people. Give feedback you would want to receive.
- No harassment, insults, discrimination, sexualised content, or publishing others' private information.
- Help newcomers; everyone started somewhere.

Maintainers may edit or remove comments, close issues or pull requests, and block people who do not follow these
rules. To report a problem privately, contact the maintainers through [uxcentury.com](https://uxcentury.com).

Thank you for making OpenBone better.
