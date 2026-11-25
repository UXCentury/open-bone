// The document's textureFilter and the atlas's filterMin/filterMag/wrap, read through the C API
// (docs/runtime-spec.md "Atlas": an atlas's own filters win for its pages, then textureFilter, then linear + clamp).
// SPDX-License-Identifier: MIT
#include <cstdio>
#include <cstring>
#include <string>

#include "openbone.h"

static int failures = 0;
static void expect(int got, int want, const char* what) {
  if (got != want) {
    std::printf("FAIL %s: got %d, want %d\n", what, got, want);
    failures++;
  }
}

static ob_document* load(const std::string& extra, const std::string& atlas) {
  const std::string text = "{\"format\":\"openbone\",\"version\":1,\"name\":\"t\",\"width\":8,\"height\":8,\"originX\":0,\"originY\":0,"
                           "\"background\":null,\"fps\":30" + extra +
                           ",\"images\":[{\"id\":\"img\",\"name\":\"a\",\"src\":\"a.png\",\"width\":4,\"height\":4}]" + atlas +
                           ",\"skeleton\":{\"bones\":[],\"slots\":[],\"skins\":[]},\"animations\":[],\"stateMachines\":[]}";
  ob_document* d = ob_document_load_memory(text.data(), text.size());
  if (!d) std::printf("load failed: %s\n", ob_last_error());
  return d;
}

int main() {
  const std::string page = ",\"atlas\":{\"pages\":[{\"id\":\"pg\",\"name\":\"p\",\"src\":\"p.png\",\"width\":8,\"height\":8}],\"regions\":[]";
  ob_texture_sampling s;

  ob_document* d = load("", page + "}");
  if (!d) return 1;
  expect(ob_document_texture_filter_nearest(d), 0, "absent textureFilter");
  expect(ob_document_texture_sampling(d, 1, &s), 1, "image sampling");
  expect(s.nearest, 0, "absent: image smooth");
  expect(s.min, OB_FILTER_LINEAR, "absent: image min");
  ob_document_free(d);

  d = load(",\"textureFilter\":\"nearest\"", page + "}");
  if (!d) return 1;
  expect(ob_document_texture_filter_nearest(d), 1, "nearest textureFilter");
  for (int i = 0; i < 2; i++) {
    ob_document_texture_sampling(d, i, &s);
    expect(s.nearest, 1, i ? "nearest: image" : "nearest: page");
    expect(s.min, OB_FILTER_NEAREST, "nearest: min");
    expect(s.mag, OB_FILTER_NEAREST, "nearest: mag");
    expect(s.wrap_x, OB_WRAP_CLAMP, "nearest: wrap");
  }
  expect(ob_document_texture_sampling(d, 2, &s), 0, "no such texture");
  ob_document_free(d);

  // The atlas's own filters win for its pages; the image still follows textureFilter.
  d = load(",\"textureFilter\":\"nearest\"", page + ",\"filterMin\":\"mipmapLinearLinear\",\"filterMag\":\"linear\",\"wrapX\":\"repeat\"}");
  if (!d) return 1;
  ob_document_texture_sampling(d, 0, &s);
  expect(s.nearest, 0, "atlas filters: page smooth");
  expect(s.min, OB_FILTER_MIPMAP_LINEAR_LINEAR, "atlas filters: min");
  expect(s.mipmaps, 1, "atlas filters: mipmaps");
  expect(s.wrap_x, OB_WRAP_REPEAT, "atlas filters: wrapX");
  expect(s.wrap_y, OB_WRAP_CLAMP, "atlas filters: wrapY");
  ob_document_texture_sampling(d, 1, &s);
  expect(s.nearest, 1, "atlas filters: image nearest");
  ob_document_free(d);

  // An atlas that only sets a wrap keeps textureFilter for its filters; one that sets filterMag nearest is pixel art.
  d = load(",\"textureFilter\":\"nearest\"", page + ",\"wrapY\":\"mirroredRepeat\"}");
  if (!d) return 1;
  ob_document_texture_sampling(d, 0, &s);
  expect(s.nearest, 1, "wrap only: nearest");
  expect(s.wrap_y, OB_WRAP_MIRRORED_REPEAT, "wrap only: wrapY");
  ob_document_free(d);
  d = load("", page + ",\"filterMag\":\"nearest\"}");
  if (!d) return 1;
  ob_document_texture_sampling(d, 0, &s);
  expect(s.nearest, 1, "atlas filterMag nearest: page");
  expect(s.min, OB_FILTER_LINEAR, "atlas filterMag nearest: min stays linear");
  ob_document_texture_sampling(d, 1, &s);
  expect(s.nearest, 0, "atlas filterMag nearest: image smooth");
  ob_document_free(d);

  std::printf(failures ? "%d failures\n" : "texture filter OK\n", failures);
  return failures ? 1 : 0;
}
