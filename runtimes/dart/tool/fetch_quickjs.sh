#!/usr/bin/env sh
# Downloads QuickJS (quickjs-ng v0.10.1, MIT) into runtimes/dart/third_party/quickjs, the same version and checksum
# runtimes/cpp/CMakeLists.txt fetches. Needed for document scripts on iOS/macOS (CocoaPods cannot download at build
# time); the CMake builds (Android, Linux, Windows) use it when present and download it otherwise.
set -eu
cd "$(dirname "$0")/.."
URL=https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.10.1.tar.gz
SHA=4e917eea3bb6051a0551fdd3aac45199ff705fa08920c15b824a08c5fbb032e4
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/quickjs.tar.gz"
if command -v sha256sum >/dev/null; then echo "$SHA  $TMP/quickjs.tar.gz" | sha256sum -c -; else echo "$SHA  $TMP/quickjs.tar.gz" | shasum -a 256 -c -; fi
tar -xzf "$TMP/quickjs.tar.gz" -C "$TMP"
rm -rf third_party/quickjs
mkdir -p third_party
mv "$TMP"/quickjs-0.10.1 third_party/quickjs
echo "QuickJS ready in third_party/quickjs"
