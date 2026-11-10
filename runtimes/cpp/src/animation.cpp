// Ports of animation.ts, audio.ts and animation-state.ts.
// SPDX-License-Identifier: MIT
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "internal.hpp"

namespace openbone {

namespace {

struct Located {
  const Key* a;
  const Key* b;
  double t;
};

Located locate(const std::vector<Key>& keys, double time) {
  if (time <= keys[0].time) return {&keys[0], nullptr, 0};
  const Key& last = keys.back();
  if (time >= last.time) return {&last, nullptr, 0};
  size_t lo = 0, hi = keys.size() - 1;
  while (hi - lo > 1) {
    const size_t mid = (lo + hi) >> 1;
    if (keys[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const Key& a = keys[lo];
  const Key& b = keys[hi];
  const double f = (time - a.time) / orNum(b.time - a.time, 1);
  return {&a, &b, evalCurve(a.curve, f)};
}

double keyNumber(const Key& k) { return k.value.toNumber(); }

double sampleNumber(const std::vector<Key>& keys, double time) {
  const Located l = locate(keys, time);
  if (!l.b || l.a->curve.kind == Curve::Kind::Stepped) return keyNumber(*l.a);
  return lerp(keyNumber(*l.a), keyNumber(*l.b), l.t);
}

std::vector<double> sampleArray(const std::vector<Key>& keys, double time) {
  const Located l = locate(keys, time);
  if (!l.b || l.a->curve.kind == Curve::Kind::Stepped) return l.a->numbers;
  const auto& av = l.a->numbers;
  const auto& bv = l.b->numbers;
  const size_t n = std::max(av.size(), bv.size());
  std::vector<double> out(n);
  for (size_t i = 0; i < n; i++) out[i] = lerp(i < av.size() ? av[i] : 0, i < bv.size() ? bv[i] : 0, l.t);
  return out;
}

const Key& sampleStep(const std::vector<Key>& keys, double time) { return *locate(keys, time).a; }

Inherit inheritOf(const Value& v) {
  if (v.isString()) {
    if (v.s == "onlyTranslation") return Inherit::OnlyTranslation;
    if (v.s == "noRotation") return Inherit::NoRotation;
    if (v.s == "noScale") return Inherit::NoScale;
  }
  return Inherit::Normal;
}

std::string keyColor(const Key& k) { return k.value.isString() ? k.value.s : std::string(); }

/** True for timelines whose values blend (a mix fades them); false for the ones that switch at keys. */
bool blends(const Timeline& tl) {
  switch (tl.target) {
    case TimelineTarget::Bone: return tl.property != "inherit";
    case TimelineTarget::Slot: return tl.property == "color" || tl.property == "dark";
    case TimelineTarget::Ik: return tl.property != "bend" && tl.property != "stretch" && tl.property != "compress";
    case TimelineTarget::Transform:
    case TimelineTarget::Path:
    case TimelineTarget::Physics:
    case TimelineTarget::Deform: return true;
    case TimelineTarget::Particles: return tl.property == "rate";
    default: return false;
  }
}

/** Whether any of `anims` has a keyed timeline for the same value as `tl` (same target, id, property and attachment). */
bool keyedBy(const std::vector<const AnimationData*>& anims, const Timeline& tl) {
  for (const AnimationData* a : anims)
    for (const Timeline& o : a->timelines)
      if (!o.keys.empty() && o.target == tl.target && o.id == tl.id && o.property == tl.property && o.attachment == tl.attachment) return true;
  return false;
}

}  // namespace

/** filter: 0 = every timeline, 1 = bone timelines only, 2 = everything but bone timelines. */
void applyTimelines(Skeleton& sk, const AnimationData& anim, double time, double full, int filter, const MixOut* mixOut) {
  if (full <= 0) return;
  if (full >= 0.5 || !sk.animationTime) sk.animationTime = time;
  for (const Timeline& tl : anim.timelines) {
    if (tl.keys.empty()) continue;
    if (filter == 1 && tl.target != TimelineTarget::Bone) continue;
    if (filter == 2 && tl.target == TimelineTarget::Bone) continue;
    const double alpha = mixOut && blends(tl) && !keyedBy(mixOut->into, tl) ? mixOut->alpha : full;
    if (alpha <= 0) continue;
    switch (tl.target) {
      case TimelineTarget::Bone: {
        Bone* bone = sk.boneById(tl.id);
        if (!bone) break;
        if (tl.boneProp == BoneProp::Inherit) {
          if (alpha >= 0.5) bone->inherit = inheritOf(sampleStep(tl.keys, time).value);
          break;
        }
        if (tl.boneProp == BoneProp::Unknown) break;
        const double v = sampleNumber(tl.keys, time);
        const double cur = bone->get(tl.boneProp);
        bone->set(tl.boneProp, alpha >= 1 ? v : tl.boneProp == BoneProp::Rotation ? lerpAngle(cur, v, alpha) : lerp(cur, v, alpha));
        break;
      }
      case TimelineTarget::Slot: {
        Slot* slot = sk.slotById(tl.id);
        if (!slot) break;
        if (tl.property == "color" || tl.property == "dark") {
          const Located l = locate(tl.keys, time);
          const RGBA ca = parseHex(keyColor(*l.a));
          const RGBA v = (!l.b || l.a->curve.kind == Curve::Kind::Stepped) ? ca : lerpColor(ca, parseHex(keyColor(*l.b)), l.t);
          if (tl.property == "color") slot->color = alpha >= 1 ? v : lerpColor(slot->color, v, alpha);
          else slot->dark = alpha >= 1 ? v : lerpColor(slot->dark ? *slot->dark : RGBA{0, 0, 0, 1}, v, alpha);
        } else if (alpha >= 0.5) {
          const Value& v = sampleStep(tl.keys, time).value;
          if (v.isString()) slot->attachmentName = v.s;
          else slot->attachmentName.reset();
        }
        break;
      }
      case TimelineTarget::Ik:
      case TimelineTarget::Transform:
      case TimelineTarget::Path:
      case TimelineTarget::Physics: {
        auto it = sk.constraintValues.find(tl.id);
        if (it == sk.constraintValues.end() || tl.cprop == CProp::Unknown) break;
        ConstraintValues& values = it->second;
        const bool step = tl.target == TimelineTarget::Ik && (tl.cprop == CProp::Bend || tl.cprop == CProp::Stretch || tl.cprop == CProp::Compress);
        if (step) {
          if (alpha >= 0.5) values.set(tl.cprop, sampleStep(tl.keys, time).value.toNumber());
        } else
          values.set(tl.cprop, lerp(values.get(tl.cprop, 0), sampleNumber(tl.keys, time), alpha));
        break;
      }
      case TimelineTarget::Particles: {
        Slot* slot = sk.slotById(tl.id);
        if (!slot) break;
        EmitterValues& cur = sk.particleValues[tl.id];
        if (tl.property == "emitting") {
          if (alpha >= 0.5) cur.emitting = sampleStep(tl.keys, time).value.truthy();
        } else {
          const Attachment* att = sk.getAttachment(*slot);
          const double base = cur.rate ? *cur.rate : (att && att->type == AttachmentType::Particles ? att->rate : 0);
          cur.rate = lerp(base, sampleNumber(tl.keys, time), alpha);
        }
        break;
      }
      case TimelineTarget::Deform: {
        Slot* slot = sk.slotById(tl.id);
        if (!slot) break;
        std::vector<double> v = sampleArray(tl.keys, time);
        auto it = slot->deform.find(tl.attachment);
        if (it != slot->deform.end() && alpha < 1) {
          const auto& cur = it->second;
          for (size_t i = 0; i < v.size(); i++) v[i] = lerp(i < cur.size() ? cur[i] : 0, v[i], alpha);
        } else if (alpha < 1)
          for (auto& x : v) x *= alpha;
        slot->deform[tl.attachment] = std::move(v);
        break;
      }
      case TimelineTarget::Sequence: {
        Slot* slot = sk.slotById(tl.id);
        if (!slot) break;
        if (alpha >= 0.5) slot->sequenceFrames[tl.attachment] = sampleNumber(tl.keys, time);
        break;
      }
      case TimelineTarget::DrawOrder: {
        if (alpha < 0.5) break;
        const Key& k = sampleStep(tl.keys, time);
        std::vector<Slot*> listed;
        for (const auto& id : k.ids)
          if (Slot* s = sk.slotById(id)) listed.push_back(s);
        std::unordered_set<Slot*> placed(listed.begin(), listed.end());
        std::vector<Slot*> out(sk.slots.size(), nullptr);
        for (size_t i = 0; i < sk.slots.size(); i++)
          if (!placed.count(sk.slots[i].get())) out[i] = sk.slots[i].get();
        size_t next = 0;
        for (size_t i = 0; i < out.size() && next < listed.size(); i++)
          if (!out[i]) out[i] = listed[next++];
        sk.drawOrder.clear();
        for (Slot* s : out)
          if (s) sk.drawOrder.push_back(s);
        break;
      }
      default: break;
    }
  }
}

void applyAnimation(Skeleton& sk, const AnimationData& anim, double time, double alpha) { applyTimelines(sk, anim, time, alpha, 0, nullptr); }
void applyAnimation(Skeleton& sk, const AnimationData& anim, double time, double alpha, const MixOut& mixOut) {
  applyTimelines(sk, anim, time, alpha, 0, &mixOut);
}

double localTime(const AnimationData& anim, double total, bool loop) {
  const double d = anim.computedDuration;
  if (d <= 0) return 0;
  if (loop) return std::fmod(std::fmod(total, d) + d, d);
  return std::min(std::max(total, 0.0), d);
}

std::vector<FiredEvent> eventsBetween(const Document& doc, const AnimationData& anim, double prev, double next, bool loop) {
  std::vector<FiredEvent> out;
  if (anim.events.empty() || next <= prev) return out;
  const double d = anim.computedDuration;
  auto push = [&](const EventKey& k, const EventData& ev) {
    FiredEvent e;
    e.name = ev.name;
    e.id = ev.id;
    e.time = k.time;
    e.intValue = k.intValue.value_or(ev.intValue);
    e.floatValue = k.floatValue.value_or(ev.floatValue);
    e.stringValue = k.stringValue.value_or(ev.stringValue);
    e.audio = ev.audio;
    e.volume = ev.volume;
    e.animation = anim.name;
    out.push_back(std::move(e));
  };
  for (const auto& k : anim.events) {
    const EventData* ev = doc.eventById(k.event);
    if (!ev) continue;
    if (!loop || d <= 0) {
      if (k.time > prev && k.time <= next) push(k, *ev);
      continue;
    }
    const double first = std::floor(prev / d), lastC = std::floor(next / d);
    for (double c = first; c <= lastC; c++) {
      const double at = c * d + k.time;
      if (at > prev && at <= next) push(k, *ev);
    }
  }
  return out;
}

// ---------------- Audio ----------------

namespace {
std::optional<SoundData> resolveSound(const Document& doc, const std::string& ref) {
  if (!doc.audio) return std::nullopt;
  const AudioData& a = *doc.audio;
  for (const auto& s : a.sounds)
    if (s.id == ref) return s;
  for (const auto& s : a.sounds)
    if (s.name == ref) return s;
  const AudioAsset* asset = nullptr;
  for (const auto& x : a.assets)
    if (x.id == ref) {
      asset = &x;
      break;
    }
  if (!asset)
    for (const auto& x : a.assets)
      if (x.name == ref) {
        asset = &x;
        break;
      }
  if (!asset) return std::nullopt;
  SoundData s;
  s.id = asset->id;
  s.name = asset->name;
  s.asset = asset->id;
  for (const auto& b : a.buses)
    if (b.name == "sfx") {
      s.bus = b.id;
      break;
    }
  return s;
}
long long playCounter = 0;
}  // namespace

AudioDirector::AudioDirector(const Document& d, std::function<void(const AudioCommand&)> o) : doc(d), out(std::move(o)) {}

void AudioDirector::update(double dt) {
  time += dt;
  playing.erase(std::remove_if(playing.begin(), playing.end(), [&](const Playing& p) { return p.endsAt <= time; }), playing.end());
}

std::optional<std::string> AudioDirector::play(const std::string& ref, const PlayOptions& o) {
  const auto sound = resolveSound(doc, ref);
  if (!sound) return std::nullopt;
  const bool loop = o.loop.value_or(sound->loop);
  if (loop && o.tag)
    for (const auto& p : playing)
      if (p.loop && p.owner == o.owner && p.tag == o.tag) return p.id;
  const double rate = o.rate.value_or(sound->rate);
  const double volume = sound->volume * o.volume.value_or(1);
  double len = 0;
  if (doc.audio)
    for (const auto& a : doc.audio->assets)
      if (a.id == sound->asset) {
        len = a.duration;
        break;
      }
  const std::string id = "play_" + std::to_string(++playCounter);
  playing.push_back({id, *sound, o.owner, o.tag, loop, volume, time, loop ? INFINITY : time + (len > 0 ? len / rate : 10)});
  AudioCommand c;
  c.type = AudioCommand::Type::Play;
  c.id = id;
  c.sound = sound->id;
  c.asset = sound->asset;
  c.bus = sound->bus;
  c.volume = volume;
  c.rate = rate;
  c.loop = loop;
  c.fadeIn = sound->fadeIn;
  c.source = o.source;
  if (out) out(c);
  return id;
}

void AudioDirector::stop(const std::string& id, std::optional<double> fade) {
  auto it = std::find_if(playing.begin(), playing.end(), [&](const Playing& p) { return p.id == id; });
  if (it == playing.end()) return;
  const double f = fade.value_or(it->sound.fadeOut);
  playing.erase(it);
  AudioCommand c;
  c.type = AudioCommand::Type::Stop;
  c.id = id;
  c.fade = f;
  if (out) out(c);
}

void AudioDirector::stopSound(const std::string& ref, std::optional<double> fade) {
  const auto s = resolveSound(doc, ref);
  if (!s) return;
  std::vector<std::string> ids;
  for (const auto& p : playing)
    if (p.sound.id == s->id) ids.push_back(p.id);
  for (const auto& id : ids) stop(id, fade);
}

void AudioDirector::stopOwner(const std::string& owner, double fade, bool all) {
  std::vector<std::pair<std::string, double>> ids;
  for (const auto& p : playing)
    if (p.owner && *p.owner == owner && (all || p.loop)) ids.push_back({p.id, std::max(fade, p.sound.fadeOut)});
  for (const auto& x : ids) stop(x.first, x.second);
}

void AudioDirector::fade(const std::string& id, double volume, double duration) {
  auto it = std::find_if(playing.begin(), playing.end(), [&](const Playing& p) { return p.id == id; });
  if (it == playing.end()) return;
  it->volume = volume;
  AudioCommand c;
  c.type = AudioCommand::Type::Fade;
  c.id = id;
  c.volume = volume;
  c.duration = duration;
  if (out) out(c);
}

void AudioDirector::stopAll(double fade) {
  std::vector<std::string> ids;
  for (const auto& p : playing) ids.push_back(p.id);
  for (const auto& id : ids) stop(id, fade);
}

void playAudioKeys(AudioDirector& dir, const AnimationData& anim, double prev, double next, bool loop, const std::string& owner) {
  if (anim.audio.empty() || next <= prev) return;
  const double d = anim.computedDuration;
  auto playKey = [&](const AudioKey& key, size_t index) {
    PlayOptions o;
    o.volume = key.volume;
    o.rate = key.rate;
    o.loop = key.loop;
    o.owner = owner;
    o.tag = anim.id + "#" + std::to_string(index);
    o.source = "key:" + anim.name;
    dir.play(key.sound, o);
  };
  // audioKeysBetween collects first, then plays (same order).
  std::vector<size_t> hits;
  for (size_t index = 0; index < anim.audio.size(); index++) {
    const AudioKey& key = anim.audio[index];
    if (!loop || d <= 0) {
      if (key.time > prev && key.time <= next) hits.push_back(index);
      continue;
    }
    for (double c = std::floor(prev / d); c <= std::floor(next / d); c++) {
      const double at = c * d + key.time;
      if (at > prev && at <= next) hits.push_back(index);
    }
  }
  for (size_t i : hits) playKey(anim.audio[i], i);
}

// ---------------- AnimationState ----------------

namespace {
long long entryCounter = 0;
}

TrackEntry::TrackEntry(const AnimationData* a, bool l) : uid("entry_" + std::to_string(++entryCounter)), animation(a), loop(l) {}

double TrackEntry::localTime() const { return openbone::localTime(*animation, time, loop); }

AnimationState::AnimationState(Skeleton& sk)
    : skeleton(sk), audio(sk.doc, [this](const AudioCommand& c) {
        if (onAudio) onAudio(c);
      }) {}

const AnimationData* AnimationState::resolve(const std::string& anim) const {
  const AnimationData* a = skeleton.doc.findAnimation(anim);
  if (!a) throw std::runtime_error("Animation \"" + anim + "\" not found");
  return a;
}

void AnimationState::endEntry(TrackEntry* e, double fade) {
  if (e) audio.stopOwner(e->uid, fade);
}

std::shared_ptr<TrackEntry> AnimationState::setAnimation(int track, const std::string& anim, bool loop, std::optional<double> mixOpt) {
  const double mix = mixOpt.value_or(defaultMix);
  auto entry = std::make_shared<TrackEntry>(resolve(anim), loop);
  if ((int)tracks.size() <= track) tracks.resize(track + 1);
  auto cur = tracks[track];
  endEntry(cur.get(), mix);
  if (cur && mix > 0) {
    entry->mixingFrom = cur;
    cur->mixingFrom = nullptr;
    entry->mixDuration = mix;
  }
  tracks[track] = entry;
  queue.erase(std::remove_if(queue.begin(), queue.end(), [&](const Queued& q) { return q.track == track; }), queue.end());
  if (onStart) onStart(*entry, track);
  return entry;
}

std::shared_ptr<TrackEntry> AnimationState::addAnimation(int track, const std::string& anim, bool loop, double delay, std::optional<double> mixOpt) {
  const double mix = mixOpt.value_or(defaultMix);
  auto entry = std::make_shared<TrackEntry>(resolve(anim), loop);
  if ((int)tracks.size() <= track) tracks.resize(track + 1);
  if (!tracks[track]) {
    tracks[track] = entry;
    if (onStart) onStart(*entry, track);
  } else
    queue.push_back({track, entry, delay, mix});
  return entry;
}

void AnimationState::clearTrack(int track) {
  if (track < (int)tracks.size()) {
    endEntry(tracks[track].get());
    tracks[track] = nullptr;
  }
}

void AnimationState::clearTracks() {
  tracks.clear();
  queue.clear();
  audio.stopAll();
}

void AnimationState::update(double dt) {
  audio.update(dt);
  for (size_t track = 0; track < tracks.size(); track++) {
    auto e = tracks[track];
    if (!e) continue;
    e->prevTime = e->time > 0 ? e->time : std::min(e->prevTime, e->time);
    e->time += dt * e->speed;
    if (e->mixingFrom) {
      e->mixingFrom->prevTime = e->mixingFrom->time;
      e->mixingFrom->time += dt * e->mixingFrom->speed;
      e->mixTime += dt;
      if (e->mixTime >= e->mixDuration) e->mixingFrom = nullptr;
    }
    if (dt > 0) {
      playAudioKeys(audio, *e->animation, e->prevTime, e->time, e->loop, e->uid);
      for (const FiredEvent& ev : eventsBetween(skeleton.doc, *e->animation, e->prevTime, e->time, e->loop)) {
        if (ev.audio) {
          PlayOptions o;
          o.volume = ev.volume;
          o.owner = e->uid;
          o.source = "event:" + ev.name;
          audio.play(*ev.audio, o);
        }
        if (onEvent) onEvent(ev, (int)track);
      }
    }
    const double d = e->duration();
    if (d > 0) {
      const double loops = std::floor(e->time / d);
      if (e->loop ? loops > e->completedLoops : (e->prevTime < d && e->time >= d)) {
        e->completedLoops = loops;
        if (onComplete) onComplete(*e, (int)track);
        if (!e->loop) endEntry(e.get());
      }
    }
    auto q = std::find_if(queue.begin(), queue.end(), [&](const Queued& x) { return x.track == (int)track; });
    if (q != queue.end() && (q->delay > 0 ? e->time >= q->delay : e->isComplete() || (e->loop && d > 0 && e->time >= d))) {
      Queued qq = *q;
      queue.erase(q);
      endEntry(e.get(), qq.mix);
      qq.entry->mixingFrom = e;
      qq.entry->mixDuration = qq.mix;
      tracks[track] = qq.entry;
      if (onStart) onStart(*qq.entry, (int)track);
    }
  }
}

void AnimationState::apply() { apply(skeleton); }

void AnimationState::apply(Skeleton& sk) {
  for (const auto& e : tracks) {
    if (!e) continue;
    if (e->mixingFrom) {
      const double mix = std::min(1.0, e->mixTime / orNum(e->mixDuration, 1));
      // What the new animation doesn't key fades from the old one's value to the pose underneath.
      const std::vector<const AnimationData*> into{e->animation};
      applyAnimation(sk, *e->mixingFrom->animation, e->mixingFrom->localTime(), e->alpha, MixOut{into, e->alpha * (1 - mix)});
      applyAnimation(sk, *e->animation, e->localTime(), e->alpha * mix);
    } else
      applyAnimation(sk, *e->animation, e->localTime(), e->alpha);
  }
}

}  // namespace openbone
