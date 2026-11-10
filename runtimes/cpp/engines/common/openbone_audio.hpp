// Engine-neutral half of sound playback for the engine samples: turns the runtime's audio commands into calls on an
// Output that makes the noise (sf::Sound, an SDL audio callback, …), with the document's bus and master gain, voice
// bookkeeping and fades stepped in update(). Header-only, no dependencies beyond the runtime; unit-tested in
// runtimes/cpp/tests/engine_audio.cpp.
// SPDX-License-Identifier: MIT
#pragma once

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"

namespace openbone::audio {

/** What plays the voices. Voice numbers are chosen by the Mixer. */
struct Output {
  virtual ~Output() = default;
  /** Start `asset` as voice `voice` at linear `gain`; false when it cannot be played. */
  virtual bool start(int voice, const AudioAsset& asset, double gain, double rate, bool loop) = 0;
  /** Set a playing voice's linear gain. */
  virtual void setGain(int voice, double gain) = 0;
  /** Stop a voice now and release it. */
  virtual void stop(int voice) = 0;
};

/**
 * Plays audio commands through an Output. Gain = command volume × bus volume (0 if muted) × master (0 if the document
 * is muted) × volume(). A fade command gives the sound's new volume; the voice keeps its bus and master gain.
 * One-shots are released a quarter second after their asset's duration (÷ rate), or when the output reports
 * voiceFinished(). Call update() every frame with real seconds. Not thread-safe.
 */
class Mixer {
 public:
  struct Voice {
    int handle = 0;
    std::optional<Id> bus;
    double soundVolume = 1;  // the command's, then the last fade's target
    double gain = 0;         // last given to the output
    double from = 0, to = 0, t = 0, duration = 0;  // gain ramp (duration 0 = none)
    double life = -1;        // seconds left for a one-shot, < 0 = until stopped
    bool ramping() const { return duration > 0; }
  };

  static constexpr double EXPIRY_SLACK = 0.25;

  Mixer(std::shared_ptr<const Document> doc, Output& output) : doc_(std::move(doc)), out_(output) {}

  double master() const {
    if (muted(std::nullopt)) return 0;
    if (!doc_ || !doc_->audio) return 1;
    return doc_->audio->master;
  }

  /** Whether a bus (nullopt = the master) is muted: by a Mix command (mute button), else by the document. */
  bool muted(const std::optional<Id>& bus) const {
    auto it = mutes_.find(bus.value_or(""));
    if (it != mutes_.end()) return it->second;
    if (!doc_ || !doc_->audio) return false;
    if (!bus) return doc_->audio->muted;
    for (const AudioBus& b : doc_->audio->buses)
      if (b.id == *bus) return b.muted;
    return false;
  }

  /** master × bus volume × volume (0 for a muted bus; an unknown or missing bus counts as 1). */
  double busGain(const std::optional<Id>& bus) const {
    double gain = master() * volume_;
    if (bus && doc_ && doc_->audio)
      for (const AudioBus& b : doc_->audio->buses)
        if (b.id == *bus) {
          gain *= muted(bus) ? 0 : b.volume;
          break;
        }
    return gain;
  }

  double volume() const { return volume_; }
  /** Extra gain on everything this mixer plays; applies to the playing voices at once. */
  void setVolume(double v) {
    volume_ = v;
    regain();
  }

  /** Give every playing voice its gain again (after the volume or a mute changed). */
  void regain() {
    for (auto& [id, voice] : voices_) {
      const double target = voice.soundVolume * busGain(voice.bus);
      if (voice.ramping()) voice.to = target;
      else apply(voice, target);
    }
  }

  const Voice* voice(const std::string& id) const {
    auto it = voices_.find(id);
    return it == voices_.end() ? nullptr : &it->second;
  }
  /** Voices playing or fading out. */
  size_t voiceCount() const { return voices_.size() + stopping_.size(); }

  void handle(const AudioCommand& c) {
    if (c.type == AudioCommand::Type::Play) return play(c);
    if (c.type == AudioCommand::Type::Mix) {
      mutes_[c.bus.value_or("")] = c.muted;
      regain();
      return;
    }
    auto it = voices_.find(c.id);
    if (it == voices_.end()) return;
    Voice& v = it->second;
    if (c.type == AudioCommand::Type::Stop) {
      if (c.fade > 0) {
        ramp(v, 0, c.fade);
        stopping_.push_back(v);
      } else out_.stop(v.handle);
      voices_.erase(it);
      return;
    }
    v.soundVolume = c.volume;
    const double target = c.volume * busGain(v.bus);
    if (c.duration > 0) ramp(v, target, c.duration);
    else {
      v.duration = 0;
      apply(v, target);
    }
  }

  /** Step fades and release finished one-shots by `dt` real seconds. */
  void update(double dt) {
    for (auto it = voices_.begin(); it != voices_.end();) {
      if (expired(it->second, dt)) {
        out_.stop(it->second.handle);
        it = voices_.erase(it);
      } else {
        step(it->second, dt);
        ++it;
      }
    }
    for (auto it = stopping_.begin(); it != stopping_.end();) {
      const bool gone = expired(*it, dt);
      if (!gone) step(*it, dt);
      if (gone || !it->ramping()) {
        out_.stop(it->handle);
        it = stopping_.erase(it);
      } else ++it;
    }
  }

  /** The output reports that a voice ended by itself. */
  void voiceFinished(int handle) {
    for (auto it = voices_.begin(); it != voices_.end();)
      it = it->second.handle == handle ? voices_.erase(it) : std::next(it);
    stopping_.erase(std::remove_if(stopping_.begin(), stopping_.end(), [&](const Voice& v) { return v.handle == handle; }),
                    stopping_.end());
  }

  /** Stop every voice now. */
  void stopAll() {
    for (auto& [id, v] : voices_) out_.stop(v.handle);
    for (auto& v : stopping_) out_.stop(v.handle);
    voices_.clear();
    stopping_.clear();
  }

 private:
  void play(const AudioCommand& c) {
    auto old = voices_.find(c.id);
    if (old != voices_.end()) {
      out_.stop(old->second.handle);
      voices_.erase(old);
    }
    if (!doc_ || !doc_->audio) return;
    const AudioAsset* asset = nullptr;
    for (const AudioAsset& a : doc_->audio->assets)
      if (a.id == c.asset) asset = &a;
    if (!asset) return;
    const double target = c.volume * busGain(c.bus);
    const double rate = c.rate > 0 ? c.rate : 0.01;
    Voice v;
    v.handle = next_++;
    v.bus = c.bus;
    v.soundVolume = c.volume;
    v.gain = c.fadeIn > 0 ? 0 : target;
    v.life = !c.loop && asset->duration > 0 ? asset->duration / rate + EXPIRY_SLACK : -1;
    if (!out_.start(v.handle, *asset, v.gain, rate, c.loop)) return;
    if (c.fadeIn > 0) ramp(v, target, c.fadeIn);
    voices_[c.id] = v;
  }

  static void ramp(Voice& v, double to, double duration) {
    v.from = v.gain;
    v.to = to;
    v.t = 0;
    v.duration = duration;
  }

  void apply(Voice& v, double gain) {
    if (gain == v.gain) return;
    v.gain = gain;
    out_.setGain(v.handle, gain);
  }

  static bool expired(Voice& v, double dt) {
    if (v.life < 0) return false;
    v.life -= dt;
    return v.life <= 0;
  }

  void step(Voice& v, double dt) {
    if (!v.ramping()) return;
    v.t += dt;
    const double k = std::min(1.0, v.t / v.duration);
    apply(v, v.from + (v.to - v.from) * k);
    if (k >= 1) v.duration = 0;
  }

  std::shared_ptr<const Document> doc_;
  Output& out_;
  std::map<std::string, Voice> voices_;
  std::vector<Voice> stopping_;
  int next_ = 1;
  double volume_ = 1;
  std::map<std::string, bool> mutes_;  // Mix overrides: bus id, "" = master
};

}  // namespace openbone::audio
