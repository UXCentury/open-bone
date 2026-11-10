// Port of packages/runtime/src/state-machine.ts and instance.ts.
// SPDX-License-Identifier: MIT
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "internal.hpp"
#include "nlohmann/json.hpp"

namespace openbone {

using json = nlohmann::json;

namespace {
long long stateCounter = 0;
constexpr double ON_COMPLETE_MIX = 0.1;

json valueToJson(const Value& v) {
  switch (v.type) {
    case Value::Type::Bool: return v.b;
    case Value::Type::Number: return v.n;
    case Value::Type::String: return v.s;
    default: return nullptr;
  }
}
Value jsonToValue(const json& j) {
  if (j.is_boolean()) return Value::boolean(j.get<bool>());
  if (j.is_number()) return Value::number(j.get<double>());
  if (j.is_string()) return Value::string(j.get<std::string>());
  if (j.is_null()) return Value::null();
  if (j.is_object() || j.is_array()) return Value::string(j.is_array() ? j.dump() : "[object Object]");
  return Value();
}
}  // namespace

struct StateInstance {
  explicit StateInstance(const StateData* d) : uid("state_" + std::to_string(++stateCounter)), data(d) {}
  std::string uid;
  const StateData* data;
  double time = 0, prevTime = -1e-6;
  std::vector<std::unique_ptr<ScriptHandle>> scripts;
};

struct LayerInstance {
  explicit LayerInstance(const LayerData* d) : data(d) {}
  const LayerData* data;
  std::shared_ptr<StateInstance> current, from;
  double mixTime = 0, mixDuration = 0;
  bool exited = false;
};

struct BoneOverride {
  std::optional<double> v[7];
};
struct SlotOverride {
  std::optional<std::string> color;
  bool hasAttachment = false;
  std::optional<std::string> attachment;
};

struct StateMachineInstance::Impl {
  StateMachineInstance& sm;
  std::shared_ptr<ScriptHost> host;
  std::vector<std::pair<Id, Value>> inputs;  // in data order
  std::vector<Id> fired;
  std::vector<LayerInstance> layers;
  struct PendingPointer { PointerEvent type; double x, y; };
  std::vector<PendingPointer> pending;
  std::unordered_set<Id> hovered, pressed;
  double px = 0, py = 0;
  bool pdown = false;
  std::vector<ScriptHandle*> scripts;
  std::vector<std::pair<Id, BoneOverride>> boneOverrides;
  std::vector<std::pair<Id, SlotOverride>> slotOverrides;
  std::vector<std::pair<Id, bool>> emitterOverrides;
  std::vector<FiredEvent> pendingEvents;
  double elapsed = 0;
  bool started = false;
  std::vector<std::pair<Id, std::unique_ptr<ScriptHandle>>> handles;

  Impl(StateMachineInstance& s, std::shared_ptr<ScriptHost> h) : sm(s), host(std::move(h)) {}

  const InputData* input(const std::string& ref) const {
    for (const auto& i : sm.data.inputs)
      if (i.id == ref || i.name == ref) return &i;
    return nullptr;
  }
  Value* inputValue(const Id& id) {
    for (auto& p : inputs)
      if (p.first == id) return &p.second;
    return nullptr;
  }
  bool isFired(const Id& id) const { return std::find(fired.begin(), fired.end(), id) != fired.end(); }

  void error(const std::string& msg) {
    if (sm.onError) sm.onError(msg);
  }

  // ---------- scripts ----------
  std::optional<std::string> api(const std::string& method, const std::string& argsJson) {
    json args = json::parse(argsJson, nullptr, false);
    if (!args.is_array()) args = json::array();
    auto arg = [&](size_t i) -> const json& {
      static const json nul;
      return i < args.size() ? args[i] : nul;
    };
    auto argStr = [&](size_t i) { return arg(i).is_string() ? arg(i).get<std::string>() : jsonToValue(arg(i)).toString(); };
    if (method == "time") return json(elapsed).dump();
    if (method == "input") {
      Value v = sm.getInput(argStr(0));
      if (v.isUndefined()) return std::nullopt;
      return valueToJson(v).dump();
    }
    if (method == "setInput") {
      sm.setInput(argStr(0), jsonToValue(arg(1)));
      return std::nullopt;
    }
    if (method == "fire") {
      sm.fire(argStr(0));
      return std::nullopt;
    }
    if (method == "emit") {
      const std::string name = argStr(0);
      const EventData* ev = nullptr;
      for (const auto& e : sm.skeleton.doc.events)
        if (e.name == name || e.id == name) {
          ev = &e;
          break;
        }
      if (ev && ev->audio) {
        PlayOptions o;
        o.volume = ev->volume;
        o.source = "event:" + ev->name;
        sm.audio.play(*ev->audio, o);
      }
      const json& payload = arg(1);
      auto pnum = [&](const char* k) -> std::optional<double> {
        if (payload.is_object() && payload.contains(k) && payload[k].is_number()) return payload[k].get<double>();
        return std::nullopt;
      };
      FiredEvent fe;
      fe.name = name;
      fe.id = ev ? ev->id : name;
      fe.time = elapsed;
      fe.intValue = pnum("int").value_or(ev ? ev->intValue : 0);
      fe.floatValue = pnum("float").value_or(ev ? ev->floatValue : 0);
      if (payload.is_object() && payload.contains("string") && payload["string"].is_string()) fe.stringValue = payload["string"].get<std::string>();
      else fe.stringValue = ev ? ev->stringValue : "";
      pendingEvents.push_back(std::move(fe));
      return std::nullopt;
    }
    if (method == "bone") {
      Bone* b = sm.skeleton.findBone(argStr(0));
      if (!b) return std::string("null");
      json o = {{"x", b->x}, {"y", b->y}, {"rotation", b->rotation}, {"scaleX", b->scaleX}, {"scaleY", b->scaleY},
                {"worldX", b->world.x}, {"worldY", b->world.y}, {"worldRotation", b->worldRotation()}};
      return o.dump();
    }
    if (method == "setBone") {
      Bone* b = sm.skeleton.findBone(argStr(0));
      if (!b) return std::nullopt;
      const json& props = arg(1);
      BoneOverride* o = nullptr;
      for (auto& p : boneOverrides)
        if (p.first == b->data->id) o = &p.second;
      if (!o) {
        boneOverrides.push_back({b->data->id, {}});
        o = &boneOverrides.back().second;
      }
      static const char* names[7] = {"x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"};
      if (props.is_object())
        for (int k = 0; k < 7; k++)
          if (props.contains(names[k])) {
            const json& v = props[names[k]];
            o->v[k] = v.is_number() ? v.get<double>() : jsonToValue(v).toNumber();
          }
      return std::nullopt;
    }
    if (method == "slot") {
      Slot* s = sm.skeleton.findSlot(argStr(0));
      if (!s) return std::nullopt;
      const json& props = arg(1);
      SlotOverride* o = nullptr;
      for (auto& p : slotOverrides)
        if (p.first == s->data->id) o = &p.second;
      if (!o) {
        slotOverrides.push_back({s->data->id, {}});
        o = &slotOverrides.back().second;
      }
      if (props.is_object()) {
        if (props.contains("color")) o->color = props["color"].is_string() ? std::optional<std::string>(props["color"].get<std::string>()) : std::nullopt;
        if (props.contains("attachment")) {
          o->hasAttachment = true;
          o->attachment = props["attachment"].is_string() ? std::optional<std::string>(props["attachment"].get<std::string>()) : std::nullopt;
        }
      }
      return std::nullopt;
    }
    if (method == "pointer") return json({{"x", px}, {"y", py}, {"down", pdown}}).dump();
    if (method == "log") {
      if (sm.onLog) sm.onLog(args.dump());
      return std::nullopt;
    }
    return std::nullopt;
  }

  ScriptApi makeApi() {
    return [this](const std::string& m, const std::string& a) { return api(m, a); };
  }

  void safeCall(ScriptHandle* h, const std::string& fn, const std::string& args = "[]") {
    try {
      if (h->has(fn)) h->call(fn, args);
    } catch (const std::exception& e) {
      error(e.what());
    }
  }

  ScriptHandle* scriptFor(const Id& id) {
    if (!host) return nullptr;
    for (auto& p : handles)
      if (p.first == id) return p.second.get();
    const ScriptData* s = nullptr;
    for (const auto& x : sm.skeleton.doc.scripts)
      if (x.id == id) s = &x;
    if (!s) return nullptr;
    try {
      auto h = host->load(*s, makeApi());
      ScriptHandle* raw = h.get();
      handles.push_back({id, std::move(h)});
      return raw;
    } catch (const std::exception& e) {
      error(e.what());
      return nullptr;
    }
  }

  void start() {
    started = true;
    for (const auto& id : sm.data.scripts) {
      if (ScriptHandle* h = scriptFor(id)) {
        scripts.push_back(h);
        safeCall(h, "onStart");
      }
    }
    for (auto& l : layers) {
      if (!l.data->entry) continue;
      for (const auto& s : l.data->states)
        if (s.id == *l.data->entry) {
          enter(l, s, 0);
          break;
        }
    }
  }

  void stateSounds(const StateData& s, bool onEnter, const std::string* owner) {
    for (const auto& x : s.sounds) {
      if (x.onEnter != onEnter) continue;
      if (x.stop) sm.audio.stopSound(x.sound);
      else {
        PlayOptions o;
        o.volume = x.volume;
        if (owner) {
          o.owner = *owner;
          o.tag = "hook:" + x.sound;
        }
        o.source = "state:" + s.name;
        sm.audio.play(x.sound, o);
      }
    }
  }

  void enter(LayerInstance& l, const StateData& state, double mix) {
    std::shared_ptr<StateInstance> prev = l.current;
    if (prev) {
      prev->scripts.clear();
      sm.audio.stopOwner(prev->uid, mix);
      stateSounds(*prev->data, false, nullptr);
    }
    if (state.type == StateType::Exit) {
      l.exited = true;
      l.from = prev;
      l.current = nullptr;
      l.mixTime = 0;
      l.mixDuration = mix;
    } else {
      auto inst = std::make_shared<StateInstance>(&state);
      l.from = mix > 0 ? prev : nullptr;
      l.current = inst;
      l.mixTime = 0;
      l.mixDuration = mix;
      l.exited = false;
      stateSounds(state, true, &inst->uid);
      for (const auto& e : state.emitters) sm.setEmitter(e.slot, e.emitting);
      for (const auto& x : state.inputs)
        if (input(x.input)) sm.setInput(x.input, x.value);
      for (const auto& id : state.scripts) {
        const ScriptData* s = nullptr;
        for (const auto& sc : sm.skeleton.doc.scripts)
          if (sc.id == id) s = &sc;
        if (!s || !host) continue;
        try {
          auto h = host->load(*s, makeApi());
          ScriptHandle* raw = h.get();
          inst->scripts.push_back(std::move(h));
          safeCall(raw, "onStart");
        } catch (const std::exception& e) {
          error(e.what());
        }
      }
    }
    if (sm.onStateChange) {
      const std::string* from = prev ? &prev->data->name : nullptr;
      sm.onStateChange(l.data->name, from, state.name);
    }
  }

  // ---------- transitions ----------
  bool conditionPasses(const Condition& c) {
    const InputData* in = nullptr;
    for (const auto& i : sm.data.inputs)
      if (i.id == c.input) in = &i;
    if (!in) return false;
    if (in->type == InputType::Trigger) return isFired(in->id);
    Value* vp = inputValue(in->id);
    const Value v = vp ? *vp : Value();
    const Value& want = c.value;
    if (c.op == "==") {
      if (in->type == InputType::String) return v.toString() == want.toString();
      return v.strictEquals(want) || (v.isNumber() && want.isNumber() && std::fabs(v.n - want.n) < 1e-9);
    }
    if (c.op == "!=") {
      if (in->type == InputType::String) return v.toString() != want.toString();
      return !v.strictEquals(want);
    }
    const double a = v.toNumber(), b = want.toNumber();
    if (c.op == ">") return a > b;
    if (c.op == "<") return a < b;
    if (c.op == ">=") return a >= b;
    if (c.op == "<=") return a <= b;
    return false;
  }

  struct BlendPair { const AnimationData* lo; const AnimationData* hi; double t; };
  std::optional<BlendPair> blendPair(const StateData& d) {
    if (d.type != StateType::Blend1d || d.blend.empty()) return std::nullopt;
    Value* vp = inputValue(d.blendInput.value_or(""));
    const double v = vp && !vp->isUndefined() ? vp->toNumber() : 0;
    std::vector<BlendEntry> entries = d.blend;
    std::stable_sort(entries.begin(), entries.end(), [](const BlendEntry& a, const BlendEntry& b) { return a.value < b.value; });
    const BlendEntry* lo = &entries[0];
    const BlendEntry* hi = &entries[0];
    double t = 0;
    if (v >= entries.back().value) lo = hi = &entries.back();
    else
      for (size_t i = 0; i + 1 < entries.size(); i++)
        if (v >= entries[i].value && v <= entries[i + 1].value) {
          lo = &entries[i];
          hi = &entries[i + 1];
          t = (v - lo->value) / orNum(hi->value - lo->value, 1);
          break;
        }
    return BlendPair{sm.skeleton.doc.animationById(lo->animation), sm.skeleton.doc.animationById(hi->animation), t};
  }

  const AnimationData* anim(const std::optional<Id>& id) const {
    return id && !id->empty() ? sm.skeleton.doc.animationById(*id) : nullptr;
  }

  double progress(const StateInstance& s) {
    auto pair = blendPair(*s.data);
    const AnimationData* a = pair ? (pair->t >= 0.5 ? pair->hi : pair->lo) : anim(s.data->animation);
    const double d = a ? a->computedDuration : 0;
    return d > 0 ? s.time / d : 1;
  }

  bool canTake(const TransitionData& t, const StateInstance* s) {
    const bool any = t.from == ANY_STATE;
    if (!any && s && t.to == s->data->id && t.conditions.empty()) return false;
    if (any && s && t.to == s->data->id) return false;
    std::optional<double> exitTime = t.exitTime;
    if (!exitTime && t.conditions.empty()) exitTime = 1;
    if (exitTime && s && progress(*s) < *exitTime) return false;
    for (const auto& c : t.conditions)
      if (!conditionPasses(c)) return false;
    return true;
  }

  const TransitionData* evaluate(LayerInstance& l) {
    if (l.exited) return nullptr;
    std::shared_ptr<StateInstance> cur = l.current;
    std::vector<const TransitionData*> candidates;
    for (const auto& t : l.data->transitions)
      if (t.from == ANY_STATE || (cur && t.from == cur->data->id)) candidates.push_back(&t);
    std::stable_sort(candidates.begin(), candidates.end(),
                     [](const TransitionData* a, const TransitionData* b) { return int(a->from == ANY_STATE) < int(b->from == ANY_STATE); });
    for (const TransitionData* t : candidates) {
      if (!canTake(*t, cur.get())) continue;
      const StateData* to = nullptr;
      for (const auto& s : l.data->states)
        if (s.id == t->to) to = &s;
      if (!to) continue;
      enter(l, *to, t->duration);
      return t;
    }
    if (cur && cur->data->onComplete && !cur->data->onComplete->empty() && progress(*cur) >= 1) {
      for (const auto& s : l.data->states)
        if (s.id == *cur->data->onComplete) {
          enter(l, s, ON_COMPLETE_MIX);
          break;
        }
    }
    return nullptr;
  }

  void settle(LayerInstance& l) {
    for (int hop = 0; hop < 4; hop++) {
      const TransitionData* t = evaluate(l);
      if (!t) return;
      for (const auto& c : t->conditions) {
        auto it = std::find(fired.begin(), fired.end(), c.input);
        if (it != fired.end()) fired.erase(it);
      }
    }
  }

  // ---------- pointer ----------
  bool hit(const Id& slotId, double x, double y) {
    Slot* s = sm.skeleton.slotById(slotId);
    return s && sm.skeleton.hitTest(*s, x, y);
  }

  void processPointer() {
    std::vector<PendingPointer> evs;
    evs.swap(pending);
    static const char* names[] = {"down", "up", "enter", "exit", "move", "click"};
    for (const auto& p : evs) {
      px = p.x;
      py = p.y;
      pdown = p.type == PointerEvent::Down ? true : p.type == PointerEvent::Up ? false : pdown;
      json pe = {{"type", names[int(p.type)]}, {"x", p.x}, {"y", p.y}};
      const std::string args = json::array({pe}).dump();
      for (ScriptHandle* s : scripts) safeCall(s, "onPointer", args);
      for (const auto& li : sm.data.listeners) {
        const bool h = li.slot && !li.slot->empty() ? hit(*li.slot, p.x, p.y) : true;
        const Id& key = li.id;
        bool fire = false;
        switch (li.event) {
          case PointerEvent::Move: fire = h && p.type == PointerEvent::Move; break;
          case PointerEvent::Down: fire = h && p.type == PointerEvent::Down; break;
          case PointerEvent::Up: fire = h && p.type == PointerEvent::Up; break;
          case PointerEvent::Click:
            if (p.type == PointerEvent::Down && h) pressed.insert(key);
            if (p.type == PointerEvent::Up) {
              fire = h && pressed.count(key);
              pressed.erase(key);
            }
            break;
          case PointerEvent::Enter:
          case PointerEvent::Exit: {
            const bool was = hovered.count(key) > 0;
            if (h && !was) {
              hovered.insert(key);
              fire = li.event == PointerEvent::Enter;
            } else if (!h && was) {
              hovered.erase(key);
              fire = li.event == PointerEvent::Exit;
            }
            break;
          }
        }
        if (fire) runActions(li);
      }
    }
  }

  void runActions(const ListenerData& li) {
    using T = ListenerAction::Type;
    for (const auto& a : li.actions) {
      try {
        switch (a.type) {
          case T::SetInput: sm.setInput(a.input, a.value); break;
          case T::ToggleInput: {
            Value* v = inputValue(a.input);
            sm.setInput(a.input, Value::boolean(!(v && v->truthy())));
            break;
          }
          case T::FireTrigger: sm.fire(a.input); break;
          case T::ReportEvent: {
            const EventData* ev = sm.skeleton.doc.eventById(a.event);
            if (ev) {
              if (ev->audio) {
                PlayOptions o;
                o.volume = ev->volume;
                o.source = "event:" + ev->name;
                sm.audio.play(*ev->audio, o);
              }
              FiredEvent fe;
              fe.name = ev->name;
              fe.id = ev->id;
              fe.time = elapsed;
              fe.intValue = ev->intValue;
              fe.floatValue = ev->floatValue;
              fe.stringValue = ev->stringValue;
              pendingEvents.push_back(std::move(fe));
            }
            break;
          }
          case T::PlaySound: {
            PlayOptions o;
            o.volume = a.volume;
            o.source = "listener:" + li.name;
            sm.audio.play(a.sound, o);
            break;
          }
          case T::StopSound: sm.audio.stopSound(a.sound, a.fade); break;
          case T::RunScript: {
            bool exists = false;
            for (const auto& s : sm.skeleton.doc.scripts)
              if (s.id == a.script) exists = true;
            if (exists)
              if (ScriptHandle* h = scriptFor(a.script)) safeCall(h, a.fn);
            break;
          }
          case T::SetEmitter: sm.setEmitter(a.slot, a.emitting); break;
          case T::EmitParticles: sm.skeleton.emitParticles(a.slot, a.count); break;
          default: break;
        }
      } catch (const std::exception& e) {
        error(e.what());
      }
    }
  }

  // ---------- apply ----------
  void applyState(const StateInstance& s, double alpha) {
    const StateData& d = *s.data;
    if (d.type == StateType::Animation) {
      if (const AnimationData* a = anim(d.animation)) applyAnimation(sm.skeleton, *a, localTime(*a, s.time, d.loop), alpha);
    } else if (d.type == StateType::Blend1d) {
      auto pair = blendPair(d);
      if (!pair) return;
      if (pair->lo) applyAnimation(sm.skeleton, *pair->lo, localTime(*pair->lo, s.time, d.loop), alpha);
      if (pair->hi && pair->hi != pair->lo && pair->t > 0) applyAnimation(sm.skeleton, *pair->hi, localTime(*pair->hi, s.time, d.loop), alpha * pair->t);
    }
  }

  void collectEvents(StateInstance& s) {
    const StateData& d = *s.data;
    const AnimationData* a = nullptr;
    if (d.type == StateType::Animation) a = anim(d.animation);
    else if (d.type == StateType::Blend1d) {
      auto pair = blendPair(d);
      a = pair ? (pair->t >= 0.5 ? pair->hi : pair->lo) : nullptr;
    }
    if (!a) return;
    playAudioKeys(sm.audio, *a, s.prevTime, s.time, d.loop, s.uid);
    for (FiredEvent& ev : eventsBetween(sm.skeleton.doc, *a, s.prevTime, s.time, d.loop)) {
      if (ev.audio) {
        PlayOptions o;
        o.volume = ev.volume;
        o.owner = s.uid;
        o.source = "event:" + ev.name;
        sm.audio.play(*ev.audio, o);
      }
      pendingEvents.push_back(std::move(ev));
    }
  }

  static std::string eventJson(const FiredEvent& e) {
    json o = {{"name", e.name}, {"id", e.id}, {"time", e.time}, {"int", e.intValue}, {"float", e.floatValue}, {"string", e.stringValue}};
    if (e.audio) o["audio"] = *e.audio;
    if (e.volume) o["volume"] = *e.volume;
    o["animation"] = e.animation;
    return json::array({o}).dump();
  }

  void advance(double dt) {
    if (!started) start();
    elapsed += dt;
    sm.audio.update(dt);
    processPointer();
    const std::string dtArgs = json::array({dt}).dump();
    for (ScriptHandle* s : scripts) safeCall(s, "onUpdate", dtArgs);
    for (auto& l : layers)
      if (l.current)
        for (auto& h : l.current->scripts) safeCall(h.get(), "onUpdate", dtArgs);
    for (auto& l : layers) settle(l);
    fired.clear();
    for (auto& l : layers) {
      for (StateInstance* s : {l.current.get(), l.from.get()}) {
        if (!s) continue;
        s->prevTime = s->time > 0 ? s->time : std::min(s->prevTime, s->time);
        s->time += dt * s->data->speed;
      }
      if (l.current && dt > 0) collectEvents(*l.current);
      if (l.from) {
        l.mixTime += dt;
        if (l.mixTime >= l.mixDuration) l.from = nullptr;
      }
    }
    Skeleton& sk = sm.skeleton;
    sk.setToSetupPose();
    for (auto& l : layers) {
      const double mixA = l.mixDuration > 0 ? std::min(1.0, l.mixTime / l.mixDuration) : 1;
      if (l.from) applyState(*l.from, l.exited ? 1 - mixA : 1);
      if (l.current) applyState(*l.current, l.from ? mixA : 1);
    }
    static const BoneProp props[7] = {BoneProp::X, BoneProp::Y, BoneProp::Rotation, BoneProp::ScaleX, BoneProp::ScaleY, BoneProp::ShearX, BoneProp::ShearY};
    for (const auto& [id, o] : boneOverrides)
      if (Bone* b = sk.boneById(id))
        for (int k = 0; k < 7; k++)
          if (o.v[k]) b->set(props[k], *o.v[k]);
    for (const auto& [id, o] : slotOverrides) {
      Slot* s = sk.slotById(id);
      if (!s) continue;
      if (o.color && !o.color->empty()) s->color = parseHex(*o.color);
      if (o.hasAttachment) s->attachmentName = o.attachment;
    }
    for (const auto& [id, v] : inputs)
      if (v.isNumber()) sk.inputValues[id] = v.n;
    for (const auto& [id, emitting] : emitterOverrides) sk.particleValues[id].emitting = emitting;
    sm.applyBindings();
    sk.update(dt);
    sk.updateWorldTransform();
    std::vector<FiredEvent> evs;
    evs.swap(pendingEvents);
    for (const auto& e : evs) {
      if (sm.onEvent) sm.onEvent(e);
      const std::string args = eventJson(e);
      for (ScriptHandle* h : scripts) safeCall(h, "onEvent", args);
      for (auto& l : layers)
        if (l.current)
          for (auto& h : l.current->scripts) safeCall(h.get(), "onEvent", args);
    }
  }
};

StateMachineInstance::StateMachineInstance(Skeleton& sk, const StateMachineData& d, std::shared_ptr<ScriptHost> host)
    : skeleton(sk), data(d), audio(sk.doc, [this](const AudioCommand& c) {
        if (onAudio) onAudio(c);
      }) {
  impl = std::make_unique<Impl>(*this, std::move(host));
  for (const auto& i : d.inputs) impl->inputs.push_back({i.id, i.type == InputType::Trigger ? Value::boolean(false) : i.defaultValue});
  for (const auto& l : d.layers) impl->layers.emplace_back(&l);
  skeleton.textValues = [this](const std::string& name) { return getInput(name); };
}

StateMachineInstance::~StateMachineInstance() {
  if (skeleton.textValues) skeleton.textValues = nullptr;
}

Value StateMachineInstance::getInput(const std::string& ref) const {
  const InputData* i = impl->input(ref);
  if (!i) return {};
  for (const auto& p : impl->inputs)
    if (p.first == i->id) return p.second;
  return {};
}

void StateMachineInstance::setInput(const std::string& ref, const Value& value) {
  const InputData* i = impl->input(ref);
  if (!i) throw std::runtime_error("Input \"" + ref + "\" not found");
  if (i->type == InputType::Trigger) return fire(ref);
  Value v;
  if (i->type == InputType::String) v = Value::string(value.toString());
  else if (i->type == InputType::Bool) v = Value::boolean(value.isString() ? value.s == "true" : value.truthy());
  else {
    v = Value::number(value.toNumber());
    if (!std::isfinite(v.n)) return;
  }
  Value* cur = impl->inputValue(i->id);
  if (cur && cur->strictEquals(v)) return;
  if (cur) *cur = v;
  else impl->inputs.push_back({i->id, v});
  if (onInputChange) onInputChange(i->name, v);
}

void StateMachineInstance::fire(const std::string& ref) {
  const InputData* i = impl->input(ref);
  if (!i) throw std::runtime_error("Input \"" + ref + "\" not found");
  if (!impl->isFired(i->id)) impl->fired.push_back(i->id);
  if (onInputChange) onInputChange(i->name, Value::boolean(true));
}

void StateMachineInstance::setEmitter(const std::string& slotRef, bool emitting) {
  Slot* s = skeleton.findSlot(slotRef);
  if (!s) return;
  bool found = false;
  for (auto& p : impl->emitterOverrides)
    if (p.first == s->data->id) {
      p.second = emitting;
      found = true;
    }
  if (!found) impl->emitterOverrides.push_back({s->data->id, emitting});
  if (emitting) skeleton.restartEmitter(s->data->id);
}

std::vector<std::pair<std::string, std::optional<std::string>>> StateMachineInstance::activeStates() const {
  std::vector<std::pair<std::string, std::optional<std::string>>> out;
  for (const auto& l : impl->layers) {
    std::optional<std::string> v;
    if (l.exited) v = std::string("exit");
    else if (l.current) v = l.current->data->name;
    // Like a JS object: a later layer with the same name replaces the earlier value in place.
    bool replaced = false;
    for (auto& o : out)
      if (o.first == l.data->name) {
        o.second = v;
        replaced = true;
      }
    if (!replaced) out.push_back({l.data->name, v});
  }
  return out;
}

void StateMachineInstance::pointer(PointerEvent type, double x, double y) { impl->pending.push_back({type, x, y}); }

void StateMachineInstance::advance(double dt) { impl->advance(dt); }

void StateMachineInstance::applyBindings() {
  Skeleton& sk = skeleton;
  for (const auto& b : data.bindings) {
    Value* raw = impl->inputValue(b.input);
    if (!raw || raw->isUndefined()) continue;
    const double n = raw->toNumber();
    if (!std::isfinite(n)) continue;
    const double t = bindingT(n, b.inMin, b.inMax);
    const double outMin = b.outMin.toNumber(), outMax = b.outMax.toNumber();
    const double lv = outMin + (outMax - outMin) * t;
    if (b.target == "bone") {
      if (Bone* bone = sk.boneById(b.object)) bone->set(boneProp(b.property), lv);
    } else if (b.target == "slot") {
      Slot* slot = sk.slotById(b.object);
      if (!slot) continue;
      if (b.property == "alpha") slot->color = {slot->color[0], slot->color[1], slot->color[2], lv};
      else if (b.property == "color") {
        const RGBA lo = parseHex(b.outMin.toString()), hi = parseHex(b.outMax.toString());
        for (int k = 0; k < 4; k++) slot->color[k] = lo[k] + (hi[k] - lo[k]) * t;
      }
    } else {
      auto it = sk.constraintValues.find(b.object);
      const CProp p = constraintProp(b.property);
      if (it != sk.constraintValues.end() && p != CProp::Unknown) it->second.set(p, lv);
    }
  }
}

void StateMachineInstance::clearOverrides() {
  impl->boneOverrides.clear();
  impl->slotOverrides.clear();
}

void StateMachineInstance::dispose() {
  audio.stopAll();
  impl->handles.clear();
  impl->scripts.clear();
  for (auto& l : impl->layers)
    if (l.current) l.current->scripts.clear();
}

// ---------------- Instance ----------------

Instance::Instance(std::shared_ptr<const Document> d, std::shared_ptr<ScriptHost> h) : doc(std::move(d)), host(std::move(h)) {
  skeleton = std::make_unique<Skeleton>(doc);
  animationState = std::make_unique<AnimationState>(*skeleton);
  animationState->onEvent = [this](const FiredEvent& e, int) {
    if (onEvent) onEvent(e);
  };
  animationState->onAudio = [this](const AudioCommand& c) {
    if (onAudio) onAudio(c);
  };
}

Instance::~Instance() {
  stateMachine.reset();
}

std::shared_ptr<TrackEntry> Instance::play(const std::string& animation, bool loop, int track) {
  if (stateMachine) {
    stateMachine->dispose();
    stateMachine.reset();
  }
  return animationState->setAnimation(track, animation, loop);
}

StateMachineInstance& Instance::useStateMachine(const std::string& name) {
  const StateMachineData* data = name.empty() ? (doc->stateMachines.empty() ? nullptr : &doc->stateMachines[0]) : doc->findStateMachine(name);
  if (!data) throw std::runtime_error(name.empty() ? "Document has no state machine" : "State machine \"" + name + "\" not found");
  if (stateMachine) {
    stateMachine->dispose();
    stateMachine.reset();
  }
  animationState->clearTracks();
  stateMachine = std::make_unique<StateMachineInstance>(*skeleton, *data, host);
  stateMachine->onAudio = [this](const AudioCommand& c) {
    if (onAudio) onAudio(c);
  };
  stateMachine->onEvent = [this](const FiredEvent& e) {
    if (onEvent) onEvent(e);
  };
  stateMachine->onStateChange = [this](const std::string& l, const std::string* f, const std::string& t) {
    if (onStateChange) onStateChange(l, f, t);
  };
  return *stateMachine;
}

void Instance::advance(double dt) {
  if (stateMachine) {
    stateMachine->advance(dt);
    return;
  }
  animationState->update(dt);
  skeleton->setToSetupPose();
  animationState->apply();
  skeleton->update(dt);
  skeleton->updateWorldTransform();
}

void Instance::pointer(PointerEvent type, double x, double y) {
  if (stateMachine) stateMachine->pointer(type, x, y);
}

void Instance::dispose() {
  if (stateMachine) stateMachine->dispose();
  animationState->clearTracks();
}

}  // namespace openbone
