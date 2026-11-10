# Releasing and desktop installers

← [Docs](README.md)

The desktop editor (`apps/desktop`, Tauri 2) is packaged by the **Desktop installers** workflow
([`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml)):

| Platform | Installers | Built on |
|---|---|---|
| Windows | `.msi` (WiX) and `-setup.exe` (NSIS, per-user or all users) | Windows Server 2022 |
| macOS | `.dmg` and `.app`, one universal build for Apple Silicon and Intel, macOS 10.15+ | macOS 15 |
| Linux | `.deb` (Debian, Ubuntu), `.rpm` (Fedora, openSUSE), `.AppImage` (any distribution) | Ubuntu 22.04, for an older glibc that more distributions have |

- [Cutting a release](#cutting-a-release)
- [Test builds without a release](#test-builds-without-a-release)
- [Packages](#packages)
- [Code signing](#code-signing)
- [Building installers locally](#building-installers-locally)
- [Installing unsigned builds](#installing-unsigned-builds)

## Cutting a release

1. Set the version everywhere (packages, editor, Tauri config, Cargo) and check it:

   ```bash
   pnpm version:set 0.2.0
   ```

   ```bash
   pnpm version:check
   ```

2. Add the version's section to [CHANGELOG.md](../CHANGELOG.md), commit and push.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. The workflow builds on all three platforms and attaches every installer to a **draft** GitHub Release named
   "OpenBone v0.2.0". Check the files, edit the notes, then publish the release.
5. Pushing the tag also publishes the Swift package and the Flutter plugin; publishing the release publishes the npm,
   NuGet, Unity, Maven Central and Godot packages (see [Packages](#packages)). Add the version to
   `runtimes/flutter/openbone/CHANGELOG.md` too, or the pub.dev check fails.

> [!IMPORTANT]
> The tag must match the app version (`v` + the version in `apps/desktop/src-tauri/tauri.conf.json`): the workflow
> names the release after the app version, so a mismatched tag gets a second, differently named release.

## Test builds without a release

**Actions → Desktop installers → Run workflow** builds all installers without a release. They are kept as workflow
artifacts (downloadable from the run's page for 90 days by default). Tick *Create a draft release* to make a draft
release for the current app version instead.

## Packages

Every package carries the same version (`pnpm version:set`). The workflows below publish them; each also runs by hand
from the Actions tab with **dry-run** ticked (the default), which builds, tests and packs without publishing.

> [!NOTE]
> On a `release` event GitHub runs the workflow files *as they are at the release's tag*, so a release only publishes
> packages if its tag contains these workflows (0.2.1 and later).

Put the secrets below on the protected **`release` environment** (Settings → Environments → release), like the signing
secrets: the npm, NuGet and Maven jobs run in it, so each publish waits for your approval. Repository variables
(`NUGET_USER`, `NPM_TRUSTED_PUBLISHING`) can stay at repository level.

| Registry | Workflow | Runs on | Credentials (one-time setup) |
|---|---|---|---|
| npm: `@openbone/*`, `openbone` (CLI) | [`publish-npm.yml`](../.github/workflows/publish-npm.yml) | release published | Free npm org `openbone`; granular token (read and write, `@openbone` scope + all packages) as secret `NPM_TOKEN`. Later optional: trusted publisher per package (`UXCentury/open-bone`, `publish-npm.yml`), variable `NPM_TRUSTED_PUBLISHING=true`, delete the token |
| NuGet: `OpenBone.Runtime`, `.Scripting.Jint`, `.MonoGame` | [`publish-dotnet.yml`](../.github/workflows/publish-dotnet.yml) | release published | nuget.org Trusted Publishing policy (owner `UXCentury`, repo `open-bone`, workflow `publish-dotnet.yml`) + repository **variable** `NUGET_USER` (profile name); or secret `NUGET_API_KEY` (push scope, glob `OpenBone.*`) |
| Unity: `com.openbone.runtime` | [`publish-unity.yml`](../.github/workflows/publish-unity.yml) | release published | None: commits the built package to the `upm` branch and tags `upm/v<version>`. Submit once to [OpenUPM](https://openupm.com) with `gitTagPrefix: 'upm/'` |
| Maven Central: `com.uxcentury:openbone-*` | [`publish-maven.yml`](../.github/workflows/publish-maven.yml) | release published | central.sonatype.com account, namespace `com.uxcentury` verified by DNS TXT on uxcentury.com; user token as `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD`; RSA 4096 GPG key (public part on keyserver.ubuntu.com and keys.openpgp.org) as `SIGNING_KEY` (armored) / `SIGNING_KEY_PASSWORD` |
| Godot addon | [`publish-godot.yml`](../.github/workflows/publish-godot.yml) | release published | None: attaches `openbone-godot-<version>.zip` and updates the `godot-addon` branch. Submit to the [Asset Library](https://godotengine.org/asset-library) (Download Commit = the hash in the run's summary) and upload the zip to the [Asset Store](https://store.godotengine.org) |
| pub.dev: `openbone` | [`publish-pub.yml`](../.github/workflows/publish-pub.yml) | tag `v*` pushed | The first version is published by hand (below); then pub.dev → package admin → Automated publishing: repo `UXCentury/open-bone`, tag pattern `v{{version}}`, environment `pub.dev` |
| Swift Package Manager | none | tag `v*` pushed | None: `Package.swift` is at the repository root, so the tag is the release. Submit once to the [Swift Package Index](https://swiftpackageindex.com/add-a-package) |

- **Flutter**: the plugin compiles `runtimes/cpp`, which a pub.dev package can't reach, so
  `runtimes/flutter/openbone/tool/bundle.sh OUT` stages a copy with the C++ sources under `cpp/` (symlinks resolved,
  third-party licences appended). First publish, signed in to pub.dev:

  ```bash
  runtimes/flutter/openbone/tool/bundle.sh /tmp/openbone-pub/openbone && cd /tmp/openbone-pub/openbone && flutter pub get && flutter pub publish
  ```

- **Swift**: the manifest must not use `unsafeFlags` (SwiftPM refuses them in dependencies). Exact maths comes from
  `runtimes/cpp/src/exact_math.h` instead; the Swift workflow builds a consumer of the package by version to catch this.
- **Maven Central** and **npm** never accept the same version twice: fix a bad release with a new version. The other
  workflows skip what is already published, so re-running them is safe.
- Locally: `pnpm build:packages` (npm), `dotnet pack` in `runtimes/csharp`,
  `python3 runtimes/csharp/unity/build-package.py --out DIR --pack`, `./gradlew publishToMavenLocal` in
  `runtimes/java`, `runtimes/cpp/engines/godot/package.sh` (see its header).

## Code signing

Unsigned installers work, but macOS Gatekeeper and Windows SmartScreen warn the first time they are opened. Signing is
optional and switched on by secrets on the **`release` environment** (**Settings → Environments → release**). The
workflow's job runs in that environment, so add yourself as a *required reviewer* there: a run then waits for your
approval before it can read the certificate. (Repository secrets with the same names also work, but are not gated.)

### macOS (Developer ID + notarization)

Needs an [Apple Developer Program](https://developer.apple.com/programs/) membership.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Your *Developer ID Application* certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, e.g. `Developer ID Application: UXCentury (TEAMID)` |
| `APPLE_ID` | The Apple ID email used for notarization |
| `APPLE_PASSWORD` | An [app-specific password](https://support.apple.com/102654) for that Apple ID |
| `APPLE_TEAM_ID` | Your 10-character team ID |

> [!TIP]
> "failed to notarize app: HTTP status code: 401. Invalid credentials" means signing worked but Apple refused
> `APPLE_ID` / `APPLE_PASSWORD`: `APPLE_ID` must be the Apple ID email of a member of the team, and `APPLE_PASSWORD` an
> app-specific password from account.apple.com → Sign-In and Security → App-Specific Passwords, not the account password.
> Check them locally with `xcrun notarytool history --apple-id <email> --team-id <TEAMID>` (it prompts for the password).

With these set, the macOS job signs the app with hardened runtime and sends it to Apple for notarization, so it opens
without a warning. Tauri notarizes only the app inside the `.dmg`, so a following step notarizes and staples the disk
image as well and replaces it in the release and the workflow artifact. The workflow passes each secret only when it
exists.

Check a downloaded build with `spctl -a -vv -t exec /Applications/OpenBone.app` (app) or
`spctl -a -vv -t open --context context:primary-signature OpenBone_<version>_universal.dmg` (disk image): both should
print `source=Notarized Developer ID`.

### Windows

The workflow signs the app `.exe`, the setup `.exe` and the `.msi` with an **SSL.com OV code-signing certificate**
through **eSigner**, SSL.com's cloud signing: the private key stays in SSL.com's HSM (no USB token), and only each
file's hash is sent. SSL.com validates organizations in any country. (Microsoft's Azure Artifact Signing is cheaper
but only open to organizations in the USA, Canada, the EU and the UK.)

1. Buy an **OV Code Signing** certificate at [ssl.com](https://www.ssl.com/products/software-integrity/code-signing/ov/)
   for the company and complete its validation (company registration documents, a verified phone number).
2. In the SSL.com dashboard, enrol the certificate in **eSigner** and pick an eSigner plan (the smallest tier is plenty:
   a release signs about 4 files). When you set up the eSigner PIN/2FA, choose to show the **TOTP secret** (the QR code's
   text, not a 6-digit code) and save it.
3. Add the four secrets to the `release` environment:

   | Secret | Value |
   |---|---|
   | `ES_USERNAME` | Your SSL.com account username |
   | `ES_PASSWORD` | Your SSL.com account password |
   | `ES_CREDENTIAL_ID` | The certificate's eSigner credential ID (certificate order page → *Signing Credentials*) |
   | `ES_TOTP_SECRET` | The eSigner TOTP secret from step 2 |

With all four set, the Windows job downloads SSL.com's
[CodeSignTool](https://github.com/SSLcom/CodeSignTool) (pinned version and checksum) and Tauri runs
[`apps/desktop/src-tauri/scripts/sign-windows.ps1`](../apps/desktop/src-tauri/scripts/sign-windows.ps1) for each file,
which checks the signature afterwards. Without them the installers are built unsigned, as before.

> [!NOTE]
> Since 2024, neither OV nor EV certificates skip SmartScreen right away: the warning goes away once the certificate
> has built up reputation from downloads. Signed builds also show "UXCentury" as the publisher instead of "Unknown".

### Linux

Linux packages are not signed. The AppImage can be signed with a GPG key if you want to publish signatures; the
`.deb` and `.rpm` are usually signed by the repository that serves them, not the file itself.

## Building installers locally

```bash
pnpm desktop:build
```

Installers for the current platform land in `apps/desktop/src-tauri/target/release/bundle/`. It needs Rust and
[Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/) (on Linux: `libwebkit2gtk-4.1-dev`,
`librsvg2-dev`, `patchelf`; plus `libfuse2` to build the AppImage).

> [!TIP]
> On Linux, the AppImage step runs `linuxdeploy`, which scans every folder on `PATH` and fails on one it cannot read
> ("filesystem error: status: Permission denied"). Remove that folder from `PATH` for the build if you hit this.

## Installing unsigned builds

| Platform | First launch |
|---|---|
| **macOS** | macOS says Apple "could not verify OpenBone is free of malware". Click **Done**, then open **System Settings → Privacy & Security**, and next to "OpenBone was blocked" click **Open Anyway** (macOS 15 and later no longer offer right-click → Open for this). Or in Terminal: `xattr -dr com.apple.quarantine /Applications/OpenBone.app` |
| **Windows** | SmartScreen shows "Windows protected your PC": **More info** → **Run anyway** |
| **Linux AppImage** | `chmod +x OpenBone_*.AppImage` and run it. Newer Ubuntu needs `sudo apt install libfuse2`, or run it with `--appimage-extract-and-run` |
| **Linux .deb / .rpm** | `sudo apt install ./OpenBone_*.deb` or `sudo dnf install ./OpenBone-*.rpm` (pulls in WebKitGTK) |
