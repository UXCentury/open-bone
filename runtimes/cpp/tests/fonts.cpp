// Document-embedded fonts: parsing (.obone and .obonb), the family/weight matching rule and the C API.
// SPDX-License-Identifier: MIT
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "openbone.h"
#include "openbone/document.hpp"

using namespace openbone;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                  \
    }                                                              \
  } while (0)

// The smallest valid document around a fonts list.
static const char* kJson = R"({
  "format": "openbone", "version": 1, "name": "fonts", "width": 100, "height": 100, "fps": 30,
  "fonts": [
    {"id": "font_a", "name": "Display Regular", "family": "OpenBone Display", "src": "data:font/ttf;base64,AAEAAA=="},
    {"id": "font_b", "name": "Display Bold", "family": "OpenBone Display", "src": "fonts/display-bold.ttf", "weight": 700},
    {"id": "font_c", "name": "Hand Italic", "family": "Hand", "src": "fonts/hand.otf", "weight": 300, "style": "italic"}
  ],
  "skeleton": {"bones": [{"id": "b", "name": "root", "parent": null}], "slots": [], "skins": [{"id": "skin_default", "name": "default", "attachments": {}}]},
  "animations": []
})";

/** A .obonb of the same document, encoded the way core/binary.ts does it (font_a's src as a binary data: blob). */
static std::vector<uint8_t> binaryDocument() {
  std::vector<std::string> strings;
  auto sid = [&](const std::string& s) {
    for (size_t i = 0; i < strings.size(); i++)
      if (strings[i] == s) return i;
    strings.push_back(s);
    return strings.size() - 1;
  };
  std::vector<uint8_t> body;
  auto varint = [](std::vector<uint8_t>& o, uint64_t n) {
    while (n >= 0x80) {
      o.push_back(uint8_t(n & 0x7f) | 0x80);
      n >>= 7;
    }
    o.push_back(uint8_t(n));
  };
  auto s = [&](const std::string& v) { body.push_back(7), varint(body, sid(v)); };
  auto u = [&](uint64_t v) { body.push_back(3), varint(body, v); };
  auto obj = [&](size_t n) { body.push_back(9), varint(body, n); };
  auto arr = [&](size_t n) { body.push_back(8), varint(body, n); };
  auto key = [&](const std::string& k) { varint(body, sid(k)); };
  obj(9);
  key("format"), s("openbone");
  key("version"), u(1);
  key("name"), s("fonts");
  key("width"), u(100);
  key("height"), u(100);
  key("fps"), u(30);
  key("fonts"), arr(2);
  obj(4);
  key("id"), s("font_a");
  key("name"), s("Display Regular");
  key("family"), s("OpenBone Display");
  key("src");
  body.push_back(10), varint(body, sid("font/ttf"));
  const uint8_t raw[] = {0, 1, 0, 0};
  varint(body, sizeof raw);
  body.insert(body.end(), raw, raw + sizeof raw);
  obj(5);
  key("id"), s("font_b");
  key("family"), s("openbone display");
  key("src"), s("fonts/display-bold.ttf");
  key("weight"), u(700);
  key("style"), s("italic");
  key("skeleton"), obj(3);
  key("bones"), arr(1), obj(2), key("id"), s("b"), key("name"), s("root");
  key("slots"), arr(0);
  key("skins"), arr(0);
  key("animations"), arr(0);
  std::vector<uint8_t> out = {'O', 'B', 'N', 'B', 1};
  varint(out, strings.size());
  for (const auto& x : strings) varint(out, x.size()), out.insert(out.end(), x.begin(), x.end());
  out.insert(out.end(), body.begin(), body.end());
  return out;
}

int main() {
  // splitFontFamilies
  auto fams = splitFontFamilies(" Noto Serif JP, 'Open Sans' ,\"Georgia\",, serif ");
  CHECK(fams.size() == 4);
  if (fams.size() == 4) CHECK(fams[0] == "Noto Serif JP" && fams[1] == "Open Sans" && fams[2] == "Georgia" && fams[3] == "serif");
  CHECK(splitFontFamilies("").empty());

  // JSON
  auto doc = loadJson(kJson);
  CHECK(doc->fonts.size() == 3);
  if (doc->fonts.size() == 3) {
    const FontAsset& a = doc->fonts[0];
    CHECK(a.id == "font_a" && a.name == "Display Regular" && a.family == "OpenBone Display" && a.src == "data:font/ttf;base64,AAEAAA==");
    CHECK(a.weight == 400 && a.style == "normal");
    CHECK(doc->fonts[1].weight == 700 && doc->fonts[1].src == "fonts/display-bold.ttf");
    CHECK(doc->fonts[2].style == "italic" && doc->fonts[2].weight == 300);
    // Matching: case-insensitive family, closest weight, first wins a tie, nothing for other families.
    CHECK(doc->findFont("openbone display", 400) == &doc->fonts[0]);
    CHECK(doc->findFont("OPENBONE DISPLAY", 600) == &doc->fonts[1]);
    CHECK(doc->findFont("OpenBone Display", 550) == &doc->fonts[0]);
    CHECK(doc->findFont("OpenBone Display", 900) == &doc->fonts[1]);
    CHECK(doc->findFont("hand", 900) == &doc->fonts[2]);
    CHECK(doc->findFont("Georgia", 400) == nullptr);
  }
  CHECK(loadJson(R"({"format":"openbone","version":1,"skeleton":{"bones":[],"slots":[],"skins":[]}})")->fonts.empty());

  // .obonb: a data: src decodes back to a data: URL.
  const auto bin = binaryDocument();
  auto bdoc = loadDocument(bin.data(), bin.size());
  CHECK(bdoc->fonts.size() == 2);
  if (bdoc->fonts.size() == 2) {
    CHECK(bdoc->fonts[0].src == "data:font/ttf;base64,AAEAAA==");
    CHECK(bdoc->fonts[0].weight == 400 && bdoc->fonts[0].style == "normal");
    CHECK(bdoc->fonts[1].name.empty() && bdoc->fonts[1].weight == 700 && bdoc->fonts[1].style == "italic");
    CHECK(bdoc->findFont("OpenBone Display", 800) == &bdoc->fonts[1]);
  }

  // C API
  ob_document* cd = ob_document_load_memory(kJson, std::strlen(kJson));
  CHECK(cd != nullptr);
  CHECK(ob_document_font_count(cd) == 3);
  ob_font_asset f{};
  CHECK(ob_document_font(cd, 2, &f) == 1);
  CHECK(std::strcmp(f.id, "font_c") == 0 && std::strcmp(f.family, "Hand") == 0 && std::strcmp(f.src, "fonts/hand.otf") == 0);
  CHECK(f.weight == 300 && std::strcmp(f.style, "italic") == 0 && std::strcmp(f.name, "Hand Italic") == 0);
  CHECK(ob_document_font(cd, 3, &f) == 0);
  CHECK(ob_document_font(cd, -1, &f) == 0);
  CHECK(ob_document_font_count(nullptr) == 0);
  ob_document_free(cd);
  ob_document* cb = ob_document_load_memory(bin.data(), bin.size());
  CHECK(cb != nullptr && ob_document_font_count(cb) == 2);
  ob_document_free(cb);

  std::printf(failures ? "%d failures\n" : "fonts OK\n", failures);
  return failures ? 1 : 0;
}
