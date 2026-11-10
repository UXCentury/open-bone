// The engine samples' sound mixer (engines/common/openbone_audio.hpp): gain, voices, fades and expiry, with a
// recording output, plus the button example's commands routed through it.
// SPDX-License-Identifier: MIT
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "../engines/common/openbone_audio.hpp"

namespace ob = openbone;

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

struct Recorder : ob::audio::Output {
  std::vector<std::string> calls;
  std::string failing;
  static std::string r(double x) {
    char b[32];
    std::snprintf(b, sizeof b, "%g", std::round(x * 1000) / 1000);
    return b;
  }
  bool start(int voice, const ob::AudioAsset& a, double gain, double rate, bool loop) override {
    calls.push_back("start " + std::to_string(voice) + " " + a.id + " " + r(gain) + " " + r(rate) + (loop ? " loop" : ""));
    return a.id != failing;
  }
  void setGain(int voice, double gain) override { calls.push_back("gain " + std::to_string(voice) + " " + r(gain)); }
  void stop(int voice) override { calls.push_back("stop " + std::to_string(voice)); }
};

static std::shared_ptr<ob::Document> doc(double master, bool muted) {
  auto d = std::make_shared<ob::Document>();
  ob::AudioData a;
  a.master = master;
  a.muted = muted;
  a.assets = {{"a", "a", "a.wav", 1.0}, {"b", "b", "b.wav", 0}, {"c", "c", "c.wav", 0.5}};
  a.buses = {{"sfx", "sfx", 0.5, false}, {"off", "off", 1, true}};
  d->audio = a;
  return d;
}

static ob::AudioCommand play(const std::string& id, const std::string& asset, std::optional<std::string> bus, double volume,
                             double rate, bool loop, double fadeIn) {
  ob::AudioCommand c;
  c.type = ob::AudioCommand::Type::Play;
  c.id = id;
  c.sound = c.asset = asset;
  c.bus = bus;
  c.volume = volume;
  c.rate = rate;
  c.loop = loop;
  c.fadeIn = fadeIn;
  return c;
}

static ob::AudioCommand stop(const std::string& id, double fade) {
  ob::AudioCommand c;
  c.type = ob::AudioCommand::Type::Stop;
  c.id = id;
  c.fade = fade;
  return c;
}

static ob::AudioCommand fade(const std::string& id, double volume, double duration) {
  ob::AudioCommand c;
  c.type = ob::AudioCommand::Type::Fade;
  c.id = id;
  c.volume = volume;
  c.duration = duration;
  return c;
}

static bool same(const std::vector<std::string>& got, const std::vector<std::string>& want) {
  if (got == want) return true;
  std::printf("  got:");
  for (auto& s : got) std::printf(" [%s]", s.c_str());
  std::printf("\n  want:");
  for (auto& s : want) std::printf(" [%s]", s.c_str());
  std::printf("\n");
  return false;
}

int main(int argc, char** argv) {
  {  // gain
    Recorder out;
    ob::audio::Mixer m(doc(0.8, false), out);
    CHECK(std::abs(m.busGain(std::string("sfx")) - 0.4) < 1e-12);
    CHECK(m.busGain(std::string("off")) == 0);
    CHECK(std::abs(m.busGain(std::nullopt) - 0.8) < 1e-12);
    CHECK(std::abs(m.busGain(std::string("unknown")) - 0.8) < 1e-12);
    Recorder o2;
    CHECK(ob::audio::Mixer(doc(0.8, true), o2).busGain(std::nullopt) == 0);
    m.handle(play("p", "a", std::string("sfx"), 0.5, 1.5, true, 0));
    m.setVolume(0.5);
    CHECK(same(out.calls, {"start 1 a 0.2 1.5 loop", "gain 1 0.1"}));
  }
  {  // fade-in, fade, stop fade
    Recorder out;
    ob::audio::Mixer m(doc(1, false), out);
    m.handle(play("p", "b", std::string("sfx"), 1, 1, true, 1));
    m.update(0.5);
    m.update(0.5);
    m.update(0.5);
    m.handle(fade("p", 0.2, 0.5));
    m.update(0.25);
    m.update(0.25);
    CHECK(m.voice("p") && m.voice("p")->soundVolume == 0.2);
    m.handle(fade("p", 1, 0));
    m.handle(stop("p", 1));
    CHECK(!m.voice("p") && m.voiceCount() == 1);
    m.handle(stop("p", 1));
    m.update(0.5);
    m.update(0.5);
    CHECK(m.voiceCount() == 0);
    CHECK(same(out.calls, {"start 1 b 0 1 loop", "gain 1 0.25", "gain 1 0.5", "gain 1 0.3", "gain 1 0.1", "gain 1 0.5",
                           "gain 1 0.25", "gain 1 0", "stop 1"}));
  }
  {  // voices
    Recorder out;
    out.failing = "c";
    ob::audio::Mixer m(doc(1, false), out);
    m.handle(play("x", "missing", std::nullopt, 1, 1, false, 0));
    m.handle(play("y", "c", std::nullopt, 1, 1, false, 0));
    CHECK(m.voiceCount() == 0);
    m.handle(play("p", "b", std::nullopt, 1, 1, true, 0));
    m.handle(play("p", "b", std::nullopt, 1, 1, true, 0));
    CHECK(same(out.calls, {"start 1 c 1 1", "start 2 b 1 1 loop", "stop 2", "start 3 b 1 1 loop"}));
    m.voiceFinished(3);
    CHECK(m.voiceCount() == 0);
    m.handle(stop("p", 0));
    CHECK(out.calls.size() == 4);
  }
  {  // one-shots expire after their duration ÷ rate
    Recorder out;
    ob::audio::Mixer m(doc(1, false), out);
    m.handle(play("p", "a", std::nullopt, 1, 2, false, 0));
    m.handle(play("q", "b", std::nullopt, 1, 1, false, 0));
    m.update(0.5);
    CHECK(m.voice("p"));
    m.update(0.3);
    CHECK(!m.voice("p") && m.voice("q"));
    CHECK(out.calls.back() == "stop 1");
    m.stopAll();
    CHECK(out.calls.back() == "stop 2" && m.voiceCount() == 0);
  }
  if (argc > 1) {  // engine_audio <repo>/examples/button.obone: the button's hover / click sounds reach the output
    auto d = ob::loadFile(argv[1]);
    ob::Instance inst(d);
    Recorder out;
    ob::audio::Mixer m(d, out);
    inst.onAudio = [&](const ob::AudioCommand& c) { m.handle(c); };
    inst.useStateMachine();
    inst.advance(0);
    const double cx = d->width / 2 - d->originX, cy = d->originY - d->height / 2;
    inst.pointer(ob::PointerEvent::Move, -10000, -10000);
    for (ob::PointerEvent t : {ob::PointerEvent::Move, ob::PointerEvent::Down, ob::PointerEvent::Up}) {
      inst.pointer(t, cx, cy);
      inst.advance(1.0 / 60);
      m.update(1.0 / 60);
    }
    int starts = 0;
    for (auto& c : out.calls) starts += c.rfind("start", 0) == 0;
    CHECK(starts > 0);
    for (int i = 0; i < 120; i++) m.update(1.0 / 60);
    CHECK(m.voiceCount() == 0);
  }
  {
    // Mute buttons (Mix commands): a bus goes silent and comes back; muting the master silences everything, also
    // sounds started afterwards; unmuting a bus the document mutes overrides it.
    Recorder out;
    ob::audio::Mixer m(doc(0.8, false), out);
    m.handle(play("p1", "a", std::string("sfx"), 0.5, 1, true, 0));
    m.handle(play("p2", "b", std::nullopt, 1, 1, true, 0));
    ob::AudioCommand mix;
    mix.type = ob::AudioCommand::Type::Mix;
    mix.bus = std::string("sfx");
    mix.muted = true;
    m.handle(mix);
    CHECK(m.muted(std::string("sfx")));
    mix.muted = false;
    m.handle(mix);
    mix.bus = std::nullopt;
    mix.muted = true;
    m.handle(mix);
    m.handle(play("p3", "c", std::nullopt, 1, 1, false, 0));
    mix.bus = std::string("off");
    mix.muted = false;
    m.handle(mix);
    CHECK(same(out.calls, {"start 1 a 0.2 1 loop", "start 2 b 0.8 1 loop", "gain 1 0", "gain 1 0.2", "gain 1 0", "gain 2 0",
                           "start 3 c 0 1"}));
    CHECK(m.busGain(std::string("off")) == 0);  // the master is still muted
  }
    std::printf(failures ? "engine audio FAILED (%d)\n" : "engine audio OK\n", failures);
  return failures ? 1 : 0;
}
