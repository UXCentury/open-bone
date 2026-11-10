// Port of packages/runtime/src/skeleton.ts. Section numbers refer to docs/runtime-spec.md.
// SPDX-License-Identifier: MIT
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "internal.hpp"

namespace openbone {

void applyTimelines(Skeleton& sk, const AnimationData& anim, double time, double alpha, int filter, const MixOut* mixOut = nullptr);  // animation.cpp

// ---------------- Bone ----------------

Bone::Bone(const BoneData& d) : data(&d) {
  setToSetupPose();
  resetApplied();
}

void Bone::setToSetupPose() {
  const BoneData& d = *data;
  x = d.x;
  y = d.y;
  rotation = d.rotation;
  scaleX = d.scaleX;
  scaleY = d.scaleY;
  shearX = d.shearX;
  shearY = d.shearY;
  inherit = d.inherit;
}

void Bone::resetApplied() { applied = {x, y, rotation, scaleX, scaleY, shearX, shearY}; }

void Bone::updateWorld(const Affine& root) { world = boneWorld(parent ? &parent->world : &root, applied, parent ? inherit : Inherit::Normal); }

void Bone::syncApplied(const Affine& root) {
  applied = localFromWorld(parent ? parent->world : root, world, parent ? inherit : Inherit::Normal, applied);
}

void Bone::updateSubtree(const Affine& root, bool includeSelf) {
  if (!active) return;
  if (includeSelf) updateWorld(root);
  for (Bone* c : children) c->updateSubtree(root, true);
}

double Bone::get(BoneProp p) const {
  switch (p) {
    case BoneProp::X: return x;
    case BoneProp::Y: return y;
    case BoneProp::Rotation: return rotation;
    case BoneProp::ScaleX: return scaleX;
    case BoneProp::ScaleY: return scaleY;
    case BoneProp::ShearX: return shearX;
    case BoneProp::ShearY: return shearY;
    default: return NAN;
  }
}
void Bone::set(BoneProp p, double v) {
  switch (p) {
    case BoneProp::X: x = v; break;
    case BoneProp::Y: y = v; break;
    case BoneProp::Rotation: rotation = v; break;
    case BoneProp::ScaleX: scaleX = v; break;
    case BoneProp::ScaleY: scaleY = v; break;
    case BoneProp::ShearX: shearX = v; break;
    case BoneProp::ShearY: shearY = v; break;
    default: break;
  }
}
double Bone::worldRotation() const { return openbone::worldRotation(world); }

// ---------------- Slot ----------------

Slot::Slot(const SlotData& d, Bone* b) : data(&d), bone(b) { setToSetupPose(); }

void Slot::setToSetupPose() {
  color = parseHex(data->color);
  if (data->dark) dark = parseHex(*data->dark);
  else dark.reset();
  attachmentName = data->attachment;
  deform.clear();
  sequenceFrames.clear();
}

const Id& ConstraintRef::id() const {
  switch (kind) {
    case ConstraintKind::Ik: return static_cast<const IkConstraintData*>(data)->id;
    case ConstraintKind::Transform: return static_cast<const TransformConstraintData*>(data)->id;
    case ConstraintKind::Path: return static_cast<const PathConstraintData*>(data)->id;
    default: return static_cast<const PhysicsConstraintData*>(data)->id;
  }
}

// ---------------- Internals ----------------

struct PhysParticle {
  double x, y, vx, vy, px, py;
};
struct PhysicsState {
  PhysParticle origin, tip;
  double lastO[2], lastT[2];
  double time = 0;
  double steps = 0;
};

struct Skeleton::Packed {
  const AtlasPage* page;
  double rx, ry, rw, rh;
  double ou, ov, su, sv;
  bool rotated;
  std::vector<float> regionUvs;
  bool trimmed = false;
  double trim[4] = {0, 0, 1, 1};
  bool hasPoly = false;
  std::vector<float> polyImage, polyUvs;
  std::vector<uint16_t> polyIndices;
};

namespace {

const float REGION_UVS[8] = {0, 0, 1, 0, 1, 1, 0, 1};
const uint16_t REGION_INDICES[6] = {0, 1, 2, 0, 2, 3};
constexpr int MAX_PHYSICS_STEPS = 8;

void rotateAxes(Affine& w, double rad) {
  if (rad == 0) return;
  const double cos = std::cos(rad), sin = std::sin(rad);
  const double a = w.a, b = w.b, c = w.c, d = w.d;
  w.a = cos * a - sin * c;
  w.b = cos * b - sin * d;
  w.c = sin * a + cos * c;
  w.d = sin * b + cos * d;
}
double skewOf(const Affine& m) { return wrapDeg((std::atan2(m.d, m.b) - std::atan2(m.c, m.a)) * RAD - 90); }
void setSkew(Affine& w, double skewDeg) {
  const double ly = jsHypot(w.b, w.d);
  const double ang = std::atan2(w.c, w.a) + (90 + skewDeg) * DEG;
  w.b = std::cos(ang) * ly;
  w.d = std::sin(ang) * ly;
}
double detSign(const Affine& m) {
  const double s = jsSign(m.a * m.d - m.b * m.c);
  return orNum(s, 1);
}

std::vector<float> trimQuad(const std::vector<float>& q, double u0, double v0, double u1, double v1) {
  const double ux = double(q[2]) - q[0], uy = double(q[3]) - q[1];
  const double vx = double(q[6]) - q[0], vy = double(q[7]) - q[1];
  auto at = [&](double u, double v, float* o) {
    o[0] = float(q[0] + ux * u + vx * v);
    o[1] = float(q[1] + uy * u + vy * v);
  };
  std::vector<float> out(8);
  at(u0, v0, &out[0]);
  at(u1, v0, &out[2]);
  at(u1, v1, &out[4]);
  at(u0, v1, &out[6]);
  return out;
}

std::vector<float> quadPoints(const std::vector<float>& q, const std::vector<float>& uv) {
  const double ux = double(q[2]) - q[0], uy = double(q[3]) - q[1];
  const double vx = double(q[6]) - q[0], vy = double(q[7]) - q[1];
  std::vector<float> out(uv.size());
  for (size_t i = 0; i + 1 < uv.size(); i += 2) {
    out[i] = float(q[0] + ux * uv[i] + vx * uv[i + 1]);
    out[i + 1] = float(q[1] + uy * uv[i] + vy * uv[i + 1]);
  }
  return out;
}

std::vector<float> fill2(size_t n, double a, double b) {
  std::vector<float> out(n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    out[i] = float(a);
    out[i + 1] = float(b);
  }
  return out;
}

ConstraintValues setupValues(ConstraintKind kind, const void* c) {
  ConstraintValues v;
  switch (kind) {
    case ConstraintKind::Ik: {
      const auto& d = *static_cast<const IkConstraintData*>(c);
      v.set(CProp::Mix, d.mix);
      v.set(CProp::Softness, d.softness);
      v.set(CProp::Bend, d.bendPositive ? 1 : -1);
      v.set(CProp::Stretch, d.stretch ? 1 : 0);
      v.set(CProp::Compress, d.compress ? 1 : 0);
      break;
    }
    case ConstraintKind::Transform: {
      const auto& d = *static_cast<const TransformConstraintData*>(c);
      v.set(CProp::Mix, 1);
      v.set(CProp::MixRotate, d.mixRotate);
      v.set(CProp::MixTranslate, d.mixTranslate);
      v.set(CProp::MixScale, d.mixScale);
      v.set(CProp::MixShear, d.mixShear);
      break;
    }
    case ConstraintKind::Path: {
      const auto& d = *static_cast<const PathConstraintData*>(c);
      v.set(CProp::Position, d.position);
      v.set(CProp::Spacing, d.spacing);
      v.set(CProp::MixRotate, d.mixRotate);
      v.set(CProp::MixX, d.mixX);
      v.set(CProp::MixY, d.mixY);
      break;
    }
    case ConstraintKind::Physics: {
      const auto& d = *static_cast<const PhysicsConstraintData*>(c);
      v.set(CProp::Mix, d.mix);
      v.set(CProp::Inertia, d.inertia);
      v.set(CProp::Strength, d.strength);
      v.set(CProp::Damping, d.damping);
      v.set(CProp::Mass, d.mass);
      v.set(CProp::Gravity, d.gravity);
      v.set(CProp::Wind, d.wind);
      break;
    }
  }
  return v;
}

int sequenceFrameIndex(int count, SequenceMode mode, double counter) {
  if (count <= 0 || !std::isfinite(counter)) return count > 0 ? 0 : -1;
  const double f = std::floor(counter);
  switch (mode) {
    case SequenceMode::Loop: return int(std::fmod(std::fmod(f, count) + count, count));
    case SequenceMode::Once: return f < 0 ? 0 : f >= count ? -1 : int(f);
    case SequenceMode::HoldLast: return int(std::min(std::max(f, 0.0), double(count - 1)));
    case SequenceMode::PingPong: {
      if (count == 1) return 0;
      const double period = 2.0 * count - 2;
      const double k = std::fmod(std::fmod(f, period) + period, period);
      return int(k < count ? k : period - k);
    }
  }
  return 0;
}

}  // namespace

template <class T>
std::vector<float> remapUvsImpl(const T* uvs, size_t n, double ou, double ov, double su, double sv, bool rotated) {
  std::vector<float> out(n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    const double u = uvs[i], v = uvs[i + 1];
    out[i] = float(rotated ? ou - v * su : ou + u * su);
    out[i + 1] = float(rotated ? ov + u * sv : ov + v * sv);
  }
  return out;
}

// ---------------- Skeleton ----------------

Skeleton::Skeleton(std::shared_ptr<const Document> d) : docPtr(std::move(d)), doc(*docPtr) {
  for (const auto& bd : doc.skeleton.bones) {
    auto b = std::make_unique<Bone>(bd);
    if (bd.parent && !bd.parent->empty()) {
      auto it = boneMap.find(*bd.parent);
      if (it != boneMap.end()) {
        b->parent = it->second;
        it->second->children.push_back(b.get());
      }
    }
    boneMap[bd.id] = b.get();
    bones.push_back(std::move(b));
  }
  for (const auto& sd : doc.skeleton.slots) {
    auto it = boneMap.find(sd.bone);
    if (it == boneMap.end()) continue;
    auto s = std::make_unique<Slot>(sd, it->second);
    slotMap[sd.id] = s.get();
    slots.push_back(std::move(s));
  }
  for (const auto& im : doc.images) images[im.id] = &im;
  if (doc.atlas) {
    std::unordered_map<Id, const AtlasPage*> pages;
    for (const auto& p : doc.atlas->pages) pages[p.id] = &p;
    for (const auto& r : doc.atlas->regions) {
      auto pit = pages.find(r.page);
      if (pit == pages.end() || !images.count(r.image)) continue;
      const AtlasPage* page = pit->second;
      auto pk = std::make_unique<Packed>();
      pk->page = page;
      if (r.rotated) {
        pk->ou = (r.x + r.height + r.offsetY) / page->width;
        pk->ov = (r.y - r.offsetX) / page->height;
        pk->su = r.originalHeight / page->width;
        pk->sv = r.originalWidth / page->height;
        pk->rotated = true;
      } else {
        pk->ou = (r.x - r.offsetX) / page->width;
        pk->ov = (r.y - r.offsetY) / page->height;
        pk->su = r.originalWidth / page->width;
        pk->sv = r.originalHeight / page->height;
        pk->rotated = false;
      }
      pk->trimmed = r.offsetX != 0 || r.offsetY != 0 || r.width != r.originalWidth || r.height != r.originalHeight;
      if (pk->trimmed) {
        pk->trim[0] = r.offsetX / r.originalWidth;
        pk->trim[1] = r.offsetY / r.originalHeight;
        pk->trim[2] = (r.offsetX + r.width) / r.originalWidth;
        pk->trim[3] = (r.offsetY + r.height) / r.originalHeight;
        const float quad[8] = {float(pk->trim[0]), float(pk->trim[1]), float(pk->trim[2]), float(pk->trim[1]),
                               float(pk->trim[2]), float(pk->trim[3]), float(pk->trim[0]), float(pk->trim[3])};
        pk->regionUvs = remapUvsImpl(quad, 8, pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
      } else
        pk->regionUvs = remapUvsImpl(REGION_UVS, 8, pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
      pk->rx = r.x;
      pk->ry = r.y;
      pk->rw = r.rotated ? r.height : r.width;
      pk->rh = r.rotated ? r.width : r.height;
      if (r.polygon.size() >= 6) {
        pk->hasPoly = true;
        pk->polyImage.resize(r.polygon.size());
        for (size_t i = 0; i + 1 < r.polygon.size(); i += 2) {
          pk->polyImage[i] = float(r.polygon[i] / r.originalWidth);
          pk->polyImage[i + 1] = float(r.polygon[i + 1] / r.originalHeight);
        }
        const size_t n = pk->polyImage.size() / 2;
        for (size_t i = 0; i + 2 < n; i++) {
          pk->polyIndices.push_back(0);
          pk->polyIndices.push_back(uint16_t(i + 1));
          pk->polyIndices.push_back(uint16_t(i + 2));
        }
        pk->polyUvs = remapUvsImpl(pk->polyImage.data(), pk->polyImage.size(), pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
      }
      packed[r.image] = std::move(pk);
    }
    if (doc.atlas->hasWhite) {
      auto pit = pages.find(doc.atlas->whitePage);
      if (pit != pages.end()) {
        hasWhite = true;
        whitePage = pit->second;
        whiteU = (doc.atlas->whiteX + doc.atlas->whiteWidth / 2) / whitePage->width;
        whiteV = (doc.atlas->whiteY + doc.atlas->whiteHeight / 2) / whitePage->height;
      }
    }
  }
  for (const auto& sm : doc.stateMachines)
    for (const auto& i : sm.inputs) {
      if (i.defaultValue.isNumber()) inputDefaults[i.id] = i.defaultValue.n;
      if (i.type != InputType::Trigger && !i.defaultValue.isUndefined() && !inputDefaultsByName.count(i.name)) inputDefaultsByName[i.name] = i.defaultValue;
    }
  // Constraint order (core/constraints.ts:constraintOrder).
  const auto& sk = doc.skeleton;
  for (const auto& c : sk.ik) order.push_back({ConstraintKind::Ik, &c});
  for (const auto& c : sk.transform) order.push_back({ConstraintKind::Transform, &c});
  for (const auto& c : sk.path) order.push_back({ConstraintKind::Path, &c});
  for (const auto& c : sk.physics) order.push_back({ConstraintKind::Physics, &c});
  auto orderOf = [](const ConstraintRef& r) -> std::optional<double> {
    switch (r.kind) {
      case ConstraintKind::Ik: return static_cast<const IkConstraintData*>(r.data)->order;
      case ConstraintKind::Transform: return static_cast<const TransformConstraintData*>(r.data)->order;
      case ConstraintKind::Path: return static_cast<const PathConstraintData*>(r.data)->order;
      default: return static_cast<const PhysicsConstraintData*>(r.data)->order;
    }
  };
  bool anyOrder = false;
  for (const auto& r : order)
    if (orderOf(r)) anyOrder = true;
  if (anyOrder) {
    std::vector<std::pair<double, size_t>> keys;
    for (size_t i = 0; i < order.size(); i++) keys.push_back({orderOf(order[i]).value_or(double(i)), i});
    std::stable_sort(keys.begin(), keys.end(), [](const auto& a, const auto& b) { return a.first < b.first || (a.first == b.first && a.second < b.second); });
    std::vector<ConstraintRef> sorted;
    for (const auto& k : keys) sorted.push_back(order[k.second]);
    order = sorted;
  }
  for (const auto& skin : sk.skins) {
    for (const auto& id : skin.bones) requiredBones.insert(id);
    for (const auto& id : skin.constraints) requiredConstraints.insert(id);
  }
  updateActive();
  setToSetupPose();
  updateWorldTransform();
}

Skeleton::~Skeleton() = default;

Bone* Skeleton::boneById(const Id& id) const {
  auto it = boneMap.find(id);
  return it == boneMap.end() ? nullptr : it->second;
}
Slot* Skeleton::slotById(const Id& id) const {
  auto it = slotMap.find(id);
  return it == slotMap.end() ? nullptr : it->second;
}
Bone* Skeleton::findBone(const std::string& ref) const {
  if (Bone* b = boneById(ref)) return b;
  for (const auto& b : bones)
    if (b->data->name == ref) return b.get();
  return nullptr;
}
Slot* Skeleton::findSlot(const std::string& ref) const {
  if (Slot* s = slotById(ref)) return s;
  for (const auto& s : slots)
    if (s->data->name == ref) return s.get();
  return nullptr;
}

void Skeleton::setSkin(const std::string* ref) {
  const SkinData* found = nullptr;
  if (ref && !ref->empty())
    for (const auto& s : doc.skeleton.skins)
      if (s.id == *ref || s.name == *ref) {
        found = &s;
        break;
      }
  if (found == skin && activeComputed && activeFor == found) return;
  skin = found;
  updateActive();
}

void Skeleton::updateActive() {
  activeComputed = true;
  activeFor = skin;
  const auto& sk = doc.skeleton;
  if (requiredBones.empty()) {
    for (auto& b : bones) b->active = true;
  } else {
    std::unordered_set<Id> mineB;
    if (skin) mineB.insert(skin->bones.begin(), skin->bones.end());
    std::unordered_set<Id> out;
    for (const auto& b : sk.bones) {
      if (b.parent && !b.parent->empty() && !out.count(*b.parent)) continue;
      if (!requiredBones.count(b.id) || mineB.count(b.id)) out.insert(b.id);
    }
    for (auto& b : bones) b->active = out.count(b->data->id) > 0;
  }
  inactiveConstraints.clear();
  std::unordered_set<Id> mineC;
  if (skin) mineC.insert(skin->constraints.begin(), skin->constraints.end());
  auto off = [&](const Id& id) {
    Bone* b = boneById(id);
    return b ? !b->active : false;
  };
  for (const auto& e : order) {
    const Id& id = e.id();
    bool skip = requiredConstraints.count(id) && !mineC.count(id);
    if (!skip && !requiredBones.empty()) {
      if (e.kind == ConstraintKind::Physics) skip = off(static_cast<const PhysicsConstraintData*>(e.data)->bone);
      else if (e.kind == ConstraintKind::Path) {
        const auto& c = *static_cast<const PathConstraintData*>(e.data);
        for (const auto& b : c.bones) skip = skip || off(b);
        Slot* s = slotById(c.target);
        skip = skip || off(s ? s->bone->data->id : Id());
      } else {
        const std::vector<Id>& bs = e.kind == ConstraintKind::Ik ? static_cast<const IkConstraintData*>(e.data)->bones
                                                                  : static_cast<const TransformConstraintData*>(e.data)->bones;
        const Id& t = e.kind == ConstraintKind::Ik ? static_cast<const IkConstraintData*>(e.data)->target
                                                    : static_cast<const TransformConstraintData*>(e.data)->target;
        for (const auto& b : bs) skip = skip || off(b);
        skip = skip || off(t);
      }
    }
    if (skip) inactiveConstraints.insert(id);
  }
}

void Skeleton::setToSetupPose() {
  for (auto& b : bones) b->setToSetupPose();
  for (auto& s : slots) s->setToSetupPose();
  drawOrder.clear();
  for (auto& s : slots) drawOrder.push_back(s.get());
  animationTime.reset();
  constraintValues.clear();
  particleValues.clear();
  for (const auto& e : order) constraintValues[e.id()] = setupValues(e.kind, e.data);
}

ConstraintValues& Skeleton::values(const ConstraintRef& c) {
  auto it = constraintValues.find(c.id());
  if (it == constraintValues.end()) it = constraintValues.emplace(c.id(), setupValues(c.kind, c.data)).first;
  return it->second;
}

void Skeleton::update(double dt) {
  if (dt > 0) {
    pendingDt += dt;
    clock += dt;
    particlePending += dt;
  }
}

// ---------------- Particles ----------------

void Skeleton::resetParticles() {
  emitters.clear();
  pendingBursts.clear();
  particlePending = 0;
  particleFrac = 0;
  particleSteps = 0;
}

void Skeleton::seekParticles(double t, const std::function<void(double)>& pose) {
  particleClockRealtime = false;
  particlePending = 0;
  const long long target = (long long)std::max(0.0, std::floor(t / PARTICLE_STEP + 1e-6));
  if (target < particleSteps) resetParticles();
  while (particleSteps < target) {
    pose(particleSteps * PARTICLE_STEP);
    stepParticles(PARTICLE_STEP);
    particleSteps++;
  }
  particleFrac = std::max(0.0, std::min(PARTICLE_STEP, t - target * PARTICLE_STEP));
}

void Skeleton::setEmitting(const std::string& slotRef, bool emitting) {
  if (Slot* s = findSlot(slotRef)) particleValues[s->data->id].emitting = emitting;
}
void Skeleton::restartEmitter(const std::string& slotRef) {
  if (Slot* s = findSlot(slotRef)) {
    auto it = emitters.find(s->data->id);
    if (it != emitters.end()) it->second->restart();
  }
}
void Skeleton::emitParticles(const std::string& slotRef, double count) {
  Slot* s = findSlot(slotRef);
  if (!s || !(count > 0)) return;
  for (auto& p : pendingBursts)
    if (p.first == s->data->id) {
      p.second += count;
      return;
    }
  pendingBursts.push_back({s->data->id, count});
}

void Skeleton::stepParticles(double h) {
  for (auto& sp : slots) {
    Slot& slot = *sp;
    if (!slot.bone->active) continue;
    const Attachment* att = getAttachment(slot);
    const Id& id = slot.data->id;
    if (!att || att->type != AttachmentType::Particles) {
      emitters.erase(id);
      continue;
    }
    auto it = emitters.find(id);
    if (it == emitters.end() || it->second->data != att) {
      emitters[id] = std::make_unique<ParticleEmitter>(att, hashString(slot.data->name));
      it = emitters.find(id);
    }
    for (const auto& pb : pendingBursts)
      if (pb.first == id && pb.second) it->second->pending += pb.second;
    auto pv = particleValues.find(id);
    it->second->step(h, slot.bone->world, pv == particleValues.end() ? nullptr : &pv->second);
  }
  pendingBursts.clear();
}

void Skeleton::advanceParticles(double dt) {
  const double acc = particleFrac + dt;
  const double n = std::floor(acc / PARTICLE_STEP + 1e-6);
  const int steps = (int)std::min(n, double(MAX_PARTICLE_STEPS));
  for (int i = 0; i < steps; i++) stepParticles(PARTICLE_STEP);
  particleSteps += steps;
  particleFrac = std::max(0.0, std::min(PARTICLE_STEP, acc - n * PARTICLE_STEP));
}

void Skeleton::resetPhysics() {
  physicsState.clear();
  pendingDt = 0;
}

double Skeleton::unitScaleX() const { return (doc.skeleton.referenceScale.value_or(100) / 100) * scaleX; }
double Skeleton::unitScaleY() const { return (doc.skeleton.referenceScale.value_or(100) / 100) * scaleY; }

// ---------------- World transform ----------------

void Skeleton::updateWorldTransform() {
  applySliders();
  const Affine root = rootMatrix();
  for (auto& b : bones) {
    if (!b->active) continue;
    b->resetApplied();
    b->updateWorld(root);
  }
  const double dt = pendingDt;
  pendingDt = 0;
  for (const auto& e : order) {
    if (inactiveConstraints.count(e.id())) continue;
    switch (e.kind) {
      case ConstraintKind::Ik: applyIk(*static_cast<const IkConstraintData*>(e.data), values(e)); break;
      case ConstraintKind::Transform: applyTransform(*static_cast<const TransformConstraintData*>(e.data), values(e)); break;
      case ConstraintKind::Path: applyPath(*static_cast<const PathConstraintData*>(e.data), values(e)); break;
      case ConstraintKind::Physics: applyPhysics(*static_cast<const PhysicsConstraintData*>(e.data), values(e), dt); break;
    }
  }
  const double pdt = particlePending;
  particlePending = 0;
  if (particleClockRealtime && pdt > 0) advanceParticles(pdt);
}

// ---------------- Sliders ----------------

void Skeleton::applySliders() {
  const auto& list = doc.skeleton.sliders;
  if (list.empty()) return;
  const std::optional<double> savedTime = animationTime;
  static const BoneProp props[7] = {BoneProp::X, BoneProp::Y, BoneProp::Rotation, BoneProp::ScaleX, BoneProp::ScaleY, BoneProp::ShearX, BoneProp::ShearY};
  for (const auto& sl : list) {
    if (sl.mix <= 0) continue;
    const AnimationData* anim = doc.animationById(sl.animation);
    if (!anim) continue;
    double v;
    if (sl.bone && !sl.bone->empty()) {
      Bone* b = boneById(*sl.bone);
      if (!b) continue;
      v = b->get(sl.property);
    } else if (sl.input && !sl.input->empty()) {
      auto it = inputValues.find(*sl.input);
      if (it != inputValues.end()) v = it->second;
      else {
        auto d = inputDefaults.find(*sl.input);
        v = d != inputDefaults.end() ? d->second : 0;
      }
    } else
      continue;
    const double span = sl.to - sl.from;
    double f = span == 0 ? 0 : (v - sl.from) / span;
    f = sl.loop ? f - std::floor(f) : std::min(1.0, std::max(0.0, f));
    const double t0 = sl.timeFrom.value_or(0);
    const double t1 = sl.timeTo.value_or(anim->computedDuration);
    const double t = t0 + f * (t1 - t0);
    if (!sl.additive) {
      applyAnimation(*this, *anim, t, sl.mix);
      continue;
    }
    std::vector<std::array<double, 7>> before(bones.size());
    std::vector<Inherit> inherits(bones.size());
    for (size_t i = 0; i < bones.size(); i++) {
      for (int k = 0; k < 7; k++) before[i][k] = bones[i]->get(props[k]);
      inherits[i] = bones[i]->inherit;
    }
    for (auto& b : bones) b->setToSetupPose();
    applyTimelines(*this, *anim, t, 1, 1);
    for (size_t i = 0; i < bones.size(); i++) {
      Bone& b = *bones[i];
      const BoneData& d = *b.data;
      const double setup[7] = {d.x, d.y, d.rotation, d.scaleX, d.scaleY, d.shearX, d.shearY};
      for (int k = 0; k < 7; k++) {
        const double cur = b.get(props[k]);
        const double delta = props[k] == BoneProp::Rotation ? wrapDeg(cur - setup[k]) : cur - setup[k];
        b.set(props[k], before[i][k] + delta * sl.mix);
      }
    }
    std::unordered_set<Id> keysInherit;
    for (const auto& tl : anim->timelines)
      if (tl.target == TimelineTarget::Bone && tl.property == "inherit") keysInherit.insert(tl.id);
    for (size_t i = 0; i < bones.size(); i++)
      if (sl.mix < 0.5 || !keysInherit.count(bones[i]->data->id)) bones[i]->inherit = inherits[i];
    bool other = false;
    for (const auto& tl : anim->timelines)
      if (tl.target != TimelineTarget::Bone) other = true;
    if (other) applyTimelines(*this, *anim, t, sl.mix, 2);
  }
  animationTime = savedTime;
}

// ---------------- IK ----------------

void Skeleton::applyIk(const IkConstraintData& c, ConstraintValues& v) {
  const double mix = v.get(CProp::Mix, NAN);
  if (mix <= 0) return;
  const bool bendPositive = v.get(CProp::Bend, c.bendPositive ? 1 : -1) > 0;
  const bool stretch = v.get(CProp::Stretch, c.stretch ? 1 : 0) > 0;
  const bool compress = v.get(CProp::Compress, c.compress ? 1 : 0) > 0;
  const bool uniform = c.uniform;
  Bone* target = boneById(c.target);
  std::vector<Bone*> bs;
  for (const auto& id : c.bones)
    if (Bone* b = boneById(id)) bs.push_back(b);
  if (!target || bs.empty()) return;
  const Affine root = rootMatrix();
  const double tx = target->world.x, ty = target->world.y;
  if (bs.size() == 1) {
    Bone& b = *bs[0];
    const Affine pw = b.parent ? b.parent->world : root;
    const Affine inv = invert(pw);
    const double dx = tx - b.world.x, dy = ty - b.world.y;
    const double lx = inv.a * dx + inv.b * dy, ly = inv.c * dx + inv.d * dy;
    const double want = std::atan2(ly, lx) * RAD - b.applied.shearX;
    b.applied.rotation += wrapDeg(want - b.applied.rotation) * mix;
    b.updateWorld(root);
    const double len = b.data->length * worldScaleX(b.world);
    if ((stretch || compress) && len > 1e-6) {
      const double k = jsHypot(dx, dy) / len;
      if ((k > 1 && stretch) || (k < 1 && compress)) {
        const double s = 1 + (k - 1) * mix;
        b.world.a *= s;
        b.world.c *= s;
        if (uniform) {
          b.world.b *= s;
          b.world.d *= s;
        }
        b.syncApplied(root);
      }
    }
    b.updateSubtree(root, false);
    return;
  }
  Bone& p = *bs[0];
  Bone& ch = *bs[1];
  const double px = p.world.x, py = p.world.y;
  const double l1 = jsHypot(ch.world.x - px, ch.world.y - py);
  const double l2 = ch.data->length * worldScaleX(ch.world);
  const double reach = l1 + l2;
  const double dRaw = jsHypot(tx - px, ty - py);
  double dSoft = dRaw;
  const double soft = std::min(v.get(CProp::Softness, 0) * std::fabs(unitScaleX()), reach);
  if (soft > 1e-6 && dRaw > reach - soft) dSoft = reach - soft + soft * (1 - std::exp(-(dRaw - (reach - soft)) / soft));
  const double dEff = std::min(std::max(dSoft, std::fabs(l1 - l2) + 1e-4), reach - 1e-4);
  const double ux = dRaw > 1e-9 ? (tx - px) / dRaw : 1;
  const double uy = dRaw > 1e-9 ? (ty - py) / dRaw : 0;
  const double ax = px + ux * dEff, ay = py + uy * dEff;
  const double base = std::atan2(uy, ux);
  const double cosA = (l1 * l1 + dEff * dEff - l2 * l2) / orNum(2 * l1 * dEff, 1);
  const double a1 = base + (bendPositive ? -1 : 1) * std::acos(std::max(-1.0, std::min(1.0, cosA)));
  const double curDir = std::atan2(ch.world.y - py, ch.world.x - px);
  const double sP = detSign(p.parent ? p.parent->world : root);
  const double deltaP = wrapDeg((a1 - curDir) * RAD) * sP;
  const double pRot = p.applied.rotation, cRot = ch.applied.rotation;
  p.applied.rotation = pRot + deltaP;
  p.updateSubtree(root, true);
  const double want = std::atan2(ay - ch.world.y, ax - ch.world.x) * RAD;
  const double sC = detSign(p.world);
  const double deltaC = wrapDeg(want - ch.worldRotation()) * sC;
  p.applied.rotation = pRot + deltaP * mix;
  ch.applied.rotation = cRot + deltaC * mix;
  p.updateWorld(root);
  ch.updateWorld(root);
  if (stretch && dRaw > dEff + 1e-9) {
    const double s = 1 + (dRaw / dEff - 1) * mix;
    const Affine cw = ch.world;
    const double u = uniform ? s : 1;
    p.world.a *= s;
    p.world.c *= s;
    p.world.b *= u;
    p.world.d *= u;
    double ox, oy;
    applyAffine(p.world, ch.applied.x, ch.applied.y, ox, oy);
    ch.world = {cw.a * s, cw.b * u, cw.c * s, cw.d * u, ox, oy};
    p.syncApplied(root);
    ch.syncApplied(root);
  }
  ch.updateSubtree(root, false);
  for (Bone* sib : p.children)
    if (sib != &ch) sib->updateSubtree(root, true);
}

// ---------------- Transform ----------------

Affine Skeleton::setupWorldOf(const Id& id) const {
  if (!setupCache) {
    setupCache = std::make_unique<std::unordered_map<Id, Affine>>();
    for (const auto& b : doc.skeleton.bones) {
      const Affine* parent = nullptr;
      if (b.parent && !b.parent->empty()) {
        auto it = setupCache->find(*b.parent);
        if (it != setupCache->end()) parent = &it->second;
      }
      LocalTransform l{b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY};
      Affine w = boneWorld(parent, l, b.inherit);
      (*setupCache)[b.id] = w;
    }
  }
  auto it = setupCache->find(id);
  return multiply(rootMatrix(), it != setupCache->end() ? it->second : identity());
}

void Skeleton::applyTransform(const TransformConstraintData& c, ConstraintValues& v) {
  const double m = v.get(CProp::Mix, 1);
  const double mr = v.get(CProp::MixRotate, NAN) * m, mt = v.get(CProp::MixTranslate, NAN) * m, ms = v.get(CProp::MixScale, NAN) * m,
               mh = v.get(CProp::MixShear, 0) * m;
  if (mr <= 0 && mt <= 0 && ms <= 0 && mh <= 0) return;
  Bone* target = boneById(c.target);
  if (!target) return;
  const Affine root = rootMatrix();
  const double offScaleX = c.offsetScaleX, offScaleY = c.offsetScaleY, offShear = c.offsetShear;
  for (const auto& id : c.bones) {
    Bone* bp = boneById(id);
    if (!bp || bp == target) continue;
    Bone& b = *bp;
    if (c.local) {
      LocalTransform& p = b.applied;
      const LocalTransform& t = target->applied;
      if (c.relative) {
        const BoneData& s = *target->data;
        p.rotation += (wrapDeg(t.rotation - s.rotation) + c.offsetRotation) * mr;
        p.x += (t.x - s.x + c.offsetX) * mt;
        p.y += (t.y - s.y + c.offsetY) * mt;
        p.scaleX *= 1 + ((s.scaleX != 0 && !std::isnan(s.scaleX) ? t.scaleX / s.scaleX : 1) - 1 + offScaleX) * ms;
        p.scaleY *= 1 + ((s.scaleY != 0 && !std::isnan(s.scaleY) ? t.scaleY / s.scaleY : 1) - 1 + offScaleY) * ms;
        p.shearY += (t.shearY - s.shearY + offShear) * mh;
      } else {
        p.rotation += wrapDeg(t.rotation + c.offsetRotation - p.rotation) * mr;
        p.x += (t.x + c.offsetX - p.x) * mt;
        p.y += (t.y + c.offsetY - p.y) * mt;
        p.scaleX += (t.scaleX + offScaleX - p.scaleX) * ms;
        p.scaleY += (t.scaleY + offScaleY - p.scaleY) * ms;
        p.shearY += (t.shearY + offShear - p.shearY) * mh;
      }
      b.updateSubtree(root, true);
      continue;
    }
    Affine& w = b.world;
    const Affine t = target->world;
    if (c.relative) {
      const Affine s = setupWorldOf(target->data->id);
      if (mr > 0) rotateAxes(w, (wrapDeg(openbone::worldRotation(t) - openbone::worldRotation(s)) + c.offsetRotation) * mr * DEG);
      if (mt > 0) {
        w.x += (t.x - s.x + c.offsetX) * mt;
        w.y += (t.y - s.y + c.offsetY) * mt;
      }
      if (ms > 0) {
        const double kx = 1 + (worldScaleX(t) / orNum(worldScaleX(s), 1) - 1 + offScaleX) * ms;
        const double ky = 1 + (worldScaleY(t) / orNum(worldScaleY(s), 1) - 1 + offScaleY) * ms;
        w.a *= kx;
        w.c *= kx;
        w.b *= ky;
        w.d *= ky;
      }
      if (mh > 0) setSkew(w, skewOf(w) + (wrapDeg(skewOf(t) - skewOf(s)) + offShear) * mh);
    } else {
      if (mr > 0) rotateAxes(w, wrapDeg(openbone::worldRotation(t) + c.offsetRotation - openbone::worldRotation(w)) * mr * DEG);
      if (mt > 0) {
        double ox, oy;
        applyAffine(t, c.offsetX, c.offsetY, ox, oy);
        w.x += (ox - w.x) * mt;
        w.y += (oy - w.y) * mt;
      }
      if (ms > 0) {
        const double sx = orNum(worldScaleX(w), 1), sy = orNum(worldScaleY(w), 1);
        const double kx = (sx + (worldScaleX(t) + offScaleX - sx) * ms) / sx;
        const double ky = (sy + (worldScaleY(t) + offScaleY - sy) * ms) / sy;
        w.a *= kx;
        w.c *= kx;
        w.b *= ky;
        w.d *= ky;
      }
      if (mh > 0) {
        const double sb = skewOf(w);
        setSkew(w, sb + wrapDeg(skewOf(t) + offShear - sb) * mh);
      }
    }
    b.syncApplied(root);
    b.updateSubtree(root, false);
  }
}

// ---------------- Path ----------------

void Skeleton::applyPath(const PathConstraintData& c, ConstraintValues& v) {
  const double mixRotate = v.get(CProp::MixRotate, NAN), mixX = v.get(CProp::MixX, NAN), mixY = v.get(CProp::MixY, NAN);
  if (mixRotate <= 0 && mixX <= 0 && mixY <= 0) return;
  Slot* slot = slotById(c.target);
  if (!slot) return;
  const Attachment* att = getAttachment(*slot);
  if (!att || att->type != AttachmentType::Path) return;
  const Spline spline(attachmentWorldVertices(*slot, *att), att->closed);
  const double total = spline.length;
  if (total <= 1e-9) return;
  std::vector<Bone*> bs;
  for (const auto& id : c.bones)
    if (Bone* b = boneById(id)) bs.push_back(b);
  const size_t n = bs.size();
  if (!n) return;
  std::vector<double> lengths(n);
  double sumLen = 0;
  for (size_t i = 0; i < n; i++) {
    lengths[i] = bs[i]->data->length * worldScaleX(bs[i]->world);
    sumLen += lengths[i];
  }
  const double position = v.get(CProp::Position, NAN), spacing = v.get(CProp::Spacing, NAN);
  std::vector<double> dist(n + 1);
  dist[0] = c.positionMode == PositionMode::Percent ? position * total : position;
  for (size_t i = 0; i < n; i++) {
    double gap;
    switch (c.spacingMode) {
      case SpacingMode::Fixed: gap = spacing; break;
      case SpacingMode::Percent: gap = spacing * total; break;
      case SpacingMode::Proportional: gap = spacing * total * (sumLen > 0 ? lengths[i] / sumLen : 1.0 / n); break;
      default: gap = lengths[i] + spacing;
    }
    dist[i + 1] = dist[i] + gap;
  }
  std::vector<PathSample> pts(n + 1);
  for (size_t i = 0; i <= n; i++) pts[i] = spline.sample(dist[i]);
  const Affine root = rootMatrix();
  const double off = c.offsetRotation * DEG;
  for (size_t i = 0; i < n; i++) {
    Bone& b = *bs[i];
    Affine& w = b.world;
    const PathSample& p = pts[i];
    w.x += (p.x - w.x) * mixX;
    w.y += (p.y - w.y) * mixY;
    if (mixRotate > 0) {
      double ang = p.angle;
      if (c.rotateMode != RotateMode::Tangent) {
        const PathSample& q = pts[i + 1];
        const double dx = q.x - w.x, dy = q.y - w.y;
        const double d = jsHypot(dx, dy);
        if (d > 1e-6) {
          ang = std::atan2(dy, dx);
          if (c.rotateMode == RotateMode::ChainScale && lengths[i] > 1e-6) {
            const double k = 1 + (d / lengths[i] - 1) * mixRotate;
            w.a *= k;
            w.c *= k;
          }
        }
      }
      rotateAxes(w, wrapDeg((ang + off) * RAD - openbone::worldRotation(w)) * mixRotate * DEG);
      b.syncApplied(root);
    }
    b.updateSubtree(root, false);
  }
}

// ---------------- Physics ----------------

void Skeleton::applyPhysics(const PhysicsConstraintData& c, ConstraintValues& v, double dt) {
  Bone* bp = boneById(c.bone);
  if (!bp) return;
  Bone& b = *bp;
  Affine& w = b.world;
  const double len = b.data->length > 1e-6 ? b.data->length : 1;
  const double ox = w.x, oy = w.y;
  double tx, ty;
  applyAffine(w, len, 0, tx, ty);
  auto it = physicsState.find(c.id);
  if (it == physicsState.end()) {
    auto st = std::make_unique<PhysicsState>();
    st->origin = {ox, oy, 0, 0, ox, oy};
    st->tip = {tx, ty, 0, 0, tx, ty};
    st->lastO[0] = ox;
    st->lastO[1] = oy;
    st->lastT[0] = tx;
    st->lastT[1] = ty;
    it = physicsState.emplace(c.id, std::move(st)).first;
  }
  PhysicsState& st = *it->second;
  const double carry = 1 - std::min(1.0, std::max(0.0, v.get(CProp::Inertia, NAN)));
  auto shift = [](PhysParticle& p, double dx, double dy) {
    p.x += dx;
    p.y += dy;
    p.px += dx;
    p.py += dy;
  };
  shift(st.origin, (ox - st.lastO[0]) * carry, (oy - st.lastO[1]) * carry);
  shift(st.tip, (tx - st.lastT[0]) * carry, (ty - st.lastT[1]) * carry);
  st.lastO[0] = ox;
  st.lastO[1] = oy;
  st.lastT[0] = tx;
  st.lastT[1] = ty;
  const double h = 1 / std::max(1.0, orNum(c.fps, 60));
  st.time += dt;
  const double due = std::floor(st.time / h + 1e-6);
  if (due - st.steps > MAX_PHYSICS_STEPS) st.steps = due - MAX_PHYSICS_STEPS;
  const double k = std::min(std::max(0.0, v.get(CProp::Strength, NAN)) / std::max(1e-6, v.get(CProp::Mass, NAN)), 1 / (h * h));
  const double decay = std::exp(-std::max(0.0, v.get(CProp::Damping, NAN)) * h);
  const double wind = v.get(CProp::Wind, NAN) * unitScaleX();
  const double gravity = v.get(CProp::Gravity, NAN) * unitScaleY();
  auto step = [&](PhysParticle& p, double gx, double gy) {
    p.px = p.x;
    p.py = p.y;
    p.vx = (p.vx + ((gx - p.x) * k + wind) * h) * decay;
    p.vy = (p.vy + ((gy - p.y) * k - gravity) * h) * decay;
    p.x += p.vx * h;
    p.y += p.vy * h;
  };
  for (; st.steps < due; st.steps++) {
    step(st.origin, ox, oy);
    step(st.tip, tx, ty);
  }
  const double mix = std::min(1.0, std::max(0.0, v.get(CProp::Mix, NAN)));
  if (mix <= 0) return;
  const double f = std::min(1.0, std::max(0.0, st.time / h - st.steps));
  const double sox = st.origin.px + (st.origin.x - st.origin.px) * f, soy = st.origin.py + (st.origin.y - st.origin.py) * f;
  const double stx = st.tip.px + (st.tip.x - st.tip.px) * f, sty = st.tip.py + (st.tip.y - st.tip.py) * f;
  w.x = ox + (sox - ox) * c.x * mix;
  w.y = oy + (soy - oy) * c.y * mix;
  if (c.rotate > 0 || c.scaleX > 0) {
    const double dx = stx - w.x, dy = sty - w.y;
    const double d = jsHypot(dx, dy);
    if (d > 1e-9) {
      const double base = std::atan2(ty - oy, tx - ox);
      rotateAxes(w, wrapDeg((std::atan2(dy, dx) - base) * RAD) * c.rotate * mix * DEG);
      if (c.scaleX > 0 && b.data->length > 1e-6) {
        const double rest = orNum(jsHypot(tx - ox, ty - oy), len);
        const double s = 1 + (d / rest - 1) * c.scaleX * mix;
        w.a *= s;
        w.c *= s;
      }
    }
  }
  const Affine root = rootMatrix();
  b.syncApplied(root);
  b.updateSubtree(root, false);
}

// ---------------- Attachments ----------------

const Attachment* Skeleton::getAttachment(const Slot& slot) const { return getAttachment(slot, slot.attachmentName); }

const Attachment* Skeleton::getAttachment(const Slot& slot, const std::optional<std::string>& name) const {
  if (!name) return nullptr;
  const Id& id = slot.data->id;
  if (skin) {
    auto it = skin->attachments.find(id);
    if (it != skin->attachments.end())
      if (const Attachment* a = it->second.find(*name)) return a;
  }
  if (doc.skeleton.skins.empty()) return nullptr;
  const SkinData& def = doc.skeleton.skins[0];
  auto it = def.attachments.find(id);
  if (it != def.attachments.end()) return it->second.find(*name);
  return nullptr;
}

double Skeleton::sequenceCounter(const Slot& slot, const Attachment& att) const {
  auto k = slot.sequenceFrames.find(att.name);
  if (k != slot.sequenceFrames.end()) return std::floor(k->second + 1e-6) + att.offset;
  if (att.input && !att.input->empty()) {
    auto it = inputValues.find(*att.input);
    if (it != inputValues.end()) return std::floor(it->second + 1e-6) + att.offset;
    auto d = inputDefaults.find(*att.input);
    if (d != inputDefaults.end()) return std::floor(d->second + 1e-6) + att.offset;
  }
  const double time = animationTime ? *animationTime : clock;
  return std::floor(time * att.fps + 1e-6) + att.offset;
}

int Skeleton::sequenceFrame(const Slot& slot, const Attachment& att) const {
  return sequenceFrameIndex((int)att.frames.size(), att.mode, sequenceCounter(slot, att));
}

std::vector<float> Skeleton::attachmentWorldVertices(const Slot& slot, const Attachment& att) const {
  const Affine& m = slot.bone->world;
  if (att.type == AttachmentType::Region || att.type == AttachmentType::Sequence || att.type == AttachmentType::Text) {
    const bool text = att.type == AttachmentType::Text;
    const double hw = (att.width / 2) * (text ? 1 : att.scaleX);
    const double hh = (att.height / 2) * (text ? 1 : att.scaleY);
    const double cos = std::cos(att.rotation * DEG), sin = std::sin(att.rotation * DEG);
    double corners[8] = {-hw, hh, hw, hh, hw, -hh, -hw, -hh};
    const double kx = !text && att.skewX != 0 ? std::tan(att.skewX * DEG) : 0;
    const double ky = !text && att.skewY != 0 ? std::tan(att.skewY * DEG) : 0;
    if (kx != 0 || ky != 0)
      for (int i = 0; i < 8; i += 2) {
        const double x = corners[i], y = corners[i + 1];
        corners[i] = x + kx * y;
        corners[i + 1] = y + ky * x;
      }
    std::vector<float> out(8);
    for (int i = 0; i < 8; i += 2) {
      const double lx = att.x + corners[i] * cos - corners[i + 1] * sin;
      const double ly = att.y + corners[i] * sin + corners[i + 1] * cos;
      out[i] = float(m.a * lx + m.b * ly + m.x);
      out[i + 1] = float(m.c * lx + m.d * ly + m.y);
    }
    return out;
  }
  if (att.type == AttachmentType::Mesh || att.type == AttachmentType::Path) {
    const size_t n = att.vertices.size() / 2;
    const std::vector<double>* deform = nullptr;
    if (att.type == AttachmentType::Mesh && att.linkedDeform) {
      auto it = slot.deform.find(att.linkedMesh);
      if (it != slot.deform.end()) deform = &it->second;
    }
    if (!deform) {
      auto it = slot.deform.find(att.name);
      if (it != slot.deform.end()) deform = &it->second;
    }
    auto def = [&](size_t i) { return deform && i < deform->size() ? (*deform)[i] : 0.0; };
    std::vector<float> out(n * 2);
    if (att.weighted) {
      for (size_t v = 0; v < n; v++) {
        double wx = 0, wy = 0;
        const double dx = def(v * 2), dy = def(v * 2 + 1);
        if (v < att.weights.size())
          for (const auto& inf : att.weights[v]) {
            Bone* bb = boneById(inf.bone);
            const Affine& bm = bb ? bb->world : m;
            const double lx = inf.x + dx, ly = inf.y + dy;
            wx += (bm.a * lx + bm.b * ly + bm.x) * inf.weight;
            wy += (bm.c * lx + bm.d * ly + bm.y) * inf.weight;
          }
        out[v * 2] = float(wx);
        out[v * 2 + 1] = float(wy);
      }
    } else {
      for (size_t v = 0; v < n; v++) {
        const double lx = att.vertices[v * 2] + def(v * 2);
        const double ly = att.vertices[v * 2 + 1] + def(v * 2 + 1);
        out[v * 2] = float(m.a * lx + m.b * ly + m.x);
        out[v * 2 + 1] = float(m.c * lx + m.d * ly + m.y);
      }
    }
    return out;
  }
  std::vector<double> local;
  if (att.type == AttachmentType::Shape) local = shapeOutline(att);
  else if (att.type == AttachmentType::BoundingBox || att.type == AttachmentType::Clipping) local = att.vertices;
  else local = {att.x, att.y};
  std::vector<float> out(local.size());
  for (size_t i = 0; i + 1 < local.size(); i += 2) {
    out[i] = float(m.a * local[i] + m.b * local[i + 1] + m.x);
    out[i + 1] = float(m.c * local[i] + m.d * local[i + 1] + m.y);
  }
  return out;
}

std::string Skeleton::textContent(const Slot& slot, const Attachment& att) const {
  auto it = textOverrides.find(slot.data->id);
  const std::string& tpl = it != textOverrides.end() ? it->second : att.text;
  if (textValues) return formatTemplate(tpl, textValues);
  return formatTemplate(tpl, [this](const std::string& name) {
    auto d = inputDefaultsByName.find(name);
    return d == inputDefaultsByName.end() ? Value() : d->second;
  });
}

void Skeleton::setText(const std::string& slotRef, const std::optional<std::string>& text) {
  Slot* s = findSlot(slotRef);
  if (!s) throw std::runtime_error("Slot \"" + slotRef + "\" not found");
  if (!text) textOverrides.erase(s->data->id);
  else textOverrides[s->data->id] = *text;
}

const std::vector<uint16_t>& Skeleton::triangulated(const Attachment& att, const std::vector<double>& outline) const {
  auto it = triCache.find(&att);
  if (it != triCache.end()) return it->second;
  std::vector<uint16_t> idx;
  for (uint32_t i : earcut(outline)) idx.push_back(uint16_t(i));
  return triCache.emplace(&att, std::move(idx)).first->second;
}

bool Skeleton::sequenceItem(const Slot& slot, const Attachment& att, int index, DrawItem& out) const {
  if (index < 0 || index >= (int)att.frames.size()) return false;
  const SequenceFrame& frame = att.frames[index];
  auto imIt = images.find(frame.image);
  if (imIt == images.end()) return false;
  const ImageAsset* image = imIt->second;
  const RGBA color = mulColor(slot.color, parseHex(att.color));
  if (color[3] <= 0) return false;
  const double iw = image->width, ih = image->height;
  const double rx = frame.hasRect ? frame.rx : 0, ry = frame.hasRect ? frame.ry : 0, rw = frame.hasRect ? frame.rw : iw,
               rh = frame.hasRect ? frame.rh : ih;
  double u0 = rx / iw, v0 = ry / ih, u1 = (rx + rw) / iw, v1 = (ry + rh) / ih;
  double q0 = 0, p0 = 0, q1 = 1, p1 = 1;
  if (frame.hasTrim) {
    q0 = frame.tx / frame.sourceWidth;
    p0 = frame.ty / frame.sourceHeight;
    q1 = (frame.tx + rw) / frame.sourceWidth;
    p1 = (frame.ty + rh) / frame.sourceHeight;
  }
  auto pIt = packed.find(frame.image);
  const Packed* pk = pIt == packed.end() ? nullptr : pIt->second.get();
  if (pk && pk->trimmed) {
    const double a0 = pk->trim[0], b0 = pk->trim[1], a1 = pk->trim[2], b1 = pk->trim[3];
    const double nu0 = std::max(u0, a0), nv0 = std::max(v0, b0), nu1 = std::min(u1, a1), nv1 = std::min(v1, b1);
    if (nu0 >= nu1 || nv0 >= nv1) return false;
    auto fx = [&](double u) { return q0 + ((u - u0) / (u1 - u0)) * (q1 - q0); };
    auto fy = [&](double v) { return p0 + ((v - v0) / (v1 - v0)) * (p1 - p0); };
    const double nq0 = fx(nu0), np0 = fy(nv0), nq1 = fx(nu1), np1 = fy(nv1);
    q0 = nq0;
    p0 = np0;
    q1 = nq1;
    p1 = np1;
    u0 = nu0;
    v0 = nv0;
    u1 = nu1;
    v1 = nv1;
  }
  std::vector<float> vertices = attachmentWorldVertices(slot, att);
  if (q0 != 0 || p0 != 0 || q1 != 1 || p1 != 1) vertices = trimQuad(vertices, q0, p0, q1, p1);
  const float quadUvs[8] = {float(u0), float(v0), float(u1), float(v0), float(u1), float(v1), float(u0), float(v1)};
  out.slot = &slot;
  out.attachment = &att;
  out.type = "sequence";
  out.image = image;
  if (pk) {
    out.texture = TextureRef{pk->page->id, pk->page->width, pk->page->height, &pk->page->src};
    out.uvs = remapUvsImpl(quadUvs, 8, pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
  } else {
    out.texture = TextureRef{image->id, image->width, image->height, &image->src};
    out.uvs.assign(quadUvs, quadUvs + 8);
  }
  out.vertices = std::move(vertices);
  out.indices.assign(REGION_INDICES, REGION_INDICES + 6);
  out.color = color;
  out.dark = slot.dark;
  out.blend = slot.data->blend;
  return true;
}

bool Skeleton::particleItem(const Slot& slot, const Attachment& att, DrawItem& out) const {
  auto it = emitters.find(slot.data->id);
  if (it == emitters.end() || it->second->data != &att || !it->second->alive()) return false;
  ParticleGeometry geo = it->second->geometry(particleFrac, slot.bone->world, slot.color);
  if (!geo.count) return false;
  out.slot = &slot;
  out.attachment = &att;
  out.type = "particles";
  out.uvs = geo.uvs;
  if (att.look == ParticleLook::Image) {
    const ImageAsset* image = nullptr;
    if (att.hasImage && !att.image.empty()) {
      auto im = images.find(att.image);
      if (im != images.end()) image = im->second;
    }
    out.image = image;
    auto pIt = att.hasImage ? packed.find(att.image) : packed.end();
    if (pIt != packed.end()) {
      const Packed* pk = pIt->second.get();
      out.texture = TextureRef{pk->page->id, pk->page->width, pk->page->height, &pk->page->src};
      out.uvs = remapUvsImpl(geo.uvs.data(), geo.uvs.size(), pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
    } else if (image)
      out.texture = TextureRef{image->id, image->width, image->height, &image->src};
    if (!out.texture) return false;
  } else if (att.look == ParticleLook::Square) {
    if (hasWhite) {
      out.texture = TextureRef{whitePage->id, whitePage->width, whitePage->height, &whitePage->src};
      out.uvs = fill2(geo.uvs.size(), whiteU, whiteV);
    }
  } else
    out.texture = TextureRef{PARTICLE_DOT_TEXTURE, PARTICLE_DOT_SIZE, PARTICLE_DOT_SIZE, nullptr};
  out.vertices = std::move(geo.vertices);
  out.indices = std::move(geo.indices);
  out.color = slot.color;
  out.colors = std::move(geo.colors);
  out.blend = att.blend;
  out.isParticles = true;
  out.look = att.look;
  out.particleCount = geo.count;
  return true;
}

DrawList Skeleton::drawList() const {
  DrawList list;
  auto& items = list.items;
  int clip = -1;
  std::optional<Id> clipEnd;
  for (Slot* sp : drawOrder) {
    const Slot& slot = *sp;
    const Attachment* att = slot.bone->active ? getAttachment(slot) : nullptr;
    const size_t first = items.size();
    if (att) {
      switch (att->type) {
        case AttachmentType::Clipping: {
          if (clip < 0 && att->vertices.size() >= 6) {
            ClipRegion cr;
            cr.slot = &slot;
            cr.polygon = attachmentWorldVertices(slot, *att);
            cr.indices = triangulated(*att, att->vertices);
            list.clips.push_back(std::move(cr));
            clip = (int)list.clips.size() - 1;
            clipEnd = att->end;
          }
          break;
        }
        case AttachmentType::Region:
        case AttachmentType::Mesh: {
          auto im = images.find(att->image);
          const ImageAsset* image = im == images.end() ? nullptr : im->second;
          const RGBA color = mulColor(slot.color, parseHex(att->color));
          if (color[3] <= 0) break;
          DrawItem it;
          std::vector<float> vertices = attachmentWorldVertices(slot, *att);
          auto pIt = packed.find(att->image);
          const Packed* pk = pIt == packed.end() ? nullptr : pIt->second.get();
          if (att->type == AttachmentType::Region) {
            it.type = "region";
            if (pk) it.uvs = pk->regionUvs;
            else it.uvs.assign(REGION_UVS, REGION_UVS + 8);
            it.indices.assign(REGION_INDICES, REGION_INDICES + 6);
            if (pk && pk->hasPoly) {
              vertices = quadPoints(vertices, pk->polyImage);
              it.uvs = pk->polyUvs;
              it.indices = pk->polyIndices;
            } else if (pk && pk->trimmed)
              vertices = trimQuad(vertices, pk->trim[0], pk->trim[1], pk->trim[2], pk->trim[3]);
          } else {
            it.type = "mesh";
            if (pk) it.uvs = remapUvsImpl(att->uvs.data(), att->uvs.size(), pk->ou, pk->ov, pk->su, pk->sv, pk->rotated);
            else {
              it.uvs.resize(att->uvs.size());
              for (size_t i = 0; i < att->uvs.size(); i++) it.uvs[i] = float(att->uvs[i]);
            }
            it.indices = att->triangles;
          }
          it.slot = &slot;
          it.attachment = att;
          it.image = image;
          if (pk) it.texture = TextureRef{pk->page->id, pk->page->width, pk->page->height, &pk->page->src};
          else if (image) it.texture = TextureRef{image->id, image->width, image->height, &image->src};
          it.vertices = std::move(vertices);
          it.color = color;
          it.dark = slot.dark;
          it.blend = slot.data->blend;
          items.push_back(std::move(it));
          break;
        }
        case AttachmentType::Sequence: {
          DrawItem it;
          if (sequenceItem(slot, *att, sequenceFrame(slot, *att), it)) items.push_back(std::move(it));
          break;
        }
        case AttachmentType::Particles: {
          DrawItem it;
          if (particleItem(slot, *att, it)) items.push_back(std::move(it));
          break;
        }
        case AttachmentType::Text: {
          const RGBA color = slot.color;
          if (color[3] <= 0) break;
          DrawItem it;
          it.slot = &slot;
          it.attachment = att;
          it.type = "text";
          it.vertices = attachmentWorldVertices(slot, *att);
          it.uvs.assign(REGION_UVS, REGION_UVS + 8);
          it.indices.assign(REGION_INDICES, REGION_INDICES + 6);
          it.color = color;
          it.blend = slot.data->blend;
          TextDraw td;
          td.content = textContent(slot, *att);
          td.font = att->font;
          td.size = att->size;
          td.weight = att->weight;
          td.align = att->align;
          td.width = att->width;
          td.height = att->height;
          td.fill = parseHex(att->color);
          if (att->outline && !att->outline->empty() && att->outlineWidth != 0) td.outline = parseHex(*att->outline);
          td.outlineWidth = att->outlineWidth;
          const double r = att->rotation * DEG, cs = std::cos(r), sn = std::sin(r);
          td.matrix = multiply(slot.bone->world, Affine{cs, -sn, sn, cs, att->x, att->y});
          it.text = std::move(td);
          items.push_back(std::move(it));
          break;
        }
        case AttachmentType::Shape: {
          std::vector<float> outline = attachmentWorldVertices(slot, *att);
          const std::vector<uint16_t>& idx = triangulated(*att, shapeOutline(*att));
          const RGBA color = mulColor(slot.color, parseHex(att->fill));
          const bool hasStroke = att->stroke && !att->stroke->empty();
          if (color[3] <= 0 && !(hasStroke && att->strokeWidth > 0 && mulColor(slot.color, parseHex(*att->stroke))[3] > 0)) break;
          DrawItem it;
          it.slot = &slot;
          it.attachment = att;
          it.type = "shape";
          if (hasWhite) {
            it.texture = TextureRef{whitePage->id, whitePage->width, whitePage->height, &whitePage->src};
            it.uvs = fill2(outline.size(), whiteU, whiteV);
          } else
            it.uvs.assign(outline.size(), 0.0f);
          it.indices = idx;
          it.color = color;
          it.blend = slot.data->blend;
          if (hasStroke && att->strokeWidth != 0) {
            it.hasStroke = true;
            it.strokeColor = mulColor(slot.color, parseHex(*att->stroke));
            it.strokeWidth = att->strokeWidth;
          }
          it.vertices = std::move(outline);
          items.push_back(std::move(it));
          break;
        }
        default: break;
      }
    }
    if (clip >= 0 && list.clips[clip].slot != &slot)
      for (size_t i = first; i < items.size(); i++) items[i].clip = clip;
    if (clip >= 0 && clipEnd && slot.data->id == *clipEnd) {
      clip = -1;
      clipEnd.reset();
    }
  }
  return list;
}

std::vector<float> Skeleton::hitPolygon(const Slot& slot) const {
  const Attachment* att = getAttachment(slot);
  if (!att || att->type != AttachmentType::BoundingBox) {
    // {...default[slot], ...skin[slot]} in JS key order, first bounding box wins.
    std::vector<std::pair<std::string, const Attachment*>> merged;
    auto add = [&](const SkinData* s) {
      if (!s) return;
      auto it = s->attachments.find(slot.data->id);
      if (it == s->attachments.end()) return;
      const SlotAttachments& sa = it->second;
      for (size_t i = 0; i < sa.list.size(); i++) {
        const std::string& key = sa.keys[i];
        bool replaced = false;
        for (auto& m : merged)
          if (m.first == key) {
            m.second = sa.list[i].get();
            replaced = true;
          }
        if (!replaced) merged.push_back({key, sa.list[i].get()});
      }
    };
    if (!doc.skeleton.skins.empty()) add(&doc.skeleton.skins[0]);
    add(skin);
    // Integer-like keys first (ascending), the rest in insertion order.
    auto isIndex = [](const std::string& k, uint64_t& n) {
      if (k.empty() || k.size() > 10 || (k.size() > 1 && k[0] == '0')) return false;
      n = 0;
      for (char c : k) {
        if (c < '0' || c > '9') return false;
        n = n * 10 + (c - '0');
      }
      return n < 4294967295ull;
    };
    std::vector<std::pair<uint64_t, const Attachment*>> ints;
    std::vector<const Attachment*> rest;
    for (auto& m : merged) {
      uint64_t n;
      if (isIndex(m.first, n)) ints.push_back({n, m.second});
      else rest.push_back(m.second);
    }
    std::stable_sort(ints.begin(), ints.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    const Attachment* bbox = nullptr;
    for (auto& p : ints)
      if (!bbox && p.second->type == AttachmentType::BoundingBox) bbox = p.second;
    for (auto* a : rest)
      if (!bbox && a->type == AttachmentType::BoundingBox) bbox = a;
    if (bbox) att = bbox;
  }
  if (!att) return {};
  switch (att->type) {
    case AttachmentType::BoundingBox:
    case AttachmentType::Shape:
    case AttachmentType::Clipping:
    case AttachmentType::Region:
    case AttachmentType::Sequence:
    case AttachmentType::Text: return attachmentWorldVertices(slot, *att);
    case AttachmentType::Mesh: {
      std::vector<float> v = attachmentWorldVertices(slot, *att);
      v.resize(std::min(v.size(), size_t(std::max(0, att->hull)) * 2));
      return v;
    }
    default: return {};
  }
}

bool Skeleton::hitTest(const Slot& slot, double x, double y) const {
  if (!slot.bone->active) return false;
  const std::vector<float> poly = hitPolygon(slot);
  return !poly.empty() && pointInPolygon(x, y, poly);
}

std::array<double, 4> Skeleton::bounds() const {
  double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
  auto add = [&](double x, double y) {
    minX = std::min(minX, x);
    minY = std::min(minY, y);
    maxX = std::max(maxX, x);
    maxY = std::max(maxY, y);
  };
  for (const auto& it : drawList().items)
    for (size_t i = 0; i + 1 < it.vertices.size(); i += 2) add(it.vertices[i], it.vertices[i + 1]);
  for (const auto& b : bones) {
    add(b->world.x, b->world.y);
    double ex, ey;
    applyAffine(b->world, b->data->length, 0, ex, ey);
    add(ex, ey);
  }
  return {minX, minY, maxX, maxY};
}

}  // namespace openbone
