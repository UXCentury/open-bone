// Included first by every runtime source: results must match the reference bit for bit, so the compiler may not fuse
// a * b + c into one fused multiply-add (FMA skips the intermediate rounding; ARM64 always has it, x86-64 with -mfma).
// The pragma covers the rest of the translation unit, including the headers included after it. It does the job of
// -ffp-contract=off for builds that cannot pass compiler flags: SwiftPM rejects unsafeFlags in packages used as
// versioned dependencies. CMake still passes -ffp-contract=off, which GCC needs (it ignores the STDC pragma).
// SPDX-License-Identifier: MIT
#ifndef OPENBONE_EXACT_MATH_H
#define OPENBONE_EXACT_MATH_H
#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#endif
#endif
