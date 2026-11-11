#!/usr/bin/env bash
# Stages a publishable copy of the openbone plugin: pub.dev packages cannot reach outside their folder, but in this
# repository the plugin builds runtimes/cpp through relative paths and symlinks. The copy gets:
#   - the package files git knows about (tracked or new, not ignored), symlinks kept for now;
#   - cpp/: runtimes/cpp's CMakeLists.txt, include/, src/ and third_party/ (nlohmann/json, quickjs-ng), which
#     src/CMakeLists.txt and darwin/openbone.podspec use first when present;
#   - every symlink (darwin/openbone/Sources/...) replaced by a copy of what it points to;
#   - pubspec.yaml without `publish_to: none` (which keeps this folder itself from being published by mistake);
#   - LICENSE with the bundled third-party notices appended (QuickJS, nlohmann/json, earcut).
#
#   tool/bundle.sh [OUT]       default OUT: ${TMPDIR:-/tmp}/openbone-pub/openbone (emptied first)
#   cd OUT && dart pub publish --dry-run
# SPDX-License-Identifier: MIT
set -euo pipefail

PLUGIN=$(cd "$(dirname "$0")/.." && pwd -P)
CPP=$(cd "$PLUGIN/../../cpp" && pwd -P)
OUT=${1:-${TMPDIR:-/tmp}/openbone-pub/openbone}

[ -f "$CPP/include/openbone.h" ] || { echo "runtimes/cpp not found next to the plugin ($CPP)" >&2; exit 1; }
[ -f "$CPP/third_party/quickjs/quickjs.c" ] || { echo "QuickJS missing in $CPP/third_party/quickjs" >&2; exit 1; }
case "$OUT" in "$PLUGIN" | "$PLUGIN"/*) echo "OUT must be outside the plugin folder" >&2; exit 1 ;; esac

rm -rf "$OUT"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd -P)

# 1. The package's own files, as git lists them (so build outputs and other ignored files stay behind). Symlinks are
#    left to step 3, which copies what they point to: tar can't recreate them on Windows (Git Bash's tar only makes a
#    "symlink" when its target already exists, and the C++ sources they point to are copied in step 2).
cd "$PLUGIN"
git ls-files -z --cached --others --exclude-standard -- . |
  while IFS= read -r -d '' f; do
    if [ -L "$f" ]; then continue; fi
    if [ -e "$f" ]; then printf '%s\0' "$f"; fi  # skip files deleted in the working tree
  done |
  tar --null -T - -cf - | tar -xf - -C "$OUT"

# 2. The C++ runtime and its vendored dependencies.
mkdir -p "$OUT/cpp/third_party/quickjs"
cp "$CPP/CMakeLists.txt" "$OUT/cpp/"
cp -R "$CPP/include" "$CPP/src" "$OUT/cpp/"
cp -R "$CPP/third_party/nlohmann" "$OUT/cpp/third_party/"
cp "$CPP/third_party/quickjs/"*.c "$CPP/third_party/quickjs/"*.h "$CPP/third_party/quickjs/LICENSE" "$OUT/cpp/third_party/quickjs/"

# 3. Symlinks → copies of their targets, resolved in the repository where they point. Git's index says which paths are
#    symlinks, so this also works in a checkout without symlink support (Windows), where they are plain text files
#    holding the target; symlinks git does not know about yet are found on disk.
replace_link() {  # $1: path relative to the plugin, $2: the link's target as written in the link
  local dir abs
  dir=$(dirname "$1")
  abs="$PLUGIN/$dir/$2"
  if [ -d "$abs" ]; then abs=$(cd "$abs" && pwd -P)
  elif [ -f "$abs" ]; then abs="$(cd "$(dirname "$abs")" && pwd -P)/$(basename "$abs")"
  else echo "broken symlink: $1 -> $2" >&2; exit 1
  fi
  rm -rf "${OUT:?}/$1"
  mkdir -p "$(dirname "$OUT/$1")"  # a folder holding only symlinks was not created by step 1
  cp -RL "$abs" "$OUT/$1"
}
git ls-files -s -- . | awk -F '\t' '$1 ~ /^120000 / { print $2 }' | while IFS= read -r rel; do
  [ -e "$rel" ] || [ -L "$rel" ] || continue  # deleted in the working tree
  if [ -L "$rel" ]; then target=$(readlink "$rel"); else target=$(cat "$rel"); fi
  replace_link "$rel" "$target"
done
find "$OUT" -type l | while IFS= read -r link; do
  rel=${link#"$OUT"/}
  replace_link "$rel" "$(readlink "$link")"
done
# The SwiftPM target's third_party only needs nlohmann/json; QuickJS comes from Sources/openbone_quickjs/vendor.
rm -rf "$OUT/darwin/openbone/Sources/openbone/third_party/quickjs"
if [ -n "$(find "$OUT" -type l)" ]; then
  echo "symlinks left in $OUT" >&2
  exit 1
fi

# 4. Publishable pubspec: no `publish_to: none`, and no dependency_overrides (they only serve development here and
#    never apply to apps; pub flags overridden non-dev dependencies). Comment lines right above either go with it.
awk '
  function flush() { printf "%s", buf; buf = "" }
  /^#/ { buf = buf $0 "\n"; next }
  /^publish_to: *none/ { buf = ""; next }
  /^dependency_overrides:/ { buf = ""; skip = 1; next }
  skip && (/^[ \t]/ || /^$/) { next }
  { skip = 0; flush(); print }
  END { flush() }
' "$PLUGIN/pubspec.yaml" > "$OUT/pubspec.yaml"
if grep -q '^publish_to:\|^dependency_overrides:' "$OUT/pubspec.yaml"; then
  echo "pubspec.yaml still sets publish_to or dependency_overrides" >&2
  exit 1
fi

# 5. Licences of the bundled code.
{
  printf '\n\n'
  printf -- '-------------------------------------------------------------------------------\n'
  printf 'This package bundles third-party code under the following licences.\n\n'
  printf -- '-------------------------------------------------------------------------------\n'
  printf 'QuickJS (quickjs-ng 0.10.1), cpp/third_party/quickjs and\n'
  printf 'darwin/openbone/Sources/openbone_quickjs/vendor:\n\n'
  cat "$CPP/third_party/quickjs/LICENSE"
  printf '\n-------------------------------------------------------------------------------\n'
  cat <<'EOF'
JSON for Modern C++ (nlohmann/json 3.11.3), cpp/third_party/nlohmann and
darwin/openbone/Sources/openbone/third_party/nlohmann:

MIT License

Copyright (c) 2013-2023 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

-------------------------------------------------------------------------------
earcut 3.2.4 (ported to C++ in cpp/src/geometry.cpp):

ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
EOF
} >> "$OUT/LICENSE"

echo "openbone $(sed -n 's/^version: *//p' "$OUT/pubspec.yaml") staged in $OUT ($(du -sh "$OUT" | cut -f1))"
