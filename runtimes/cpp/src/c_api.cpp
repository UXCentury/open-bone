// C API (include/openbone.h) over the C++ runtime.
// SPDX-License-Identifier: MIT
#include "exact_math.h"  // first: no FMA contraction (bit-exact results)

#include "openbone.h"

#include <cstring>
#include <deque>
#include <stdexcept>

#include "internal.hpp"

using namespace openbone;

struct ob_document {
  std::shared_ptr<const Document> doc;
};

struct ob_instance {
  std::shared_ptr<const Document> doc;
  std::unique_ptr<Instance> inst;
  DrawList draw;
  ob_event_fn eventFn = nullptr;
  void* eventUser = nullptr;
  ob_audio_fn audioFn = nullptr;
  void* audioUser = nullptr;
  ob_state_fn stateFn = nullptr;
  void* stateUser = nullptr;
  ob_log_fn logFn = nullptr;
  void* logUser = nullptr;
  std::string scratch;
  std::vector<std::pair<std::string, std::optional<std::string>>> states;
  void wireMachine() {
    if (!inst->stateMachine) return;
    inst->stateMachine->onLog = [this](const std::string& m) {
      if (logFn) logFn(logUser, m.c_str(), 0);
    };
    inst->stateMachine->onError = [this](const std::string& m) {
      if (logFn) logFn(logUser, m.c_str(), 1);
    };
  }
};

struct ob_bounds {
  std::shared_ptr<const Document> doc;  // keeps the slot / attachment names alive
  SkeletonBounds bounds;
};

namespace {
thread_local std::string lastError;

int fail(const std::string& msg) {
  lastError = msg;
  return 0;
}

template <class F>
int guard(F&& f) {
  try {
    lastError.clear();
    return f();
  } catch (const std::exception& e) {
    return fail(e.what());
  } catch (...) {
    return fail("unknown error");
  }
}

void color4(float* out, const RGBA& c) {
  for (int i = 0; i < 4; i++) out[i] = float(c[i]);
}

ob_item_kind kindOf(const DrawItem& it) {
  const std::string t = it.type;
  if (t == "mesh") return OB_ITEM_MESH;
  if (t == "sequence") return OB_ITEM_SEQUENCE;
  if (t == "shape") return OB_ITEM_SHAPE;
  if (t == "text") return OB_ITEM_TEXT;
  if (t == "particles") return OB_ITEM_PARTICLES;
  return OB_ITEM_REGION;
}

/** Writes up to `capacity` indices (out may be NULL) and returns the full count. */
int copyIndices(const std::vector<int>& list, int* out, int capacity) {
  for (int k = 0; out && k < capacity && k < (int)list.size(); k++) out[k] = list[k];
  return (int)list.size();
}
}  // namespace

extern "C" {

int ob_api_version(void) { return OB_API_VERSION; }
const char* ob_version(void) { return "0.4.2"; }
const char* ob_last_error(void) { return lastError.c_str(); }
int ob_has_scripts(void) { return createQuickJsHost() ? 1 : 0; }

ob_document* ob_document_load_file(const char* path) {
  try {
    lastError.clear();
    if (!path) throw std::runtime_error("path is NULL");
    return new ob_document{loadFile(path)};
  } catch (const std::exception& e) {
    lastError = e.what();
    return nullptr;
  }
}

ob_document* ob_document_load_memory(const void* data, size_t size) {
  try {
    lastError.clear();
    if (!data) throw std::runtime_error("data is NULL");
    return new ob_document{loadDocument(static_cast<const uint8_t*>(data), size)};
  } catch (const std::exception& e) {
    lastError = e.what();
    return nullptr;
  }
}

void ob_document_free(ob_document* doc) { delete doc; }

void ob_document_size(const ob_document* d, double* w, double* h, double* ox, double* oy) {
  if (!d) return;
  if (w) *w = d->doc->width;
  if (h) *h = d->doc->height;
  if (ox) *ox = d->doc->originX;
  if (oy) *oy = d->doc->originY;
}

int ob_document_animation_count(const ob_document* d) { return d ? (int)d->doc->animations.size() : 0; }
const char* ob_document_animation_name(const ob_document* d, int i) {
  return d && i >= 0 && i < (int)d->doc->animations.size() ? d->doc->animations[i].name.c_str() : nullptr;
}
double ob_document_animation_duration(const ob_document* d, int i) {
  return d && i >= 0 && i < (int)d->doc->animations.size() ? d->doc->animations[i].computedDuration : 0;
}
int ob_document_audio_asset_count(const ob_document* d) { return d && d->doc->audio ? (int)d->doc->audio->assets.size() : 0; }
int ob_document_audio_asset(const ob_document* d, int i, ob_audio_asset* out) {
  if (!out || i < 0 || i >= ob_document_audio_asset_count(d)) return 0;
  const auto& a = d->doc->audio->assets[i];
  *out = {a.id.c_str(), a.name.c_str(), a.src.c_str(), a.duration};
  return 1;
}
int ob_document_audio_bus_count(const ob_document* d) { return d && d->doc->audio ? (int)d->doc->audio->buses.size() : 0; }
int ob_document_audio_bus(const ob_document* d, int i, ob_audio_bus* out) {
  if (!out || i < 0 || i >= ob_document_audio_bus_count(d)) return 0;
  const auto& b = d->doc->audio->buses[i];
  *out = {b.id.c_str(), b.name.c_str(), b.volume, b.muted ? 1 : 0};
  return 1;
}
int ob_document_font_count(const ob_document* d) { return d ? (int)d->doc->fonts.size() : 0; }
int ob_document_font(const ob_document* d, int i, ob_font_asset* out) {
  if (!out || i < 0 || i >= ob_document_font_count(d)) return 0;
  const auto& f = d->doc->fonts[i];
  *out = {f.id.c_str(), f.name.c_str(), f.family.c_str(), f.src.c_str(), f.weight, f.style.c_str()};
  return 1;
}
double ob_document_audio_master(const ob_document* d) {
  if (!d || !d->doc->audio) return 1;
  return d->doc->audio->muted ? 0 : d->doc->audio->master;
}
int ob_document_skin_count(const ob_document* d) { return d ? (int)d->doc->skeleton.skins.size() : 0; }
const char* ob_document_skin_name(const ob_document* d, int i) {
  return d && i >= 0 && i < (int)d->doc->skeleton.skins.size() ? d->doc->skeleton.skins[i].name.c_str() : nullptr;
}
int ob_document_state_machine_count(const ob_document* d) { return d ? (int)d->doc->stateMachines.size() : 0; }
const char* ob_document_state_machine_name(const ob_document* d, int i) {
  return d && i >= 0 && i < (int)d->doc->stateMachines.size() ? d->doc->stateMachines[i].name.c_str() : nullptr;
}
int ob_document_input_count(const ob_document* d, int sm) {
  return d && sm >= 0 && sm < (int)d->doc->stateMachines.size() ? (int)d->doc->stateMachines[sm].inputs.size() : 0;
}
int ob_document_input(const ob_document* d, int sm, int i, const char** name, ob_value* def, int* isTrigger) {
  if (!d || sm < 0 || sm >= (int)d->doc->stateMachines.size()) return fail("no such state machine");
  const auto& ins = d->doc->stateMachines[sm].inputs;
  if (i < 0 || i >= (int)ins.size()) return fail("no such input");
  const InputData& in = ins[i];
  if (name) *name = in.name.c_str();
  if (isTrigger) *isTrigger = in.type == InputType::Trigger;
  if (def) {
    *def = ob_value{};
    const Value& v = in.defaultValue;
    if (in.type == InputType::Trigger) def->type = OB_VALUE_BOOL;
    else if (v.isBool()) def->type = OB_VALUE_BOOL, def->b = v.b;
    else if (v.isNumber()) def->type = OB_VALUE_NUMBER, def->n = v.n;
    else if (v.isString()) def->type = OB_VALUE_STRING, def->s = v.s.c_str();
  }
  return 1;
}

int ob_document_texture_count(const ob_document* d) {
  if (!d) return 0;
  return int((d->doc->atlas ? d->doc->atlas->pages.size() : 0) + d->doc->images.size());
}
int ob_document_texture(const ob_document* d, int i, ob_texture_info* out) {
  if (!d || !out || i < 0) return fail("bad arguments");
  const int pages = d->doc->atlas ? (int)d->doc->atlas->pages.size() : 0;
  if (i < pages) {
    const AtlasPage& p = d->doc->atlas->pages[i];
    *out = {p.id.c_str(), p.name.c_str(), p.src.c_str(), p.width, p.height, 1, d->doc->atlas->premultipliedAlpha ? 1 : 0};
    return 1;
  }
  i -= pages;
  if (i >= (int)d->doc->images.size()) return fail("no such texture");
  const ImageAsset& im = d->doc->images[i];
  *out = {im.id.c_str(), im.name.c_str(), im.src.c_str(), im.width, im.height, 0, 0};
  return 1;
}

ob_instance* ob_instance_create(ob_document* d, int flags) {
  try {
    lastError.clear();
    if (!d) throw std::runtime_error("document is NULL");
    auto* o = new ob_instance();
    o->doc = d->doc;
    o->inst = std::make_unique<Instance>(d->doc, (flags & OB_INSTANCE_SCRIPTS) ? createQuickJsHost() : nullptr);
    o->inst->onEvent = [o](const FiredEvent& e) {
      if (!o->eventFn) return;
      ob_event ev{e.name.c_str(), e.id.c_str(), e.time, e.intValue, e.floatValue, e.stringValue.c_str(), e.animation.c_str(),
                  e.audio ? e.audio->c_str() : nullptr};
      o->eventFn(o->eventUser, &ev);
    };
    o->inst->onAudio = [o](const AudioCommand& c) {
      if (!o->audioFn) return;
      ob_audio_command ac{};
      ac.type = c.type == AudioCommand::Type::Play   ? OB_AUDIO_PLAY
                : c.type == AudioCommand::Type::Stop ? OB_AUDIO_STOP
                : c.type == AudioCommand::Type::Mix  ? OB_AUDIO_MIX
                                                     : OB_AUDIO_FADE;
      ac.id = c.id.c_str();
      ac.sound = c.sound.c_str();
      ac.asset = c.asset.c_str();
      ac.bus = c.bus ? c.bus->c_str() : nullptr;
      ac.volume = c.volume;
      ac.rate = c.rate;
      ac.fade_in = c.fadeIn;
      ac.loop = c.loop;
      ac.source = c.source.c_str();
      ac.fade = c.fade;
      ac.duration = c.duration;
      ac.muted = c.muted ? 1 : 0;
      o->audioFn(o->audioUser, &ac);
    };
    o->inst->onStateChange = [o](const std::string& layer, const std::string* from, const std::string& to) {
      if (o->stateFn) o->stateFn(o->stateUser, layer.c_str(), from ? from->c_str() : nullptr, to.c_str());
    };
    return o;
  } catch (const std::exception& e) {
    lastError = e.what();
    return nullptr;
  }
}

void ob_instance_free(ob_instance* o) {
  if (!o) return;
  o->eventFn = nullptr;
  o->audioFn = nullptr;
  o->inst->dispose();
  delete o;
}

int ob_instance_set_skin(ob_instance* o, const char* skin) {
  if (!o) return fail("instance is NULL");
  return guard([&] {
    if (skin && *skin) {
      bool found = false;
      for (const auto& s : o->doc->skeleton.skins)
        if (s.name == skin || s.id == skin) found = true;
      if (!found) return fail(std::string("Skin \"") + skin + "\" not found");
      o->inst->skeleton->setSkin(std::string(skin));
    } else
      o->inst->skeleton->setSkin(nullptr);
    return 1;
  });
}

void ob_instance_set_transform(ob_instance* o, double x, double y, double sx, double sy) {
  if (!o) return;
  Skeleton& sk = *o->inst->skeleton;
  sk.x = x;
  sk.y = y;
  sk.scaleX = sx;
  sk.scaleY = sy;
}

int ob_instance_play(ob_instance* o, const char* anim, int loop, int track) {
  if (!o || !anim) return fail("bad arguments");
  return guard([&] {
    o->inst->play(anim, loop != 0, track);
    return 1;
  });
}

int ob_instance_queue(ob_instance* o, const char* anim, int loop, int track, double delay) {
  if (!o || !anim) return fail("bad arguments");
  return guard([&] {
    if (o->inst->stateMachine) {
      o->inst->stateMachine->dispose();
      o->inst->stateMachine.reset();
    }
    o->inst->animationState->addAnimation(track, anim, loop != 0, delay);
    return 1;
  });
}

void ob_instance_clear_tracks(ob_instance* o) {
  if (o) o->inst->animationState->clearTracks();
}

int ob_instance_use_state_machine(ob_instance* o, const char* name) {
  if (!o) return fail("instance is NULL");
  return guard([&] {
    o->inst->useStateMachine(name ? name : "");
    o->wireMachine();
    return 1;
  });
}

static int setInput(ob_instance* o, const char* input, const Value& v) {
  if (!o || !input) return fail("bad arguments");
  if (!o->inst->stateMachine) return fail("no state machine is running");
  return guard([&] {
    o->inst->stateMachine->setInput(input, v);
    return 1;
  });
}
int ob_instance_set_bool(ob_instance* o, const char* input, int value) { return setInput(o, input, Value::boolean(value != 0)); }
int ob_instance_set_number(ob_instance* o, const char* input, double value) { return setInput(o, input, Value::number(value)); }
int ob_instance_set_string(ob_instance* o, const char* input, const char* value) { return setInput(o, input, Value::string(value ? value : "")); }
int ob_instance_fire(ob_instance* o, const char* trigger) {
  if (!o || !trigger) return fail("bad arguments");
  if (!o->inst->stateMachine) return fail("no state machine is running");
  return guard([&] {
    o->inst->stateMachine->fire(trigger);
    return 1;
  });
}

int ob_instance_set_bus_muted(ob_instance* o, const char* bus, int muted) {
  if (!o) return (fail("bad arguments"), -1);
  try {
    const auto r = o->inst->setBusMuted(bus ? bus : "", muted < 0 ? std::nullopt : std::optional<bool>(muted != 0));
    if (!r) return (fail(std::string("bus \"") + (bus ? bus : "") + "\" not found"), -1);
    return *r ? 1 : 0;
  } catch (const std::exception& e) {
    return (fail(e.what()), -1);
  }
}
int ob_instance_bus_muted(ob_instance* o, const char* bus) {
  if (!o) return (fail("bad arguments"), -1);
  const auto r = o->inst->isBusMuted(bus ? bus : "");
  return r ? (*r ? 1 : 0) : -1;
}

int ob_instance_get_input(ob_instance* o, const char* input, ob_value* out) {
  if (!o || !input || !out) return fail("bad arguments");
  if (!o->inst->stateMachine) return fail("no state machine is running");
  const Value v = o->inst->stateMachine->getInput(input);
  *out = ob_value{};
  if (v.isUndefined()) return fail(std::string("Input \"") + input + "\" not found");
  if (v.isBool()) out->type = OB_VALUE_BOOL, out->b = v.b;
  else if (v.isNumber()) out->type = OB_VALUE_NUMBER, out->n = v.n;
  else if (v.isString()) {
    o->scratch = v.s;
    out->type = OB_VALUE_STRING;
    out->s = o->scratch.c_str();
  }
  return 1;
}

int ob_instance_pointer(ob_instance* o, ob_pointer_type type, double x, double y) {
  if (!o) return fail("instance is NULL");
  if (!o->inst->stateMachine) return fail("no state machine is running");
  const PointerEvent t = type == OB_POINTER_DOWN ? PointerEvent::Down : type == OB_POINTER_UP ? PointerEvent::Up : PointerEvent::Move;
  o->inst->pointer(t, x, y);
  return 1;
}

void ob_artboard_to_skeleton(const ob_document* d, double px, double py, double* x, double* y) {
  if (!d) return;
  if (x) *x = px - d->doc->originX;
  if (y) *y = d->doc->originY - py;
}

int ob_instance_layer_count(const ob_instance* o) {
  return o && o->inst->stateMachine ? (int)o->inst->stateMachine->data.layers.size() : 0;
}

int ob_instance_active_state(const ob_instance* co, int layer, const char** layerName, const char** stateName) {
  auto* o = const_cast<ob_instance*>(co);
  if (!o || !o->inst->stateMachine) return fail("no state machine is running");
  const auto& layers = o->inst->stateMachine->data.layers;
  if (layer < 0 || layer >= (int)layers.size()) return fail("no such layer");
  o->states = o->inst->stateMachine->activeStates();
  const std::string& name = layers[layer].name;
  if (layerName) *layerName = name.c_str();
  if (stateName) {
    *stateName = nullptr;
    for (const auto& s : o->states)
      if (s.first == name && s.second) *stateName = s.second->c_str();
  }
  return 1;
}

int ob_instance_set_text(ob_instance* o, const char* slot, const char* text) {
  if (!o || !slot) return fail("bad arguments");
  return guard([&] {
    o->inst->skeleton->setText(slot, text ? std::optional<std::string>(text) : std::nullopt);
    return 1;
  });
}

void ob_instance_advance(ob_instance* o, double dt) {
  if (!o) return;
  try {
    o->inst->advance(dt);
  } catch (const std::exception& e) {
    lastError = e.what();
  }
}

void ob_instance_set_event_callback(ob_instance* o, ob_event_fn fn, void* user) {
  if (!o) return;
  o->eventFn = fn;
  o->eventUser = user;
}
void ob_instance_set_audio_callback(ob_instance* o, ob_audio_fn fn, void* user) {
  if (!o) return;
  o->audioFn = fn;
  o->audioUser = user;
}
void ob_instance_set_state_callback(ob_instance* o, ob_state_fn fn, void* user) {
  if (!o) return;
  o->stateFn = fn;
  o->stateUser = user;
}
void ob_instance_set_log_callback(ob_instance* o, ob_log_fn fn, void* user) {
  if (!o) return;
  o->logFn = fn;
  o->logUser = user;
  o->wireMachine();
}

int ob_instance_bone_count(const ob_instance* o) { return o ? (int)o->inst->skeleton->bones.size() : 0; }
int ob_instance_bone(const ob_instance* o, int i, ob_bone_info* out) {
  if (!o || !out || i < 0 || i >= (int)o->inst->skeleton->bones.size()) return fail("no such bone");
  const Bone& b = *o->inst->skeleton->bones[i];
  *out = {b.data->name.c_str(), b.parent ? b.parent->data->name.c_str() : nullptr, b.data->length, b.world.a, b.world.b, b.world.c,
          b.world.d, b.world.x, b.world.y, b.active ? 1 : 0};
  return 1;
}
int ob_instance_find_bone(const ob_instance* o, const char* name) {
  if (!o || !name) return -1;
  const auto& bs = o->inst->skeleton->bones;
  for (size_t i = 0; i < bs.size(); i++)
    if (bs[i]->data->name == name || bs[i]->data->id == name) return (int)i;
  return -1;
}

int ob_instance_slot_count(const ob_instance* o) { return o ? (int)o->inst->skeleton->slots.size() : 0; }
int ob_instance_slot(const ob_instance* o, int i, ob_slot_info* out) {
  if (!o || !out || i < 0 || i >= (int)o->inst->skeleton->slots.size()) return fail("no such slot");
  const Slot& s = *o->inst->skeleton->slots[i];
  *out = ob_slot_info{};
  out->name = s.data->name.c_str();
  out->bone = s.bone ? s.bone->data->name.c_str() : nullptr;
  out->attachment = s.attachmentName ? s.attachmentName->c_str() : nullptr;
  color4(out->color, s.color);
  if (s.dark) {
    out->has_dark = 1;
    for (int k = 0; k < 3; k++) out->dark[k] = float((*s.dark)[k]);
  }
  out->blend = (ob_blend)s.data->blend;
  return 1;
}
int ob_instance_find_slot(const ob_instance* o, const char* name) {
  if (!o || !name) return -1;
  const auto& ss = o->inst->skeleton->slots;
  for (size_t i = 0; i < ss.size(); i++)
    if (ss[i]->data->name == name || ss[i]->data->id == name) return (int)i;
  return -1;
}

double ob_particle_dot_alpha(double r) { return particleDotAlpha(r); }

int ob_instance_update_draw_list(ob_instance* o) {
  if (!o) return 0;
  o->draw = o->inst->skeleton->drawList();
  return (int)o->draw.items.size();
}

int ob_instance_draw_item(const ob_instance* o, int i, ob_draw_item* out) {
  if (!o || !out || i < 0 || i >= (int)o->draw.items.size()) return fail("no such draw item");
  const DrawItem& it = o->draw.items[i];
  *out = ob_draw_item{};
  out->slot = it.slot->data->name.c_str();
  out->attachment = it.attachment->name.c_str();
  out->kind = kindOf(it);
  out->blend = (ob_blend)it.blend;
  if (it.texture) {
    out->texture_id = it.texture->id.c_str();
    out->texture_src = it.texture->src ? it.texture->src->c_str() : nullptr;
    out->texture_width = it.texture->width;
    out->texture_height = it.texture->height;
  }
  out->vertices = it.vertices.data();
  out->uvs = it.uvs.data();
  out->vertex_count = (int)it.vertices.size() / 2;
  out->indices = it.indices.data();
  out->index_count = (int)it.indices.size();
  color4(out->color, it.color);
  if (it.dark) {
    out->has_dark = 1;
    for (int k = 0; k < 3; k++) out->dark[k] = float((*it.dark)[k]);
  }
  out->colors = it.isParticles ? it.colors.data() : nullptr;
  out->clip = it.clip;
  if (it.text) {
    const TextDraw& t = *it.text;
    out->text = t.content.c_str();
    out->font = t.font.c_str();
    out->font_size = t.size;
    out->font_weight = t.weight;
    out->text_align = t.align == TextAlign::Left ? 0 : t.align == TextAlign::Right ? 2 : 1;
    out->text_width = t.width;
    out->text_height = t.height;
    color4(out->text_fill, t.fill);
    if (t.outline) {
      out->has_outline = 1;
      color4(out->text_outline, *t.outline);
    }
    out->outline_width = t.outlineWidth;
    const double m[6] = {t.matrix.a, t.matrix.b, t.matrix.c, t.matrix.d, t.matrix.x, t.matrix.y};
    std::memcpy(out->text_matrix, m, sizeof m);
  }
  if (it.hasStroke) {
    out->has_stroke = 1;
    color4(out->stroke_color, it.strokeColor);
    out->stroke_width = it.strokeWidth;
  }
  return 1;
}

int ob_instance_clip_count(const ob_instance* o) { return o ? (int)o->draw.clips.size() : 0; }
int ob_instance_clip(const ob_instance* o, int i, ob_clip* out) {
  if (!o || !out || i < 0 || i >= (int)o->draw.clips.size()) return fail("no such clip");
  const ClipRegion& c = o->draw.clips[i];
  *out = {c.slot->data->name.c_str(), c.polygon.data(), (int)c.polygon.size() / 2, c.indices.data(), (int)c.indices.size()};
  return 1;
}

void ob_instance_bounds(ob_instance* o, double out[4]) {
  if (!o || !out) return;
  const auto b = o->inst->skeleton->bounds();
  for (int i = 0; i < 4; i++) out[i] = b[i];
}

ob_bounds* ob_bounds_create(void) { return new ob_bounds(); }
void ob_bounds_free(ob_bounds* b) { delete b; }

int ob_bounds_update(ob_bounds* b, const ob_instance* o) {
  if (!b || !o) return fail("bounds or instance is NULL");
  lastError.clear();
  b->bounds.update(*o->inst->skeleton);
  b->doc = o->doc;
  return (int)b->bounds.boxes.size();
}

int ob_bounds_count(const ob_bounds* b) { return b ? (int)b->bounds.boxes.size() : 0; }

int ob_bounds_box(const ob_bounds* b, int i, ob_bounding_box* out) {
  if (!b || !out || i < 0 || i >= (int)b->bounds.boxes.size()) return fail("no such bounding box");
  const BoundingBoxPolygon& x = b->bounds.boxes[i];
  *out = {x.slot->name.c_str(), x.attachment->name.c_str(), x.vertices.data(), (int)x.vertices.size() / 2, x.minX, x.minY, x.maxX, x.maxY};
  return 1;
}

int ob_bounds_aabb(const ob_bounds* b, double out[4]) {
  const bool any = b && !b->bounds.boxes.empty();
  if (out) {
    out[0] = any ? b->bounds.minX : 0;
    out[1] = any ? b->bounds.minY : 0;
    out[2] = any ? b->bounds.maxX : 0;
    out[3] = any ? b->bounds.maxY : 0;
  }
  return any ? 1 : 0;
}

int ob_bounds_aabb_contains_point(const ob_bounds* b, double x, double y) { return b && b->bounds.aabbContainsPoint(x, y) ? 1 : 0; }
int ob_bounds_aabb_intersects(const ob_bounds* b, double x0, double y0, double x1, double y1) {
  return b && b->bounds.aabbIntersects(x0, y0, x1, y1) ? 1 : 0;
}

int ob_bounds_contains_point(const ob_bounds* b, double x, double y) { return b ? b->bounds.containsPoint(x, y) : -1; }
int ob_bounds_contains_point_all(const ob_bounds* b, double x, double y, int* out, int capacity) {
  return b ? copyIndices(b->bounds.containsPointAll(x, y), out, capacity) : 0;
}
int ob_bounds_intersects_segment(const ob_bounds* b, double x1, double y1, double x2, double y2) {
  return b ? b->bounds.intersectsSegment(x1, y1, x2, y2) : -1;
}
int ob_bounds_intersects_segment_all(const ob_bounds* b, double x1, double y1, double x2, double y2, int* out, int capacity) {
  return b ? copyIndices(b->bounds.intersectsSegmentAll(x1, y1, x2, y2), out, capacity) : 0;
}

int ob_bounds_intersects_bounds(const ob_bounds* b, const ob_bounds* other, int* mine, int* theirs) {
  if (!b || !other) return 0;
  const auto pair = b->bounds.intersectsBounds(other->bounds);
  if (!pair) return 0;
  if (mine) *mine = pair->first;
  if (theirs) *theirs = pair->second;
  return 1;
}

}  // extern "C"
