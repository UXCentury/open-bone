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

/**
 * Alpha bleeding for straight-alpha RGBA pixels: give fully transparent pixels the average colour of their visible
 * neighbours, spreading `passes` pixels out from every edge. Transparent pixels decode as black, so a renderer that
 * filters (or blends) straight-alpha images mixes that black into the edges and draws a dark rim around every part.
 * Bled pixels stay fully transparent; only their colour changes. Not needed for premultiplied images.
 */
inline void bleedTransparentEdges(uint8_t* px, int w, int h, int passes = 4) {
  if (!px || w <= 0 || h <= 0) return;
  std::vector<uint8_t> filled((size_t)w * h);
  for (size_t i = 0; i < filled.size(); i++) filled[i] = px[i * 4 + 3] != 0;
  std::vector<uint8_t> next = filled;
  for (int pass = 0; pass < passes; pass++) {
    bool changed = false;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        const size_t i = (size_t)y * w + x;
        if (filled[i]) continue;
        int r = 0, g = 0, b = 0, n = 0;
        for (int dy = -1; dy <= 1; dy++)
          for (int dx = -1; dx <= 1; dx++) {
            const int nx = x + dx, ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && filled[(size_t)ny * w + nx]) {
              const uint8_t* q = px + ((size_t)ny * w + nx) * 4;
              r += q[0], g += q[1], b += q[2], n++;
            }
          }
        if (!n) continue;
        uint8_t* p = px + i * 4;
        p[0] = (uint8_t)(r / n), p[1] = (uint8_t)(g / n), p[2] = (uint8_t)(b / n);
        next[i] = 1;
        changed = true;
      }
    if (!changed) break;
    filled = next;
  }
}

}  // namespace openbone::assets
