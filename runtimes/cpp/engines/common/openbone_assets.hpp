// Helpers shared by the engine samples: data: URL decoding, document-relative paths and the particle dot sprite.
// Header-only, no dependencies beyond the runtime.
// SPDX-License-Identifier: MIT
#pragma once

#include <cmath>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"

namespace openbone::assets {

/** Bytes of a texture source: a data:<mime>;base64,… URL, or a file path relative to the document's folder. */
inline std::vector<uint8_t> readSource(const std::string& src, const std::string& documentPath) {
  std::vector<uint8_t> out;
  if (src.rfind("data:", 0) == 0) {
    const size_t comma = src.find(',');
    if (comma == std::string::npos) return out;
    auto val = [](char c) -> int {
      if (c >= 'A' && c <= 'Z') return c - 'A';
      if (c >= 'a' && c <= 'z') return c - 'a' + 26;
      if (c >= '0' && c <= '9') return c - '0' + 52;
      if (c == '+' || c == '-') return 62;
      if (c == '/' || c == '_') return 63;
      return -1;
    };
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = comma + 1; i < src.size(); i++) {
      const int v = val(src[i]);
      if (v < 0) continue;
      acc = (acc << 6) | uint32_t(v);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push_back(uint8_t((acc >> bits) & 0xff));
      }
    }
    return out;
  }
  std::string dir = documentPath;
  const size_t slash = dir.find_last_of("/\\");
  dir = slash == std::string::npos ? std::string() : dir.substr(0, slash + 1);
  std::ifstream f(dir + src, std::ios::binary);
  if (f) out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return out;
}

/** RGBA8 pixels of the built-in soft round particle sprite (white, alpha from particleDotAlpha). */
inline std::vector<uint8_t> particleDot(int n = PARTICLE_DOT_SIZE) {
  std::vector<uint8_t> px(size_t(n) * n * 4);
  for (int y = 0; y < n; y++)
    for (int x = 0; x < n; x++) {
      const double dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
      uint8_t* p = &px[(size_t(y) * n + x) * 4];
      p[0] = p[1] = p[2] = 255;
      p[3] = uint8_t(std::lround(particleDotAlpha(std::sqrt(dx * dx + dy * dy)) * 255));
    }
  return px;
}

}  // namespace openbone::assets
