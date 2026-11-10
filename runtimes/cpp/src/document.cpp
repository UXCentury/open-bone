// Loading .obone (JSON) and .obonb (binary) documents into the C++ model, normalised like core/document.ts.
// SPDX-License-Identifier: MIT
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include <algorithm>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "internal.hpp"
#include "nlohmann/json.hpp"

namespace openbone {

using json = nlohmann::ordered_json;

const char* blendName(BlendMode b) {
  switch (b) {
    case BlendMode::Normal: return "normal";
    case BlendMode::Additive: return "additive";
    case BlendMode::Multiply: return "multiply";
    case BlendMode::Screen: return "screen";
  }
  return "normal";
}
const char* inheritName(Inherit i) {
  switch (i) {
    case Inherit::Normal: return "normal";
    case Inherit::OnlyTranslation: return "onlyTranslation";
    case Inherit::NoRotation: return "noRotation";
    case Inherit::NoScale: return "noScale";
  }
  return "normal";
}
const char* attachmentTypeName(AttachmentType t) {
  switch (t) {
    case AttachmentType::Region: return "region";
    case AttachmentType::Mesh: return "mesh";
    case AttachmentType::Shape: return "shape";
    case AttachmentType::BoundingBox: return "boundingBox";
    case AttachmentType::Point: return "point";
    case AttachmentType::Clipping: return "clipping";
    case AttachmentType::Path: return "path";
    case AttachmentType::Sequence: return "sequence";
    case AttachmentType::Particles: return "particles";
    case AttachmentType::Text: return "text";
    default: return "unknown";
  }
}

BoneProp boneProp(const std::string& s) {
  if (s == "x") return BoneProp::X;
  if (s == "y") return BoneProp::Y;
  if (s == "rotation") return BoneProp::Rotation;
  if (s == "scaleX") return BoneProp::ScaleX;
  if (s == "scaleY") return BoneProp::ScaleY;
  if (s == "shearX") return BoneProp::ShearX;
  if (s == "shearY") return BoneProp::ShearY;
  if (s == "inherit") return BoneProp::Inherit;
  return BoneProp::Unknown;
}

CProp constraintProp(const std::string& s) {
  static const char* names[] = {"mix", "softness", "bend", "stretch", "compress", "mixRotate", "mixTranslate", "mixScale", "mixShear", "position",
                                "spacing", "mixX", "mixY", "inertia", "strength", "damping", "mass", "gravity", "wind"};
  for (int i = 0; i < int(CProp::Count); i++)
    if (s == names[i]) return CProp(i);
  return CProp::Unknown;
}

namespace {

const json* get(const json& o, const char* k) {
  if (!o.is_object()) return nullptr;
  auto it = o.find(k);
  if (it == o.end() || it->is_null()) return nullptr;
  return &*it;
}
double num(const json& o, const char* k, double def = 0) {
  const json* v = get(o, k);
  return v && v->is_number() ? v->get<double>() : def;
}
std::optional<double> optNum(const json& o, const char* k) {
  const json* v = get(o, k);
  if (v && v->is_number()) return v->get<double>();
  return std::nullopt;
}
std::string str(const json& o, const char* k, const std::string& def = "") {
  const json* v = get(o, k);
  return v && v->is_string() ? v->get<std::string>() : def;
}
std::optional<std::string> optStr(const json& o, const char* k) {
  const json* v = get(o, k);
  if (v && v->is_string()) return v->get<std::string>();
  return std::nullopt;
}
bool boolean(const json& o, const char* k, bool def = false) {
  const json* v = get(o, k);
  if (!v) return def;
  if (v->is_boolean()) return v->get<bool>();
  if (v->is_number()) return v->get<double>() != 0;
  return def;
}
std::vector<double> nums(const json& o, const char* k) {
  std::vector<double> out;
  const json* v = get(o, k);
  if (v && v->is_array())
    for (const auto& x : *v) out.push_back(x.is_number() ? x.get<double>() : (x.is_boolean() ? (x.get<bool>() ? 1 : 0) : 0));
  return out;
}
std::vector<std::string> strs(const json& o, const char* k) {
  std::vector<std::string> out;
  const json* v = get(o, k);
  if (v && v->is_array())
    for (const auto& x : *v)
      if (x.is_string()) out.push_back(x.get<std::string>());
  return out;
}
Range range(const json& o, const char* k, Range def) {
  const json* v = get(o, k);
  if (v && v->is_array() && v->size() >= 2 && (*v)[0].is_number() && (*v)[1].is_number()) return {(*v)[0].get<double>(), (*v)[1].get<double>()};
  return def;
}
Value value(const json& v) {
  if (v.is_boolean()) return Value::boolean(v.get<bool>());
  if (v.is_number()) return Value::number(v.get<double>());
  if (v.is_string()) return Value::string(v.get<std::string>());
  if (v.is_null()) return Value::null();
  return Value::undefined();
}
Value valueAt(const json& o, const char* k) {
  if (!o.is_object()) return {};
  auto it = o.find(k);
  return it == o.end() ? Value() : value(*it);
}

BlendMode blend(const std::string& s) {
  if (s == "additive") return BlendMode::Additive;
  if (s == "multiply") return BlendMode::Multiply;
  if (s == "screen") return BlendMode::Screen;
  return BlendMode::Normal;
}
Inherit inherit(const std::string& s) {
  if (s == "onlyTranslation") return Inherit::OnlyTranslation;
  if (s == "noRotation") return Inherit::NoRotation;
  if (s == "noScale") return Inherit::NoScale;
  return Inherit::Normal;
}

/** JS array-index key ("0", "17"; no leading zeros, < 2^32 - 1). */
bool arrayIndexKey(const std::string& k, uint64_t& out) {
  if (k.empty() || k.size() > 10) return false;
  if (k.size() > 1 && k[0] == '0') return false;
  uint64_t n = 0;
  for (char c : k) {
    if (c < '0' || c > '9') return false;
    n = n * 10 + (c - '0');
  }
  if (n >= 4294967295ull) return false;
  out = n;
  return true;
}
/** Object keys in JS enumeration order. */
std::vector<std::string> jsKeys(const json& o) {
  std::vector<std::pair<uint64_t, std::string>> ints;
  std::vector<std::string> rest;
  for (auto it = o.begin(); it != o.end(); ++it) {
    uint64_t n;
    if (arrayIndexKey(it.key(), n)) ints.push_back({n, it.key()});
    else rest.push_back(it.key());
  }
  std::sort(ints.begin(), ints.end());
  std::vector<std::string> out;
  for (auto& p : ints) out.push_back(p.second);
  for (auto& s : rest) out.push_back(s);
  return out;
}

std::vector<std::vector<VertexWeight>> weights(const json& o, bool& has) {
  std::vector<std::vector<VertexWeight>> out;
  const json* w = get(o, "weights");
  has = w && w->is_array();
  if (!has) return out;
  for (const auto& v : *w) {
    std::vector<VertexWeight> inf;
    if (v.is_array())
      for (const auto& x : v) inf.push_back({str(x, "bone"), num(x, "x"), num(x, "y"), num(x, "weight")});
    out.push_back(std::move(inf));
  }
  return out;
}

std::unique_ptr<Attachment> attachment(const std::string& key, const json& a) {
  auto at = std::make_unique<Attachment>();
  Attachment& t = *at;
  const std::string type = str(a, "type");
  t.name = str(a, "name", key);
  t.x = num(a, "x");
  t.y = num(a, "y");
  t.rotation = num(a, "rotation");
  t.scaleX = num(a, "scaleX", 1);
  t.scaleY = num(a, "scaleY", 1);
  t.skewX = num(a, "skewX");
  t.skewY = num(a, "skewY");
  t.width = num(a, "width");
  t.height = num(a, "height");
  t.color = str(a, "color", "#ffffff");
  if (auto im = optStr(a, "image")) {
    t.image = *im;
    t.hasImage = true;
  }
  t.vertices = nums(a, "vertices");
  t.uvs = nums(a, "uvs");
  if (type == "region") t.type = AttachmentType::Region;
  else if (type == "mesh") {
    t.type = AttachmentType::Mesh;
    for (double v : nums(a, "triangles")) t.triangles.push_back(uint16_t(v));
    t.weights = weights(a, t.weighted);
    t.hull = (int)num(a, "hull");
    if (const json* l = get(a, "linked")) {
      t.linkedMesh = str(*l, "mesh");
      t.linkedDeform = boolean(*l, "deform");
    }
  } else if (type == "shape") {
    t.type = AttachmentType::Shape;
    const std::string k = str(a, "shape", "rect");
    t.shape = k == "ellipse" ? ShapeKind::Ellipse : k == "polygon" ? ShapeKind::Polygon : ShapeKind::Rect;
    t.radius = num(a, "radius");
    if (get(a, "points")) {
      t.hasPoints = true;
      t.points = nums(a, "points");
    }
    t.fill = str(a, "fill", "#ffffff");
    t.stroke = optStr(a, "stroke");
    t.strokeWidth = num(a, "strokeWidth");
  } else if (type == "boundingBox") {
    t.type = AttachmentType::BoundingBox;
    t.weights = weights(a, t.weighted);
  }
  else if (type == "point") t.type = AttachmentType::Point;
  else if (type == "clipping") {
    t.type = AttachmentType::Clipping;
    t.end = optStr(a, "end");
  } else if (type == "path") {
    t.type = AttachmentType::Path;
    t.weights = weights(a, t.weighted);
    t.closed = boolean(a, "closed");
  } else if (type == "sequence") {
    t.type = AttachmentType::Sequence;
    if (const json* fr = get(a, "frames"))
      for (const auto& f : *fr) {
        SequenceFrame sf;
        sf.image = str(f, "image");
        if (const json* r = get(f, "rect")) {
          sf.hasRect = true;
          sf.rx = num(*r, "x");
          sf.ry = num(*r, "y");
          sf.rw = num(*r, "width");
          sf.rh = num(*r, "height");
        }
        if (const json* tr = get(f, "trim")) {
          sf.hasTrim = true;
          sf.tx = num(*tr, "x");
          sf.ty = num(*tr, "y");
          sf.sourceWidth = num(*tr, "sourceWidth");
          sf.sourceHeight = num(*tr, "sourceHeight");
        }
        t.frames.push_back(sf);
      }
    t.fps = num(a, "fps");
    t.offset = num(a, "offset");
    const std::string m = str(a, "mode", "loop");
    t.mode = m == "once" ? SequenceMode::Once : m == "pingPong" ? SequenceMode::PingPong : m == "holdLast" ? SequenceMode::HoldLast : SequenceMode::Loop;
    t.input = optStr(a, "input");
  } else if (type == "particles") {
    t.type = AttachmentType::Particles;
    // Missing fields come from core/particles.ts:defaultParticleSettings.
    t.emitting = boolean(a, "emitting", true);
    t.rate = num(a, "rate", 20);
    if (const json* bs = get(a, "bursts"))
      for (const auto& b : *bs) t.bursts.push_back({num(b, "time"), num(b, "count")});
    t.maxParticles = num(a, "maxParticles", 200);
    t.duration = num(a, "duration", 1);
    t.loop = boolean(a, "loop", true);
    t.prewarm = boolean(a, "prewarm", false);
    const std::string sh = str(a, "shape", "point");
    t.emitterShape = sh == "circle" ? EmitterShape::Circle : sh == "box" ? EmitterShape::Box : sh == "cone" ? EmitterShape::Cone : EmitterShape::Point;
    t.rotation = num(a, "rotation", 90);
    t.angle = num(a, "angle", 30);
    t.radius = num(a, "radius", 10);
    t.width = num(a, "width", 40);
    t.height = num(a, "height", 40);
    t.localSpace = str(a, "space", "world") == "local";
    t.lifetime = range(a, "lifetime", {0.8, 1.2});
    t.speed = range(a, "speed", {80, 120});
    t.gravity = num(a, "gravity", 0);
    t.drag = num(a, "drag", 0);
    t.startSize = range(a, "startSize", {10, 14});
    t.endSize = range(a, "endSize", {2, 4});
    t.startRotation = range(a, "startRotation", {0, 0});
    t.endRotation = range(a, "endRotation", {0, 0});
    t.angularVelocity = range(a, "angularVelocity", {0, 0});
    if (const json* cs = get(a, "colors")) {
      for (const auto& c : *cs) t.colors.push_back({num(c, "t"), str(c, "color", "#ffffff")});
    } else
      t.colors = {{0, "#ffffffff"}, {1, "#ffffff00"}};
    t.blend = blend(str(a, "blend", "normal"));
    const std::string lk = str(a, "look", "circle");
    t.look = lk == "square" ? ParticleLook::Square : lk == "spark" ? ParticleLook::Spark : lk == "image" ? ParticleLook::Image : ParticleLook::Circle;
    t.stretch = num(a, "stretch", 0.05);
    t.seed = num(a, "seed", 1);
  } else if (type == "text") {
    t.type = AttachmentType::Text;
    t.text = str(a, "text");
    t.font = str(a, "font", "sans-serif");
    t.size = num(a, "size", 16);
    t.weight = num(a, "weight", 400);
    const std::string al = str(a, "align", "center");
    t.align = al == "left" ? TextAlign::Left : al == "right" ? TextAlign::Right : TextAlign::Center;
    t.outline = optStr(a, "outline");
    t.outlineWidth = num(a, "outlineWidth");
  }
  return at;
}

Curve curve(const json& k) {
  Curve c;
  auto it = k.find("curve");
  if (it == k.end()) return c;
  if (it->is_string()) {
    const std::string s = it->get<std::string>();
    if (s == "stepped") c.kind = Curve::Kind::Stepped;
  } else if (it->is_array() && it->size() >= 4) {
    c.kind = Curve::Kind::Bezier;
    c.x1 = (*it)[0].get<double>();
    c.y1 = (*it)[1].get<double>();
    c.x2 = (*it)[2].get<double>();
    c.y2 = (*it)[3].get<double>();
  }
  return c;
}

TimelineTarget timelineTarget(const std::string& s) {
  if (s == "bone") return TimelineTarget::Bone;
  if (s == "slot") return TimelineTarget::Slot;
  if (s == "ik") return TimelineTarget::Ik;
  if (s == "transform") return TimelineTarget::Transform;
  if (s == "path") return TimelineTarget::Path;
  if (s == "physics") return TimelineTarget::Physics;
  if (s == "sequence") return TimelineTarget::Sequence;
  if (s == "particles") return TimelineTarget::Particles;
  if (s == "deform") return TimelineTarget::Deform;
  if (s == "drawOrder") return TimelineTarget::DrawOrder;
  return TimelineTarget::Unknown;
}

StateData state(const json& s) {
  StateData d;
  d.id = str(s, "id");
  d.name = str(s, "name");
  const std::string type = str(s, "type", "animation");
  d.type = type == "blend1d" ? StateType::Blend1d : type == "exit" ? StateType::Exit : StateType::Animation;
  d.animation = optStr(s, "animation");
  d.loop = boolean(s, "loop", true);
  d.speed = num(s, "speed", 1);
  d.blendInput = optStr(s, "blendInput");
  if (const json* b = get(s, "blend"))
    for (const auto& e : *b) d.blend.push_back({str(e, "animation"), num(e, "value")});
  d.scripts = strs(s, "scripts");
  if (const json* ss = get(s, "sounds"))
    for (const auto& x : *ss) d.sounds.push_back({str(x, "sound"), str(x, "on", "enter") == "enter", str(x, "action", "play") == "stop", optNum(x, "volume")});
  if (const json* es = get(s, "emitters"))
    for (const auto& x : *es) d.emitters.push_back({str(x, "slot"), boolean(x, "emitting")});
  if (const json* is = get(s, "inputs"))
    for (const auto& x : *is) d.inputs.push_back({str(x, "input"), valueAt(x, "value")});
  d.onComplete = optStr(s, "onComplete");
  return d;
}

ListenerAction action(const json& a) {
  ListenerAction x;
  const std::string t = str(a, "type");
  using T = ListenerAction::Type;
  x.type = t == "setInput" ? T::SetInput
         : t == "toggleInput" ? T::ToggleInput
         : t == "fireTrigger" ? T::FireTrigger
         : t == "reportEvent" ? T::ReportEvent
         : t == "runScript" ? T::RunScript
         : t == "playSound" ? T::PlaySound
         : t == "stopSound" ? T::StopSound
         : t == "setEmitter" ? T::SetEmitter
         : t == "emitParticles" ? T::EmitParticles
                                 : T::Unknown;
  x.input = str(a, "input");
  x.event = str(a, "event");
  x.script = str(a, "script");
  x.sound = str(a, "sound");
  x.slot = str(a, "slot");
  x.fn = str(a, "fn");
  x.value = valueAt(a, "value");
  x.volume = optNum(a, "volume");
  x.fade = optNum(a, "fade");
  x.emitting = boolean(a, "emitting");
  x.count = num(a, "count");
  return x;
}

PointerEvent pointerEvent(const std::string& s) {
  if (s == "up") return PointerEvent::Up;
  if (s == "enter") return PointerEvent::Enter;
  if (s == "exit") return PointerEvent::Exit;
  if (s == "move") return PointerEvent::Move;
  if (s == "click") return PointerEvent::Click;
  return PointerEvent::Down;
}

std::shared_ptr<const Document> build(const json& j) {
  if (!j.is_object() || str(j, "format") != "openbone") throw std::runtime_error("Not an OpenBone document (missing format: \"openbone\")");
  if (num(j, "version", 1) > 1) throw std::runtime_error("Document version is newer than supported 1");
  auto doc = std::make_shared<Document>();
  Document& d = *doc;
  d.name = str(j, "name");
  d.width = num(j, "width");
  d.height = num(j, "height");
  d.originX = num(j, "originX");
  d.originY = num(j, "originY");
  d.fps = num(j, "fps", 30);
  if (const json* ims = get(j, "images"))
    for (const auto& im : *ims) d.images.push_back({str(im, "id"), str(im, "name"), str(im, "src"), num(im, "width"), num(im, "height")});
  if (const json* at = get(j, "atlas")) {
    AtlasData a;
    if (const json* ps = get(*at, "pages"))
      for (const auto& p : *ps) a.pages.push_back({str(p, "id"), str(p, "name"), str(p, "src"), num(p, "width"), num(p, "height")});
    if (const json* rs = get(*at, "regions"))
      for (const auto& r : *rs) {
        AtlasRegion x;
        x.image = str(r, "image");
        x.page = str(r, "page");
        x.x = num(r, "x");
        x.y = num(r, "y");
        x.width = num(r, "width");
        x.height = num(r, "height");
        x.offsetX = num(r, "offsetX");
        x.offsetY = num(r, "offsetY");
        x.originalWidth = num(r, "originalWidth");
        x.originalHeight = num(r, "originalHeight");
        x.rotated = boolean(r, "rotated");
        x.polygon = nums(r, "polygon");
        a.regions.push_back(std::move(x));
      }
    if (const json* w = get(*at, "white")) {
      a.hasWhite = true;
      a.whitePage = str(*w, "page");
      a.whiteX = num(*w, "x");
      a.whiteY = num(*w, "y");
      a.whiteWidth = num(*w, "width");
      a.whiteHeight = num(*w, "height");
    }
    a.premultipliedAlpha = boolean(*at, "premultipliedAlpha");
    d.atlas = std::move(a);
  }
  const json empty = json::object();
  const json& sk = get(j, "skeleton") ? j["skeleton"] : empty;
  SkeletonData& s = d.skeleton;
  if (const json* bs = get(sk, "bones"))
    for (const auto& b : *bs) {
      BoneData x;
      x.id = str(b, "id");
      x.name = str(b, "name");
      x.parent = optStr(b, "parent");
      x.length = num(b, "length");
      x.x = num(b, "x");
      x.y = num(b, "y");
      x.rotation = num(b, "rotation");
      x.scaleX = num(b, "scaleX", 1);
      x.scaleY = num(b, "scaleY", 1);
      x.shearX = num(b, "shearX");
      x.shearY = num(b, "shearY");
      x.inherit = inherit(str(b, "inherit", "normal"));
      s.bones.push_back(std::move(x));
    }
  if (const json* ss = get(sk, "slots"))
    for (const auto& sl : *ss) {
      SlotData x;
      x.id = str(sl, "id");
      x.name = str(sl, "name");
      x.bone = str(sl, "bone");
      x.color = str(sl, "color", "#ffffff");
      x.attachment = optStr(sl, "attachment");
      x.blend = blend(str(sl, "blend", "normal"));
      x.dark = optStr(sl, "dark");
      if (x.dark && x.dark->empty()) x.dark.reset();
      s.slots.push_back(std::move(x));
    }
  if (const json* ks = get(sk, "skins"))
    for (const auto& k : *ks) {
      SkinData x;
      x.id = str(k, "id");
      x.name = str(k, "name");
      if (const json* atts = get(k, "attachments"))
        for (const auto& slotKey : jsKeys(*atts)) {
          const json& byName = (*atts)[slotKey];
          SlotAttachments& sa = x.attachments[slotKey];
          if (!byName.is_object()) continue;
          for (const auto& name : jsKeys(byName)) {
            auto a = attachment(name, byName[name]);
            sa.byName[name] = a.get();
            sa.keys.push_back(name);
            sa.list.push_back(std::move(a));
          }
        }
      x.bones = strs(k, "bones");
      x.constraints = strs(k, "constraints");
      s.skins.push_back(std::move(x));
    }
  if (const json* cs = get(sk, "ik"))
    for (const auto& c : *cs) {
      IkConstraintData x;
      x.id = str(c, "id");
      x.name = str(c, "name");
      x.order = optNum(c, "order");
      x.bones = strs(c, "bones");
      x.target = str(c, "target");
      x.mix = num(c, "mix", 1);
      x.bendPositive = boolean(c, "bendPositive", true);
      x.softness = num(c, "softness");
      x.stretch = boolean(c, "stretch");
      x.compress = boolean(c, "compress");
      x.uniform = boolean(c, "uniform");
      s.ik.push_back(std::move(x));
    }
  if (const json* cs = get(sk, "transform"))
    for (const auto& c : *cs) {
      TransformConstraintData x;
      x.id = str(c, "id");
      x.name = str(c, "name");
      x.order = optNum(c, "order");
      x.bones = strs(c, "bones");
      x.target = str(c, "target");
      x.mixRotate = num(c, "mixRotate");
      x.mixTranslate = num(c, "mixTranslate");
      x.mixScale = num(c, "mixScale");
      x.mixShear = num(c, "mixShear");
      x.offsetRotation = num(c, "offsetRotation");
      x.offsetX = num(c, "offsetX");
      x.offsetY = num(c, "offsetY");
      x.offsetScaleX = num(c, "offsetScaleX");
      x.offsetScaleY = num(c, "offsetScaleY");
      x.offsetShear = num(c, "offsetShear");
      x.local = boolean(c, "local");
      x.relative = boolean(c, "relative");
      s.transform.push_back(std::move(x));
    }
  if (const json* cs = get(sk, "path"))
    for (const auto& c : *cs) {
      PathConstraintData x;
      x.id = str(c, "id");
      x.name = str(c, "name");
      x.order = optNum(c, "order");
      x.bones = strs(c, "bones");
      x.target = str(c, "target");
      x.positionMode = str(c, "positionMode", "percent") == "fixed" ? PositionMode::Fixed : PositionMode::Percent;
      const std::string sm = str(c, "spacingMode", "length");
      x.spacingMode = sm == "fixed" ? SpacingMode::Fixed : sm == "percent" ? SpacingMode::Percent : sm == "proportional" ? SpacingMode::Proportional : SpacingMode::Length;
      const std::string rm = str(c, "rotateMode", "tangent");
      x.rotateMode = rm == "chain" ? RotateMode::Chain : rm == "chainScale" ? RotateMode::ChainScale : RotateMode::Tangent;
      if (const json* cs = get(c, "constantSpeed")) x.constantSpeed = !(cs->is_boolean() && !cs->get<bool>());  // only `false` turns it off
      x.offsetRotation = num(c, "offsetRotation");
      x.position = num(c, "position");
      x.spacing = num(c, "spacing");
      x.mixRotate = num(c, "mixRotate");
      x.mixX = num(c, "mixX");
      x.mixY = num(c, "mixY");
      s.path.push_back(std::move(x));
    }
  if (const json* cs = get(sk, "physics"))
    for (const auto& c : *cs) {
      PhysicsConstraintData x;
      x.id = str(c, "id");
      x.name = str(c, "name");
      x.order = optNum(c, "order");
      x.bone = str(c, "bone");
      x.x = num(c, "x");
      x.y = num(c, "y");
      x.rotate = num(c, "rotate");
      x.scaleX = num(c, "scaleX");
      x.inertia = num(c, "inertia");
      x.strength = num(c, "strength");
      x.damping = num(c, "damping");
      x.mass = num(c, "mass");
      x.gravity = num(c, "gravity");
      x.wind = num(c, "wind");
      x.mix = num(c, "mix");
      x.fps = num(c, "fps");
      s.physics.push_back(std::move(x));
    }
  if (const json* ss = get(sk, "sliders"))
    for (const auto& c : *ss) {
      SliderData x;
      x.id = str(c, "id");
      x.name = str(c, "name");
      x.animation = str(c, "animation");
      x.bone = optStr(c, "bone");
      x.input = optStr(c, "input");
      x.property = get(c, "property") ? boneProp(str(c, "property")) : BoneProp::Rotation;
      x.from = num(c, "from");
      x.to = num(c, "to");
      x.timeFrom = optNum(c, "timeFrom");
      x.timeTo = optNum(c, "timeTo");
      x.mix = num(c, "mix");
      x.loop = boolean(c, "loop");
      x.additive = boolean(c, "additive");
      s.sliders.push_back(std::move(x));
    }
  s.referenceScale = optNum(sk, "referenceScale");
  if (const json* es = get(j, "events"))
    for (const auto& e : *es) {
      EventData x;
      x.id = str(e, "id");
      x.name = str(e, "name");
      x.intValue = num(e, "int");
      x.floatValue = num(e, "float");
      x.stringValue = str(e, "string");
      x.audio = optStr(e, "audio");
      if (x.audio && x.audio->empty()) x.audio.reset();
      x.volume = optNum(e, "volume");
      d.events.push_back(std::move(x));
    }
  if (const json* as = get(j, "animations"))
    for (const auto& a : *as) {
      AnimationData x;
      x.id = str(a, "id");
      x.name = str(a, "name");
      x.duration = num(a, "duration");
      if (const json* tls = get(a, "timelines"))
        for (const auto& tl : *tls) {
          Timeline t;
          t.target = timelineTarget(str(tl, "target"));
          t.id = str(tl, "id");
          t.property = str(tl, "property");
          t.attachment = str(tl, "attachment");
          t.boneProp = boneProp(t.property);
          t.cprop = constraintProp(t.property);
          if (const json* ks = get(tl, "keys"))
            for (const auto& k : *ks) {
              Key key;
              key.time = num(k, "time");
              key.curve = curve(k);
              auto it = k.find("value");
              if (it != k.end()) {
                if (it->is_array()) {
                  for (const auto& v : *it) {
                    if (v.is_number()) key.numbers.push_back(v.get<double>());
                    else if (v.is_string()) key.ids.push_back(v.get<std::string>());
                    else key.numbers.push_back(0);
                  }
                } else
                  key.value = value(*it);
              }
              t.keys.push_back(std::move(key));
            }
          x.timelines.push_back(std::move(t));
        }
      if (const json* evs = get(a, "events"))
        for (const auto& e : *evs) x.events.push_back({num(e, "time"), str(e, "event"), optNum(e, "int"), optNum(e, "float"), optStr(e, "string")});
      if (const json* aus = get(a, "audio"))
        for (const auto& k : *aus) {
          AudioKey ak;
          ak.time = num(k, "time");
          ak.sound = str(k, "sound");
          ak.volume = optNum(k, "volume");
          ak.rate = optNum(k, "rate");
          if (const json* l = get(k, "loop"))
            if (l->is_boolean()) ak.loop = l->get<bool>();
          x.audio.push_back(std::move(ak));
        }
      double dur = x.duration;
      if (!(dur > 0)) {
        double t = 0;
        for (const auto& tl : x.timelines)
          for (const auto& k : tl.keys) t = std::max(t, k.time);
        for (const auto& e : x.events) t = std::max(t, e.time);
        for (const auto& k : x.audio) t = std::max(t, k.time);
        dur = t;
      }
      x.computedDuration = dur;
      d.animations.push_back(std::move(x));
    }
  if (const json* sms = get(j, "stateMachines"))
    for (const auto& m : *sms) {
      StateMachineData x;
      x.id = str(m, "id");
      x.name = str(m, "name");
      if (const json* is = get(m, "inputs"))
        for (const auto& i : *is) {
          InputData in;
          in.id = str(i, "id");
          in.name = str(i, "name");
          const std::string t = str(i, "type", "number");
          in.type = t == "bool" ? InputType::Bool : t == "trigger" ? InputType::Trigger : t == "string" ? InputType::String : InputType::Number;
          in.defaultValue = valueAt(i, "default");
          x.inputs.push_back(std::move(in));
        }
      if (const json* bs = get(m, "bindings"))
        for (const auto& b : *bs) {
          InputBinding ib;
          ib.id = str(b, "id");
          ib.input = str(b, "input");
          ib.target = str(b, "target");
          ib.object = str(b, "object");
          ib.property = str(b, "property");
          ib.inMin = num(b, "inMin");
          ib.inMax = num(b, "inMax");
          ib.outMin = valueAt(b, "outMin");
          ib.outMax = valueAt(b, "outMax");
          x.bindings.push_back(std::move(ib));
        }
      if (const json* ls = get(m, "layers"))
        for (const auto& l : *ls) {
          LayerData ld;
          ld.id = str(l, "id");
          ld.name = str(l, "name");
          ld.entry = optStr(l, "entry");
          if (const json* ss = get(l, "states"))
            for (const auto& st : *ss) ld.states.push_back(state(st));
          if (const json* ts = get(l, "transitions"))
            for (const auto& t : *ts) {
              TransitionData td;
              td.id = str(t, "id");
              td.from = str(t, "from");
              td.to = str(t, "to");
              if (const json* cs = get(t, "conditions"))
                for (const auto& c : *cs) td.conditions.push_back({str(c, "input"), str(c, "op", "=="), valueAt(c, "value")});
              td.duration = num(t, "duration");
              td.exitTime = optNum(t, "exitTime");
              ld.transitions.push_back(std::move(td));
            }
          x.layers.push_back(std::move(ld));
        }
      if (const json* ls = get(m, "listeners"))
        for (const auto& l : *ls) {
          ListenerData li;
          li.id = str(l, "id");
          li.name = str(l, "name");
          li.slot = optStr(l, "slot");
          li.event = pointerEvent(str(l, "event", "down"));
          if (const json* as = get(l, "actions"))
            for (const auto& a : *as) li.actions.push_back(action(a));
          x.listeners.push_back(std::move(li));
        }
      x.scripts = strs(m, "scripts");
      d.stateMachines.push_back(std::move(x));
    }
  if (const json* ss = get(j, "scripts"))
    for (const auto& sc : *ss) d.scripts.push_back({str(sc, "id"), str(sc, "name"), str(sc, "code")});
  if (const json* au = get(j, "audio")) {
    AudioData a;
    a.master = num(*au, "master", 1);
    a.muted = boolean(*au, "muted");
    if (const json* as = get(*au, "assets"))
      for (const auto& x : *as) a.assets.push_back({str(x, "id"), str(x, "name"), str(x, "src"), num(x, "duration")});
    if (const json* bs = get(*au, "buses"))
      for (const auto& x : *bs) a.buses.push_back({str(x, "id"), str(x, "name"), num(x, "volume", 1), boolean(x, "muted")});
    if (const json* ss = get(*au, "sounds"))
      for (const auto& x : *ss) {
        SoundData sd;
        sd.id = str(x, "id");
        sd.name = str(x, "name");
        sd.asset = str(x, "asset");
        sd.bus = optStr(x, "bus");
        sd.volume = num(x, "volume", 1);
        sd.rate = num(x, "rate", 1);
        sd.loop = boolean(x, "loop");
        sd.fadeIn = num(x, "fadeIn");
        sd.fadeOut = num(x, "fadeOut");
        a.sounds.push_back(std::move(sd));
      }
    d.audio = std::move(a);
  }
  return doc;
}

// ---------- binary ----------

struct BinReader {
  const uint8_t* p;
  const uint8_t* end;
  std::vector<std::string> strings;
  [[noreturn]] static void fail() { throw std::runtime_error("Corrupt OpenBone binary document"); }
  double varint() {
    double n = 0, mul = 1;
    for (;;) {
      if (p >= end) fail();
      const uint8_t b = *p++;
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 0x80;
      if (mul > 72057594037927936.0) fail();
    }
  }
  const std::string& str() {
    const double i = varint();
    if (i >= strings.size()) fail();
    return strings[size_t(i)];
  }
  json value() {
    if (p >= end) fail();
    const uint8_t tag = *p++;
    switch (tag) {
      case 0: return nullptr;
      case 1: return false;
      case 2: return true;
      case 3: return varint();
      case 4: return -varint() - 1;
      case 5: {
        if (end - p < 4) fail();
        float f;
        std::memcpy(&f, p, 4);  // little-endian hosts
        p += 4;
        return jsRoundPrecision(double(f), 7);
      }
      case 6: {
        if (end - p < 8) fail();
        double v;
        std::memcpy(&v, p, 8);
        p += 8;
        return v;
      }
      case 7: return str();
      case 8: {
        const double n = varint();
        json a = json::array();
        for (double i = 0; i < n; i++) a.push_back(value());
        return a;
      }
      case 9: {
        const double n = varint();
        json o = json::object();
        for (double i = 0; i < n; i++) {
          const std::string k = str();
          o[k] = value();
        }
        return o;
      }
      case 10: {
        const std::string mime = str();
        const double n = varint();
        if (end - p < n) fail();
        static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string url = "data:" + mime + ";base64,";
        const size_t len = size_t(n);
        for (size_t i = 0; i < len; i += 3) {
          const uint32_t b0 = p[i], b1 = i + 1 < len ? p[i + 1] : 0, b2 = i + 2 < len ? p[i + 2] : 0;
          const uint32_t v = (b0 << 16) | (b1 << 8) | b2;
          url += tbl[(v >> 18) & 63];
          url += tbl[(v >> 12) & 63];
          url += i + 1 < len ? tbl[(v >> 6) & 63] : '=';
          url += i + 2 < len ? tbl[v & 63] : '=';
        }
        p += len;
        return url;
      }
      default: fail();
    }
  }
};

}  // namespace

std::shared_ptr<const Document> loadJson(const std::string& text) {
  json j;
  try {
    j = json::parse(text);
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Invalid JSON: ") + e.what());
  }
  return build(j);
}

std::shared_ptr<const Document> loadBinary(const uint8_t* data, size_t size) {
  if (size < 5 || std::memcmp(data, "OBNB", 4) != 0) throw std::runtime_error("Not an OpenBone binary document (missing OBNB header)");
  if (data[4] > 1) throw std::runtime_error("Binary version is newer than supported 1");
  BinReader r{data + 5, data + size, {}};
  const double count = r.varint();
  for (double i = 0; i < count; i++) {
    const double n = r.varint();
    if (r.end - r.p < n) BinReader::fail();
    r.strings.emplace_back(reinterpret_cast<const char*>(r.p), size_t(n));
    r.p += size_t(n);
  }
  json j = r.value();
  return build(j);
}

std::shared_ptr<const Document> loadDocument(const uint8_t* data, size_t size) {
  if (size >= 5 && std::memcmp(data, "OBNB", 4) == 0) return loadBinary(data, size);
  return loadJson(std::string(reinterpret_cast<const char*>(data), size));
}

std::shared_ptr<const Document> loadFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("Cannot open " + path);
  std::stringstream ss;
  ss << f.rdbuf();
  const std::string s = ss.str();
  return loadDocument(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

const AnimationData* Document::findAnimation(const std::string& ref) const {
  for (const auto& a : animations)
    if (a.id == ref || a.name == ref) return &a;
  return nullptr;
}
const AnimationData* Document::animationById(const Id& id) const {
  for (const auto& a : animations)
    if (a.id == id) return &a;
  return nullptr;
}
const EventData* Document::eventById(const Id& id) const {
  for (const auto& e : events)
    if (e.id == id) return &e;
  return nullptr;
}
const StateMachineData* Document::findStateMachine(const std::string& ref) const {
  for (const auto& s : stateMachines)
    if (s.name == ref || s.id == ref) return &s;
  return nullptr;
}

}  // namespace openbone
