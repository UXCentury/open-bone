#!/usr/bin/env sh
# Builds libopenbone for the host (Linux/macOS) into .dart_tool/openbone_native, where the tests and
# `dart run`/`flutter test` look for it (override with OPENBONE_LIBRARY=/path/to/libopenbone.so).
set -eu
cd "$(dirname "$0")/.."
OUT=.dart_tool/openbone_native
cmake -S src -B "$OUT/build" -DCMAKE_BUILD_TYPE=Release ${CMAKE_GENERATOR:+-G "$CMAKE_GENERATOR"}
cmake --build "$OUT/build" --target openbone_shared --parallel
LIB=$(find "$OUT/build" -name 'libopenbone.so' -o -name 'libopenbone.dylib' | head -n 1)
cp "$LIB" "$OUT/"
echo "built $OUT/$(basename "$LIB")"
