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

> [!IMPORTANT]
> The tag must match the app version (`v` + the version in `apps/desktop/src-tauri/tauri.conf.json`): the workflow
> names the release after the app version, so a mismatched tag gets a second, differently named release.

## Test builds without a release

**Actions → Desktop installers → Run workflow** builds all installers without a release. They are kept as workflow
artifacts (downloadable from the run's page for 90 days by default). Tick *Create a draft release* to make a draft
release for the current app version instead.

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

With these set, the macOS job signs the app with hardened runtime and sends it to Apple for notarization, so it opens
without a warning. The workflow passes each secret only when it exists.

### Windows

Windows signing needs a code-signing certificate (an OV or EV certificate from a certificate authority, or Microsoft's
Azure Trusted Signing). Tauri signs through `bundle.windows.signCommand` (or `certificateThumbprint`) in
`apps/desktop/src-tauri/tauri.conf.json`; see Tauri's [Windows code signing guide](https://v2.tauri.app/distribute/sign/windows/).
Add the command and its secrets to the workflow's Windows job once you have a certificate.

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
