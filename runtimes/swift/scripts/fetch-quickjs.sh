#!/bin/sh
# Downloads quickjs-ng (MIT) into Sources/CQuickJS/vendor so the package builds with document scripts enabled —
# the same release and checksum the C++ runtime's CMake build uses. Without it the package still builds, with
# scripts disabled (OPENBONE_WITH_SCRIPTS=0).
#   ./scripts/fetch-quickjs.sh            (or OPENBONE_QUICKJS_DIR=/path/to/quickjs-ng ./scripts/fetch-quickjs.sh)
# SPDX-License-Identifier: MIT
set -eu
VERSION=0.10.1
SHA256=4e917eea3bb6051a0551fdd3aac45199ff705fa08920c15b824a08c5fbb032e4
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HERE/Sources/CQuickJS/vendor"

if [ -n "${OPENBONE_QUICKJS_DIR:-}" ]; then
  SRC="$OPENBONE_QUICKJS_DIR"
else
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  URL="https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$VERSION.tar.gz"
  echo "Downloading $URL"
  curl -sSfL -o "$TMP/quickjs.tar.gz" "$URL"
  if command -v sha256sum >/dev/null 2>&1; then SUM=$(sha256sum "$TMP/quickjs.tar.gz" | cut -d' ' -f1)
  else SUM=$(shasum -a 256 "$TMP/quickjs.tar.gz" | cut -d' ' -f1); fi
  if [ "$SUM" != "$SHA256" ]; then
    echo "checksum mismatch: $SUM" >&2
    exit 1
  fi
  mkdir "$TMP/src"
  tar xzf "$TMP/quickjs.tar.gz" -C "$TMP/src" --strip-components=1
  SRC="$TMP/src"
fi

for f in cutils.c libregexp.c libunicode.c quickjs.c xsum.c LICENSE; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }
done
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC"/cutils.c "$SRC"/libregexp.c "$SRC"/libunicode.c "$SRC"/quickjs.c "$SRC"/xsum.c "$SRC"/*.h "$SRC"/LICENSE "$DEST"/
echo "quickjs-ng $VERSION → $DEST"
