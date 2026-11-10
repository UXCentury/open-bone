#!/usr/bin/env bash
# Assembles the ready-to-install Godot addon (addons/openbone/) from prebuilt GDExtension libraries.
#
#   package.sh [--strict] [--branch] [--zip FILE] OUT_DIR BIN_DIR...
#
# BIN_DIR: folders holding libraries built with -DOPENBONE_GODOT_ADDON=ON (libopenbone.<platform>.<target>.<arch>.so,
#          openbone.windows.….dll, libopenbone.macos.….dylib). Searched recursively, so one folder of downloaded CI
#          artifacts works too.
# OUT_DIR: gets addons/openbone/ (replaced if it exists; nothing else in OUT_DIR is removed).
# --strict  fail unless every library listed in openbone.gdextension is present (release builds).
# --branch  also write the root files of the godot-addon branch (README.md, LICENSE, icon.png, .gitattributes, .gitignore).
# --zip F   also write F, a zip of addons/openbone (unzip it into a Godot project).
#
# Example (Linux, local):
#   cmake -S runtimes/cpp/engines/godot -B build-godot-addon -DCMAKE_BUILD_TYPE=Release \
#         -DOPENBONE_GODOT_ADDON=ON -DOPENBONE_GODOT_OUT="$PWD/godot-bin"
#   cmake --build build-godot-addon --config Release -j
#   runtimes/cpp/engines/godot/package.sh dist/godot godot-bin
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
strict=0 branch=0 zip=""
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) strict=1; shift ;;
    --branch) branch=1; shift ;;
    --zip) zip="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "package.sh: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
if [ $# -lt 2 ]; then
  echo "usage: package.sh [--strict] [--branch] [--zip FILE] OUT_DIR BIN_DIR..." >&2
  exit 2
fi
out="$1"; shift
mkdir -p "$out"
out="$(cd "$out" && pwd)"
addon="$out/addons/openbone"

rm -rf "$addon"
mkdir -p "$addon/bin" "$addon/icons"
cp "$here/addon/openbone.gdextension" "$here/addon/README.md" "$here/addon/LICENSE" "$addon/"
cp "$here/addon/icons/"*.svg "$addon/icons/"

# Libraries: only the extension itself (no import libraries, .pdb, .exp, …).
found=0
for dir in "$@"; do
  [ -d "$dir" ] || { echo "package.sh: $dir is not a folder" >&2; exit 2; }
  while IFS= read -r -d '' f; do
    cp "$f" "$addon/bin/"
    found=$((found + 1))
  done < <(find "$dir" -type f \( -name 'libopenbone.*.so' -o -name 'openbone.*.dll' -o -name 'libopenbone.*.dll' -o -name 'libopenbone.*.dylib' \) -print0)
done
[ "$found" -gt 0 ] || { echo "package.sh: no libraries found in $*" >&2; exit 1; }

# Check the libraries against openbone.gdextension.
missing=0
while IFS= read -r lib; do
  if [ -f "$addon/bin/$lib" ]; then
    echo "  ok       bin/$lib"
  else
    echo "  missing  bin/$lib"
    missing=$((missing + 1))
  fi
done < <(sed -n 's|^[a-z.0-9_]* *= *"res://addons/openbone/bin/\(.*\)"|\1|p' "$addon/openbone.gdextension")
for f in "$addon/bin/"*; do
  grep -q "bin/$(basename "$f")\"" "$addon/openbone.gdextension" || echo "  unlisted bin/$(basename "$f") (not in openbone.gdextension)"
done
if [ "$missing" -gt 0 ]; then
  if [ "$strict" = 1 ]; then echo "package.sh: $missing librar(y/ies) missing" >&2; exit 1; fi
  echo "package.sh: $missing platform librar(y/ies) missing; Godot reports an error only on those platforms."
fi

if [ "$branch" = 1 ]; then
  cp "$here/asset-library/README.md" "$here/asset-library/.gitattributes" "$here/asset-library/.gitignore" "$here/asset-library/icon.png" "$out/"
  cp "$here/addon/LICENSE" "$out/LICENSE"
fi

if [ -n "$zip" ]; then
  mkdir -p "$(dirname "$zip")"
  zip="$(cd "$(dirname "$zip")" && pwd)/$(basename "$zip")"
  rm -f "$zip"
  (cd "$out" && cmake -E tar cf "$zip" --format=zip addons/openbone)
  echo "wrote $zip"
fi
echo "assembled $addon"
