// Compiles quickjs-ng's libregexp.c (vendor -> runtimes/cpp/third_party/quickjs) with the settings SwiftPM cannot pass as
// flags in a versioned dependency: no FMA contraction, and no warnings from upstream code. See exact_math.h.
// SPDX-License-Identifier: MIT
#pragma STDC FP_CONTRACT OFF
#pragma clang diagnostic ignored "-Weverything"
#include "vendor/libregexp.c"
