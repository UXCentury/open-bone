// Bounding-box queries through the C API (ob_bounds_*), replayed against conformance/expected/bounds.json
// (conformance/README.md "Bounding-box queries"): boxes, aabb, points, segments, aabbs and others per sample.
//
//   openbone_c_bounds <repo root> <expected bounds.json>
// SPDX-License-Identifier: MIT
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"
#include "openbone.h"

using json = nlohmann::json;

namespace {

int failures = 0;
void fail(const std::string& where, const std::string& what) {
  if (failures++ < 20) std::printf("  FAIL %s: %s\n", where.c_str(), what.c_str());
}
bool near(double a, double b) { return std::fabs(a - b) <= 1e-3 + 5e-5 + 1e-9; }

json indices(int count, const std::vector<int>& buf) {
  json a = json::array();
  for (int i = 0; i < count; i++) a.push_back(buf[i]);
  return a;
}

void check(const std::string& p, const ob_bounds* b, const std::vector<ob_bounds*>& others, const json& q, const json& ref) {
  const int n = ob_bounds_count(b);
  const json& boxes = ref["boxes"];
  if (n != (int)boxes.size()) return fail(p, "box count " + std::to_string(n) + " vs " + std::to_string(boxes.size()));
  for (int i = 0; i < n; i++) {
    ob_bounding_box box;
    if (!ob_bounds_box(b, i, &box)) return fail(p, ob_last_error());
    const json& r = boxes[i];
    if (r["slot"] != box.slot || r["attachment"] != box.attachment) fail(p, std::string("box ") + box.slot + "/" + box.attachment + " vs " + r.dump());
    if ((int)r["vertices"].size() != box.vertex_count * 2) fail(p, "vertex count");
    else
      for (int k = 0; k < box.vertex_count * 2; k++)
        if (!near(box.vertices[k], r["vertices"][k].get<double>())) fail(p, "vertex " + std::to_string(k));
  }
  double aabb[4];
  const int has = ob_bounds_aabb(b, aabb);
  if (ref["aabb"].is_null() != !has) fail(p, "aabb presence");
  else if (has)
    for (int k = 0; k < 4; k++)
      if (!near(aabb[k], ref["aabb"][k].get<double>())) fail(p, "aabb");
  std::vector<int> buf(std::max(n, 1));
  for (size_t i = 0; i < q["points"].size(); i++) {
    const double x = q["points"][i][0], y = q["points"][i][1];
    const int c = ob_bounds_contains_point_all(b, x, y, buf.data(), (int)buf.size());
    const json got = indices(c, buf);
    if (got != ref["points"][i]) fail(p, "point " + std::to_string(i) + ": " + got.dump() + " vs " + ref["points"][i].dump());
    if (ob_bounds_contains_point(b, x, y) != (c ? buf[0] : -1)) fail(p, "contains_point vs _all");
    if (ob_bounds_contains_point_all(b, x, y, nullptr, 0) != c) fail(p, "contains_point_all count without buffer");
  }
  for (size_t i = 0; i < q["segments"].size(); i++) {
    const json& s = q["segments"][i];
    const int c = ob_bounds_intersects_segment_all(b, s[0], s[1], s[2], s[3], buf.data(), (int)buf.size());
    const json got = indices(c, buf);
    if (got != ref["segments"][i]) fail(p, "segment " + std::to_string(i) + ": " + got.dump() + " vs " + ref["segments"][i].dump());
    if (ob_bounds_intersects_segment(b, s[0], s[1], s[2], s[3]) != (c ? buf[0] : -1)) fail(p, "intersects_segment vs _all");
  }
  for (size_t i = 0; i < q["aabbs"].size(); i++) {
    const json& a = q["aabbs"][i];
    if ((ob_bounds_aabb_intersects(b, a[0], a[1], a[2], a[3]) != 0) != ref["aabbs"][i].get<bool>()) fail(p, "aabb query " + std::to_string(i));
  }
  for (size_t i = 0; i < others.size(); i++) {
    int mine = -1, theirs = -1;
    const json got = ob_bounds_intersects_bounds(b, others[i], &mine, &theirs) ? json({mine, theirs}) : json(nullptr);
    if (got != ref["others"][i]) fail(p, "others " + std::to_string(i) + ": " + got.dump() + " vs " + ref["others"][i].dump());
  }
  if (ob_bounds_aabb_contains_point(b, aabb[0], aabb[1]) != has) fail(p, "aabb_contains_point at the corner");
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <repo root> <bounds.json>\n", argv[0]);
    return 2;
  }
  std::ifstream f(argv[2], std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  const json expected = json::parse(ss.str());
  const json& q = expected["queries"];
  ob_document* doc = ob_document_load_file((std::string(argv[1]) + "/" + expected["document"].get<std::string>()).c_str());
  if (!doc) {
    std::printf("load failed: %s\n", ob_last_error());
    return 1;
  }
  std::vector<ob_bounds*> others;
  for (const auto& xy : q["others"]) {
    ob_instance* o = ob_instance_create(doc, 0);
    ob_instance_set_transform(o, xy[0], xy[1], 1, 1);
    ob_instance_advance(o, 0);
    ob_bounds* b = ob_bounds_create();
    ob_bounds_update(b, o);
    ob_instance_free(o);  // the snapshot outlives its instance
    others.push_back(b);
  }
  const double dt = 1.0 / 60;
  int cases = 0;
  for (const auto& c : expected["cases"]) {
    const std::string kind = c["kind"];
    if (kind != "setup" && kind != "animation") continue;
    cases++;
    ob_instance* inst = ob_instance_create(doc, 0);
    if (c["skin"].is_string()) ob_instance_set_skin(inst, c["skin"].get<std::string>().c_str());
    if (kind == "animation") ob_instance_play(inst, c["animation"].get<std::string>().c_str(), 1, 0);
    ob_bounds* b = ob_bounds_create();
    const json& samples = c["samples"];
    const int steps = (int)std::lround(c["duration"].get<double>() / dt);
    ob_instance_advance(inst, 0);
    size_t s = 0;
    for (int i = 0; i <= steps && s < samples.size(); i++) {
      if (i > 0) ob_instance_advance(inst, dt);
      if (i % 10 != 0) continue;
      ob_bounds_update(b, inst);
      check(c["name"].get<std::string>() + " t=" + samples[s]["t"].dump(), b, others, q, samples[s]["bounds"]);
      s++;
    }
    if (s != samples.size()) fail(c["name"], "sample count");
    ob_bounds_free(b);
    ob_instance_free(inst);
  }
  for (auto* b : others) ob_bounds_free(b);
  ob_document_free(doc);
  std::printf(failures ? "c_bounds FAILED (%d)\n" : "c_bounds OK (%d cases)\n", failures ? failures : cases);
  return failures ? 1 : 0;
}
