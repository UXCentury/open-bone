// Conformance runner: replays every case of conformance/expected/<name>.json (see conformance/README.md) on the
// C++ runtime and compares each sample within the suite's tolerances. Exit code 0 = every case matches.
//
//   openbone_conformance --root <repo> <expected.json>... [--case <name>] [--max <n>] [--dump <case>]
// SPDX-License-Identifier: MIT
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"
#include "openbone/runtime.hpp"

using json = nlohmann::json;
using namespace openbone;

namespace {

constexpr double DT = 1.0 / 60;
constexpr int SAMPLE_EVERY = 10;
const double SLACK = 5e-5 + 1e-9;  // reference values are rounded to 4 decimals
double tolScale = 1;               // --strict: 0 (only the rounding slack)

double r4(double n) {
  double v = std::floor(n * 1e4 + 0.5) / 1e4;
  return v == 0 ? 0 : v;
}

/** Bounding-box queries of a fixture (conformance/README.md "Bounding-box queries"). */
struct BoundsQueries {
  json q;
  std::vector<SkeletonBounds> others;  // one per placement
  json record(const Skeleton& sk, std::vector<std::string>& errors) const {
    const SkeletonBounds b = sk.boundingBoxes();
    json r;
    json boxes = json::array();
    for (const auto& x : b.boxes)
      boxes.push_back({{"slot", x.slot->name}, {"attachment", x.attachment->name}, {"vertices", std::vector<double>(x.vertices.begin(), x.vertices.end())}});
    r["boxes"] = boxes;
    r["aabb"] = b.boxes.empty() ? json(nullptr) : json({b.minX, b.minY, b.maxX, b.maxY});
    json points = json::array(), segments = json::array(), aabbs = json::array(), others = json::array();
    for (const auto& p : q["points"]) {
      const auto all = b.containsPointAll(p[0], p[1]);
      if (b.containsPoint(p[0], p[1]) != (all.empty() ? -1 : all[0])) errors.push_back("containsPoint disagrees with containsPointAll");
      points.push_back(all);
    }
    for (const auto& s : q["segments"]) {
      const auto all = b.intersectsSegmentAll(s[0], s[1], s[2], s[3]);
      if (b.intersectsSegment(s[0], s[1], s[2], s[3]) != (all.empty() ? -1 : all[0])) errors.push_back("intersectsSegment disagrees with intersectsSegmentAll");
      segments.push_back(all);
    }
    for (const auto& a : q["aabbs"]) aabbs.push_back(b.aabbIntersects(a[0], a[1], a[2], a[3]));
    for (const auto& o : this->others) {
      const auto pair = b.intersectsBounds(o);
      others.push_back(pair ? json({pair->first, pair->second}) : json(nullptr));
    }
    r["points"] = points;
    r["segments"] = segments;
    r["aabbs"] = aabbs;
    r["others"] = others;
    return r;
  }
};

struct Recorder {
  const BoundsQueries* bounds = nullptr;
  std::vector<std::string> boundsErrors;
  json events = json::array();
  json audio = json::array();
  std::map<std::string, std::string> ids;
  void attach(Instance& inst) {
    inst.onEvent = [this](const FiredEvent& e) {
      events.push_back({{"name", e.name}, {"time", r4(e.time)}, {"int", e.intValue}, {"float", r4(e.floatValue)}, {"string", e.stringValue}});
    };
    inst.onAudio = [this](const AudioCommand& c) {
      auto it = ids.find(c.id);
      std::string id = it != ids.end() ? it->second : "p" + std::to_string(ids.size() + 1);
      ids[c.id] = id;
      json o;
      if (c.type == AudioCommand::Type::Play) {
        o = {{"type", "play"}, {"id", id}, {"sound", c.sound}, {"asset", c.asset}, {"bus", c.bus ? json(*c.bus) : json(nullptr)},
             {"volume", r4(c.volume)}, {"rate", r4(c.rate)}, {"loop", c.loop}, {"fadeIn", r4(c.fadeIn)}, {"source", c.source}};
      } else if (c.type == AudioCommand::Type::Stop) {
        o = {{"type", "stop"}, {"id", id}, {"fade", r4(c.fade)}};
      } else {
        o = {{"type", "fade"}, {"id", id}, {"volume", r4(c.volume)}, {"duration", r4(c.duration)}};
      }
      audio.push_back(o);
    };
  }
  json sample(Instance& inst, double t) {
    Skeleton& sk = *inst.skeleton;
    json s;
    s["t"] = r4(t);
    json bones = json::array();
    for (const auto& b : sk.bones) bones.push_back({b->world.a, b->world.b, b->world.c, b->world.d, b->world.x, b->world.y});
    s["bones"] = bones;
    json slots = json::array();
    for (const auto& sl : sk.slots) {
      json row = json::array();
      row.push_back(sl->attachmentName ? json(*sl->attachmentName) : json(nullptr));
      row.push_back({sl->color[0], sl->color[1], sl->color[2], sl->color[3]});
      row.push_back(sl->dark ? json({(*sl->dark)[0], (*sl->dark)[1], (*sl->dark)[2]}) : json(nullptr));
      slots.push_back(row);
    }
    s["slots"] = slots;
    DrawList dl = sk.drawList();
    json draw = json::array();
    std::vector<int> clipsUsed;
    for (const auto& it : dl.items) {
      json d;
      d["slot"] = it.slot->data->name;
      d["attachment"] = it.attachment->name;
      d["type"] = it.type;
      d["blend"] = blendName(it.blend);
      d["texture"] = it.texture ? json(it.texture->id) : json(nullptr);
      d["vertices"] = std::vector<double>(it.vertices.begin(), it.vertices.end());
      d["uvs"] = std::vector<double>(it.uvs.begin(), it.uvs.end());
      d["indices"] = std::vector<int>(it.indices.begin(), it.indices.end());
      d["color"] = {it.color[0], it.color[1], it.color[2], it.color[3]};
      if (it.dark) d["dark"] = {(*it.dark)[0], (*it.dark)[1], (*it.dark)[2]};
      if (it.isParticles) d["colors"] = std::vector<double>(it.colors.begin(), it.colors.end());
      if (it.clip >= 0) {
        int idx = -1;
        for (size_t k = 0; k < clipsUsed.size(); k++)
          if (clipsUsed[k] == it.clip) idx = int(k);
        if (idx < 0) {
          clipsUsed.push_back(it.clip);
          idx = int(clipsUsed.size()) - 1;
        }
        d["clip"] = idx;
      }
      if (it.text) d["text"] = it.text->content;
      draw.push_back(d);
    }
    s["draw"] = draw;
    s["events"] = events;
    s["audio"] = audio;
    if (inst.stateMachine) {
      json st = json::object();
      for (const auto& [layer, state] : inst.stateMachine->activeStates()) st[layer] = state ? json(*state) : json(nullptr);
      s["states"] = st;
    }
    if (bounds) s["bounds"] = bounds->record(sk, boundsErrors);
    events = json::array();
    audio = json::array();
    return s;
  }
};

struct Compare {
  std::vector<std::string> errors;
  size_t max = 12;
  void fail(const std::string& path, const std::string& what) {
    if (errors.size() < max) errors.push_back(path + ": " + what);
    else if (errors.size() == max) errors.push_back("…");
  }
  static std::string show(const json& j) {
    std::string s = j.dump();
    return s.size() > 200 ? s.substr(0, 200) + "…" : s;
  }
  void num(const std::string& path, const json& mine, const json& ref, double tol) {
    const bool mn = mine.is_null() || (mine.is_number() && std::isnan(mine.get<double>()));
    if (ref.is_null()) {
      if (!mn) fail(path, "expected null/NaN, got " + show(mine));
      return;
    }
    if (!mine.is_number()) return fail(path, "expected " + show(ref) + ", got " + show(mine));
    const double a = mine.get<double>(), b = ref.get<double>();
    if (!(std::fabs(a - b) <= tol * tolScale + SLACK)) {
      char buf[160];
      std::snprintf(buf, sizeof buf, "%.6f vs reference %.6f (diff %.2e, tol %.0e)", a, b, std::fabs(a - b), tol);
      fail(path, buf);
    }
  }
  void nums(const std::string& path, const json& mine, const json& ref, double tol) {
    if (!ref.is_array() || !mine.is_array() || mine.size() != ref.size())
      return fail(path, "length " + std::to_string(mine.size()) + " vs reference " + std::to_string(ref.size()));
    for (size_t i = 0; i < ref.size(); i++) num(path + "[" + std::to_string(i) + "]", mine[i], ref[i], tol);
  }
  void exact(const std::string& path, const json& mine, const json& ref) {
    if (mine != ref) fail(path, show(mine) + " vs reference " + show(ref));
  }
  void sample(const std::string& p, const json& m, const json& r) {
    num(p + ".t", m["t"], r["t"], 1e-9);
    const json &mb = m["bones"], &rb = r["bones"];
    if (mb.size() != rb.size()) fail(p + ".bones", "count " + std::to_string(mb.size()) + " vs " + std::to_string(rb.size()));
    else
      for (size_t i = 0; i < rb.size(); i++)
        for (int k = 0; k < 6; k++) num(p + ".bones[" + std::to_string(i) + "][" + std::to_string(k) + "]", mb[i][k], rb[i][k], k < 4 ? 1e-4 : 1e-3);
    const json &ms = m["slots"], &rs = r["slots"];
    if (ms.size() != rs.size()) fail(p + ".slots", "count " + std::to_string(ms.size()) + " vs " + std::to_string(rs.size()));
    else
      for (size_t i = 0; i < rs.size(); i++) {
        const std::string q = p + ".slots[" + std::to_string(i) + "]";
        exact(q + ".attachment", ms[i][0], rs[i][0]);
        nums(q + ".color", ms[i][1], rs[i][1], 1.0 / 255);
        if (rs[i][2].is_null() || ms[i][2].is_null()) exact(q + ".dark", ms[i][2].is_null() ? json(nullptr) : json("set"), rs[i][2].is_null() ? json(nullptr) : json("set"));
        else nums(q + ".dark", ms[i][2], rs[i][2], 1.0 / 255);
      }
    const json &md = m["draw"], &rd = r["draw"];
    if (md.size() != rd.size()) {
      std::string a, b;
      for (const auto& x : md) a += x["slot"].get<std::string>() + " ";
      for (const auto& x : rd) b += x["slot"].get<std::string>() + " ";
      fail(p + ".draw", "count " + std::to_string(md.size()) + " vs " + std::to_string(rd.size()) + " [" + a + "] vs [" + b + "]");
    } else
      for (size_t i = 0; i < rd.size(); i++) {
        const json &x = md[i], &y = rd[i];
        const std::string q = p + ".draw[" + std::to_string(i) + "](" + y["slot"].get<std::string>() + ")";
        for (const char* k : {"slot", "attachment", "type", "blend", "texture"}) exact(q + "." + k, x[k], y[k]);
        const bool particles = y["type"] == "particles";
        nums(q + ".vertices", x["vertices"], y["vertices"], particles ? 1e-2 : 1e-3);
        nums(q + ".uvs", x["uvs"], y["uvs"], 1e-3);
        exact(q + ".indices", x["indices"], y["indices"]);
        nums(q + ".color", x["color"], y["color"], 1.0 / 255);
        if (y.contains("dark") != x.contains("dark")) fail(q + ".dark", x.contains("dark") ? "unexpected" : "missing");
        else if (y.contains("dark")) nums(q + ".dark", x["dark"], y["dark"], 1.0 / 255);
        if (y.contains("colors") != x.contains("colors")) fail(q + ".colors", x.contains("colors") ? "unexpected" : "missing");
        else if (y.contains("colors")) nums(q + ".colors", x["colors"], y["colors"], 1.0 / 255);
        exact(q + ".clip", x.contains("clip") ? x["clip"] : json(nullptr), y.contains("clip") ? y["clip"] : json(nullptr));
        exact(q + ".text", x.contains("text") ? x["text"] : json(nullptr), y.contains("text") ? y["text"] : json(nullptr));
      }
    const json &me = m["events"], &re = r["events"];
    if (me.size() != re.size()) fail(p + ".events", show(me) + " vs reference " + show(re));
    else
      for (size_t i = 0; i < re.size(); i++) {
        const std::string q = p + ".events[" + std::to_string(i) + "]";
        exact(q + ".name", me[i]["name"], re[i]["name"]);
        exact(q + ".string", me[i]["string"], re[i]["string"]);
        num(q + ".time", me[i]["time"], re[i]["time"], 1e-4);
        num(q + ".int", me[i]["int"], re[i]["int"], 1e-9);
        num(q + ".float", me[i]["float"], re[i]["float"], 1e-4);
      }
    const json &ma = m["audio"], &ra = r["audio"];
    if (ma.size() != ra.size()) fail(p + ".audio", show(ma) + " vs reference " + show(ra));
    else
      for (size_t i = 0; i < ra.size(); i++) {
        const std::string q = p + ".audio[" + std::to_string(i) + "]";
        for (auto it = ra[i].begin(); it != ra[i].end(); ++it) {
          const json& mv = ma[i].contains(it.key()) ? ma[i][it.key()] : json();
          if (it.value().is_number()) num(q + "." + it.key(), mv, it.value(), 1e-4);
          else exact(q + "." + it.key(), mv, it.value());
        }
        if (ma[i].size() != ra[i].size()) fail(q, show(ma[i]) + " vs reference " + show(ra[i]));
      }
    if (r.contains("bounds") != m.contains("bounds")) fail(p + ".bounds", m.contains("bounds") ? "unexpected" : "missing");
    else if (r.contains("bounds")) {
      const json &mb2 = m["bounds"], &rb2 = r["bounds"];
      const json &mx = mb2["boxes"], &rx = rb2["boxes"];
      if (mx.size() != rx.size()) fail(p + ".bounds.boxes", show(mx) + " vs reference " + show(rx));
      else
        for (size_t i = 0; i < rx.size(); i++) {
          const std::string q = p + ".bounds.boxes[" + std::to_string(i) + "]";
          exact(q + ".slot", mx[i]["slot"], rx[i]["slot"]);
          exact(q + ".attachment", mx[i]["attachment"], rx[i]["attachment"]);
          nums(q + ".vertices", mx[i]["vertices"], rx[i]["vertices"], 1e-3);
        }
      if (rb2["aabb"].is_null() || mb2["aabb"].is_null()) exact(p + ".bounds.aabb", mb2["aabb"], rb2["aabb"]);
      else nums(p + ".bounds.aabb", mb2["aabb"], rb2["aabb"], 1e-3);
      for (const char* k : {"points", "segments", "aabbs", "others"}) exact(p + ".bounds." + k, mb2[k], rb2[k]);
    }
    if (r.contains("states") || m.contains("states")) exact(p + ".states", m.contains("states") ? m["states"] : json(), r.contains("states") ? r["states"] : json());
  }
};

std::vector<json> runCase(const std::shared_ptr<const Document>& doc, const json& c, std::shared_ptr<ScriptHost> host, const BoundsQueries* bounds,
                          std::vector<std::string>& boundsErrors) {
  const std::string kind = c["kind"];
  const double duration = c["duration"].get<double>();
  const int steps = (int)std::lround(duration / DT);
  auto inst = std::make_unique<Instance>(doc, host);
  Recorder rec;
  rec.bounds = bounds;
  if (kind != "stateMachine" && c["skin"].is_string()) inst->skeleton->setSkin(c["skin"].get<std::string>());
  StateMachineInstance* machine = nullptr;
  if (kind == "animation") inst->play(c["animation"].get<std::string>(), true);
  if (kind == "stateMachine") machine = &inst->useStateMachine(c["stateMachine"].get<std::string>());
  rec.attach(*inst);
  std::vector<json> out;
  inst->advance(0);
  out.push_back(rec.sample(*inst, 0));
  const json actions = c.contains("actions") ? c["actions"] : json::array();
  for (int i = 1; i <= steps; i++) {
    const double t = (i - 1) * DT;
    for (const auto& a : actions) {
      if (std::fabs(a["t"].get<double>() - t) > DT / 2) continue;
      try {
        if (a.contains("fire")) machine->fire(a["fire"].get<std::string>());
        else if (a.contains("input")) {
          const json& v = a["value"];
          Value val = v.is_boolean() ? Value::boolean(v.get<bool>()) : v.is_number() ? Value::number(v.get<double>()) : Value::string(v.get<std::string>());
          machine->setInput(a["input"].get<std::string>(), val);
        } else {
          const std::string p = a["pointer"];
          inst->pointer(p == "down" ? PointerEvent::Down : p == "up" ? PointerEvent::Up : PointerEvent::Move, a["x"].get<double>(), a["y"].get<double>());
        }
      } catch (const std::exception& e) {
        std::cerr << "  action failed: " << e.what() << "\n";
      }
    }
    inst->advance(DT);
    if (i % SAMPLE_EVERY == 0) out.push_back(rec.sample(*inst, i * DT));
  }
  inst->dispose();
  boundsErrors = rec.boundsErrors;
  return out;
}

std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

}  // namespace

int main(int argc, char** argv) {
  std::string root = ".";
  std::vector<std::string> files;
  std::string onlyCase, dumpCase;
  size_t maxErrors = 12;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--root" && i + 1 < argc) root = argv[++i];
    else if (a == "--case" && i + 1 < argc) onlyCase = argv[++i];
    else if (a == "--dump" && i + 1 < argc) dumpCase = argv[++i];
    else if (a == "--strict") tolScale = 0;
    else if (a == "--max" && i + 1 < argc) maxErrors = std::stoul(argv[++i]);
    else files.push_back(a);
  }
  auto host = createQuickJsHost();
  int failedCases = 0, totalCases = 0;
  for (const auto& file : files) {
    json expected = json::parse(readFile(file));
    const std::string docPath = root + "/" + expected["document"].get<std::string>();
    std::shared_ptr<const Document> doc;
    try {
      doc = loadFile(docPath);
    } catch (const std::exception& e) {
      std::cout << "FAIL " << file << ": cannot load " << docPath << ": " << e.what() << "\n";
      failedCases++;
      continue;
    }
    std::unique_ptr<BoundsQueries> bounds;
    if (expected.contains("queries")) {
      bounds = std::make_unique<BoundsQueries>();
      bounds->q = expected["queries"];
      for (const auto& xy : bounds->q["others"]) {
        // A second instance of the document at the placement: setup pose, default skin.
        Instance other(doc, host);
        other.skeleton->x = xy[0].get<double>();
        other.skeleton->y = xy[1].get<double>();
        other.advance(0);
        bounds->others.push_back(other.skeleton->boundingBoxes());
        other.dispose();
      }
    }
    int passed = 0, count = 0;
    for (const auto& c : expected["cases"]) {
      const std::string name = c["name"];
      if (!onlyCase.empty() && name != onlyCase) continue;
      count++;
      totalCases++;
      Compare cmp;
      cmp.max = maxErrors;
      try {
        std::vector<std::string> boundsErrors;
        std::vector<json> mine = runCase(doc, c, host, bounds.get(), boundsErrors);
        for (const auto& e : boundsErrors) cmp.fail("bounds", e);
        if (name == dumpCase) std::cout << json(mine).dump(1) << "\n";
        const json& ref = c["samples"];
        if (mine.size() != ref.size()) cmp.fail("samples", "count " + std::to_string(mine.size()) + " vs " + std::to_string(ref.size()));
        for (size_t i = 0; i < std::min(mine.size(), ref.size()); i++) {
          char p[64];
          std::snprintf(p, sizeof p, "t=%.4f", ref[i]["t"].get<double>());
          cmp.sample(p, mine[i], ref[i]);
        }
      } catch (const std::exception& e) {
        cmp.fail("run", std::string("exception: ") + e.what());
      }
      if (cmp.errors.empty()) passed++;
      else {
        failedCases++;
        std::cout << "  FAIL " << expected["fixture"].get<std::string>() << " / " << name << "\n";
        for (const auto& e : cmp.errors) std::cout << "      " << e << "\n";
      }
    }
    std::cout << (passed == count ? "PASS " : "FAIL ") << expected["fixture"].get<std::string>() << ": " << passed << "/" << count << " cases\n";
  }
  std::cout << (failedCases ? "FAILED" : "OK") << " (" << totalCases - failedCases << "/" << totalCases << " cases)\n";
  return failedCases ? 1 : 0;
}
