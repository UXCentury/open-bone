# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/UXCentury/open-bone/security/advisories/new) (Security tab → Advisories →
Report a vulnerability). Include what is affected (editor, desktop app, MCP server, CLI, a runtime or a package), the
version, and steps or a file that reproduces it.

We aim to reply within 3 working days, agree on a fix and a disclosure date with you, and credit you in the advisory and
the changelog unless you prefer otherwise.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x (latest release) | Yes |
| Older versions | No: please update |

Fixes ship in a new release of every affected package (npm, NuGet, Maven Central, pub.dev, Swift, Unity, Godot and
the desktop installers carry the same version).

## Security audit

| Date | Scope | Result |
|---|---|---|
| 2026-11-10 | Release and publishing pipeline: the desktop release workflow (macOS and Windows signing), the npm, NuGet, Unity, Maven Central, Godot and pub.dev publish workflows, package contents, the Swift package manifest, and the MCP/CLI export path | No vulnerabilities found. Two hardening items open (see below) |

What was checked:

- **Workflows**: only people with write access can start a publish or a release (release published, tag pushed or a
  manual run); no workflow runs untrusted pull-request code with secrets, publishing tokens or write access; no pull
  request title, branch name or other outside text reaches a shell command.
- **Secrets**: signing and publishing credentials live on protected GitHub environments that need a maintainer's
  approval for each run, are only passed to the steps that use them, and are never printed. Third-party tools run with
  them are pinned by version and checksum.
- **Packages**: each package ships only its build output and licences, with no install scripts (npm) or prebuilt
  downloads (Swift).
- **MCP server and CLI**: file paths and build inputs are never taken from MCP clients or document contents.

Open hardening items (not vulnerabilities): run the Unity and Godot publish jobs in the protected `release`
environment, and pin the Godot binary that the addon test downloads by checksum.

## How OpenBone is built to be safe

- **Scripts in animation files** run in a sandbox: QuickJS in the web player and the native runtimes, Jint in C#, with
  no file, network or host access beyond the inputs the document declares.
- **The MCP server** talks to its client over stdio, or over HTTP and a WebSocket bridge bound to `127.0.0.1` only, so
  other machines can't reach it.
- **Desktop installers** are built by GitHub Actions from the tagged source. The macOS app is signed with a Developer
  ID and notarized by Apple; Windows code signing is being set up.
- **Dependencies** are permissively licensed open source, and npm packages are published with provenance, so anyone
  can check which commit and workflow built them.
