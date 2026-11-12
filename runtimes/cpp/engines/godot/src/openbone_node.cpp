// SPDX-License-Identifier: MIT
#include "openbone_node.hpp"

#include <godot_cpp/classes/audio_stream_mp3.hpp>
#include <godot_cpp/classes/audio_stream_ogg_vorbis.hpp>
#include <godot_cpp/classes/audio_stream_wav.hpp>
#include <godot_cpp/classes/engine.hpp>
#include <godot_cpp/classes/file_access.hpp>
#include <godot_cpp/classes/font.hpp>
#include <godot_cpp/classes/image.hpp>
#include <godot_cpp/classes/image_texture.hpp>
#include <godot_cpp/classes/input_event_mouse_button.hpp>
#include <godot_cpp/classes/input_event_mouse_motion.hpp>
#include <godot_cpp/classes/marshalls.hpp>
#include <godot_cpp/classes/rendering_server.hpp>
#include <godot_cpp/classes/resource_loader.hpp>
#include <godot_cpp/classes/theme_db.hpp>
#include <godot_cpp/classes/tween.hpp>
#include <godot_cpp/classes/property_tweener.hpp>
#include <godot_cpp/classes/callback_tweener.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include <cmath>

using namespace godot;
namespace ob = openbone;

namespace {

String S(const std::string& s) { return String::utf8(s.c_str(), (int)s.size()); }
std::string U(const String& s) {
  CharString c = s.utf8();
  return std::string(c.get_data(), c.length());
}

/** Skeleton space (y up) to the node's local space (y down): F·M·F with F = diag(1, -1). */
Transform2D flip(const ob::Affine& m) { return Transform2D(Vector2(m.a, -m.c), Vector2(-m.b, m.d), Vector2(m.x, -m.y)); }

ob::Value toValue(const Variant& v) {
  switch (v.get_type()) {
    case Variant::BOOL: return ob::Value::boolean((bool)v);
    case Variant::INT:
    case Variant::FLOAT: return ob::Value::number((double)v);
    default: return ob::Value::string(U(v.stringify()));
  }
}

const char* SHADER = R"(
shader_type canvas_item;
render_mode %s;
uniform vec3 dark = vec3(0.0);
uniform bool has_dark = false;
uniform bool premultiplied = false;
varying vec4 tint;
void vertex() { tint = COLOR; }
void fragment() {
  vec4 tex = texture(TEXTURE, UV);
  if (premultiplied && tex.a > 0.0) tex.rgb /= tex.a;
  COLOR = has_dark ? vec4(dark + (tint.rgb - dark) * tex.rgb, tex.a * tint.a) : tint * tex;
}
)";

}  // namespace

OpenBoneSprite::OpenBoneSprite() {}

OpenBoneSprite::~OpenBoneSprite() { free_resources(); }

// ---------------- Audio ----------------

void OpenBoneSprite::set_audio_enabled(bool v) {
  audio_enabled = v;
  if (!v) stop_all_audio();
}

void OpenBoneSprite::stop_all_audio() {
  for (auto& v : voices)
    if (v.second) {
      v.second->stop();  // releases the stream playback now, not when the audio server next mixes
      v.second->queue_free();
    }
  voices.clear();
}

void OpenBoneSprite::_exit_tree() { stop_all_audio(); }

bool OpenBoneSprite::is_muted(const std::optional<std::string>& bus) const {
  auto it = mutes.find(bus.value_or(""));
  if (it != mutes.end()) return it->second;
  if (!doc || !doc->audio) return false;
  if (!bus) return doc->audio->muted;
  for (const auto& b : doc->audio->buses)
    if (b.id == *bus) return b.muted;
  return false;
}

double OpenBoneSprite::bus_gain(const std::optional<std::string>& bus) const {
  if (is_muted(std::nullopt)) return 0;
  if (!doc || !doc->audio) return 1;
  const ob::AudioData& a = *doc->audio;
  double g = a.master;
  if (bus)
    for (const auto& b : a.buses)
      if (b.id == *bus) g *= is_muted(bus) ? 0 : b.volume;
  return g;
}

Ref<AudioStream> OpenBoneSprite::stream_for(const std::string& asset_id) {
  auto it = streams.find(asset_id);
  if (it != streams.end()) return it->second;
  Ref<AudioStream> s;
  const ob::AudioAsset* asset = nullptr;
  if (doc && doc->audio)
    for (const auto& a : doc->audio->assets)
      if (a.id == asset_id) asset = &a;
  if (asset) {
    const std::string& src = asset->src;
    PackedByteArray raw;
    std::string kind;  // wav | ogg | mp3
    if (src.rfind("data:", 0) == 0) {
      const size_t comma = src.find(',');
      const std::string meta = src.substr(5, comma == std::string::npos ? 0 : comma - 5);
      raw = Marshalls::get_singleton()->base64_to_raw(S(comma == std::string::npos ? "" : src.substr(comma + 1)));
      kind = meta.find("ogg") != std::string::npos ? "ogg" : meta.find("mp") != std::string::npos ? "mp3" : "wav";
    } else if (!src.empty()) {
      const String path = document_path.get_base_dir().path_join(S(src));
      const String ext = path.get_extension().to_lower();
      kind = ext == "ogg" || ext == "oga" ? "ogg" : ext == "mp3" ? "mp3" : "wav";
      if (ResourceLoader::get_singleton()->exists(path)) s = ResourceLoader::get_singleton()->load(path);
      else raw = FileAccess::get_file_as_bytes(path);
    }
    if (s.is_null() && !raw.is_empty()) {
      if (kind == "ogg") s = AudioStreamOggVorbis::load_from_buffer(raw);
      else if (kind == "mp3") s = AudioStreamMP3::load_from_buffer(raw);
      else s = AudioStreamWAV::load_from_buffer(raw);
    }
    if (s.is_null()) UtilityFunctions::push_warning("OpenBone: cannot load sound ", S(asset->name), " (", S(src), ")");
  }
  streams[asset_id] = s;
  return s;
}

void OpenBoneSprite::handle_audio(const ob::AudioCommand& c) {
  if (c.type == ob::AudioCommand::Type::Mix) {
    // A mute button: remember it (also for sounds started later) and re-gain what is playing on that bus.
    mutes[c.bus.value_or("")] = c.muted;
    for (auto& [id, p] : voices) {
      if (!p) continue;
      const String bus = p->get_meta("openbone_bus", "");
      const std::optional<std::string> b = bus.is_empty() ? std::nullopt : std::optional<std::string>(bus.utf8().get_data());
      const double vol = p->get_meta("openbone_volume", 1.0);
      p->set_volume_linear((float)(vol * bus_gain(b)));
    }
    return;
  }
  if (!audio_enabled || !is_inside_tree()) return;
  if (c.type == ob::AudioCommand::Type::Play) {
    Ref<AudioStream> stream = stream_for(c.asset);
    if (stream.is_null()) return;
    AudioStreamPlayer* p = memnew(AudioStreamPlayer);
    p->set_stream(stream);
    p->set_bus(audio_bus);
    p->set_pitch_scale((float)std::max(0.01, c.rate));
    const float target = (float)(c.volume * bus_gain(c.bus));
    p->set_volume_linear(c.fadeIn > 0 ? 0.f : target);
    p->set_meta("openbone_loop", c.loop);
    p->set_meta("openbone_bus", c.bus ? S(*c.bus) : String());
    p->set_meta("openbone_volume", c.volume);
    add_child(p);
    p->connect("finished", callable_mp(this, &OpenBoneSprite::_on_voice_finished).bind(S(c.id)));
    p->play();
    if (c.fadeIn > 0) p->create_tween()->tween_property(p, "volume_linear", target, c.fadeIn);
    voices[c.id] = p;
    return;
  }
  auto it = voices.find(c.id);
  if (it == voices.end() || !it->second) return;
  AudioStreamPlayer* p = it->second;
  if (c.type == ob::AudioCommand::Type::Stop) {
    voices.erase(it);
    if (c.fade > 0) {
      Ref<Tween> t = p->create_tween();
      t->tween_property(p, "volume_linear", 0.f, c.fade);
      t->tween_callback(Callable(p, "queue_free"));
    } else
      p->queue_free();
  } else {
    // Fade: c.volume is the sound's new volume; keep the bus and master gain of the voice.
    const ob::SoundData* sound = nullptr;
    if (doc && doc->audio)
      for (const auto& snd : doc->audio->sounds)
        if (snd.id == c.sound) sound = &snd;
    const float target = (float)(c.volume * bus_gain(sound ? sound->bus : std::nullopt));
    p->set_meta("openbone_volume", c.volume);
    p->create_tween()->tween_property(p, "volume_linear", target, std::max(0.0, c.duration));
  }
}

void OpenBoneSprite::_on_voice_finished(const String& id) {
  auto it = voices.find(U(id));
  if (it == voices.end() || !it->second) return;
  AudioStreamPlayer* p = it->second;
  if ((bool)p->get_meta("openbone_loop", false)) {
    p->play();
    return;
  }
  voices.erase(it);
  p->queue_free();
}

void OpenBoneSprite::free_resources() {
  RenderingServer* rs = RenderingServer::get_singleton();
  if (!rs) return;
  for (RID r : items) rs->free_rid(r);
  items.clear();
  for (auto& m : materials) rs->free_rid(m.second);
  materials.clear();
  for (auto& s : shaders) rs->free_rid(s.second);
  shaders.clear();
}

void OpenBoneSprite::_bind_methods() {
  ClassDB::bind_method(D_METHOD("set_document", "path"), &OpenBoneSprite::set_document);
  ClassDB::bind_method(D_METHOD("get_document"), &OpenBoneSprite::get_document);
  ClassDB::bind_method(D_METHOD("set_animation", "name"), &OpenBoneSprite::set_animation);
  ClassDB::bind_method(D_METHOD("get_animation"), &OpenBoneSprite::get_animation);
  ClassDB::bind_method(D_METHOD("set_state_machine", "name"), &OpenBoneSprite::set_state_machine);
  ClassDB::bind_method(D_METHOD("get_state_machine"), &OpenBoneSprite::get_state_machine);
  ClassDB::bind_method(D_METHOD("set_skin", "name"), &OpenBoneSprite::set_skin);
  ClassDB::bind_method(D_METHOD("get_skin"), &OpenBoneSprite::get_skin);
  ClassDB::bind_method(D_METHOD("set_looping", "loop"), &OpenBoneSprite::set_looping);
  ClassDB::bind_method(D_METHOD("get_looping"), &OpenBoneSprite::get_looping);
  ClassDB::bind_method(D_METHOD("set_playing", "playing"), &OpenBoneSprite::set_playing);
  ClassDB::bind_method(D_METHOD("is_playing"), &OpenBoneSprite::is_playing);
  ClassDB::bind_method(D_METHOD("set_speed", "speed"), &OpenBoneSprite::set_speed);
  ClassDB::bind_method(D_METHOD("get_speed"), &OpenBoneSprite::get_speed);
  ClassDB::bind_method(D_METHOD("set_scripts_enabled", "enabled"), &OpenBoneSprite::set_scripts_enabled);
  ClassDB::bind_method(D_METHOD("get_scripts_enabled"), &OpenBoneSprite::get_scripts_enabled);
  ClassDB::bind_method(D_METHOD("set_handle_input", "enabled"), &OpenBoneSprite::set_handle_input);
  ClassDB::bind_method(D_METHOD("get_handle_input"), &OpenBoneSprite::get_handle_input);

  ClassDB::bind_method(D_METHOD("load", "path"), &OpenBoneSprite::load);
  ClassDB::bind_method(D_METHOD("is_loaded"), &OpenBoneSprite::is_loaded);
  ClassDB::bind_method(D_METHOD("play", "name", "loop", "track"), &OpenBoneSprite::play, DEFVAL(true), DEFVAL(0));
  ClassDB::bind_method(D_METHOD("queue", "name", "loop", "track", "delay"), &OpenBoneSprite::queue, DEFVAL(true), DEFVAL(0), DEFVAL(0.0));
  ClassDB::bind_method(D_METHOD("use_state_machine", "name"), &OpenBoneSprite::use_state_machine);
  ClassDB::bind_method(D_METHOD("set_input", "name", "value"), &OpenBoneSprite::set_input);
  ClassDB::bind_method(D_METHOD("fire", "name"), &OpenBoneSprite::fire);
  ClassDB::bind_method(D_METHOD("get_input", "name"), &OpenBoneSprite::get_input);
  ClassDB::bind_method(D_METHOD("get_active_state", "layer"), &OpenBoneSprite::get_active_state, DEFVAL(0));
  ClassDB::bind_method(D_METHOD("pointer", "type", "skeleton_position"), &OpenBoneSprite::pointer);
  ClassDB::bind_method(D_METHOD("advance", "delta"), &OpenBoneSprite::advance);
  ClassDB::bind_method(D_METHOD("get_animations"), &OpenBoneSprite::get_animations);
  ClassDB::bind_method(D_METHOD("get_state_machines"), &OpenBoneSprite::get_state_machines);
  ClassDB::bind_method(D_METHOD("get_skins"), &OpenBoneSprite::get_skins);
  ClassDB::bind_method(D_METHOD("get_bone_transform", "bone"), &OpenBoneSprite::get_bone_transform);
  ClassDB::bind_method(D_METHOD("get_draw_items"), &OpenBoneSprite::get_draw_items);
  ClassDB::bind_method(D_METHOD("get_bounds"), &OpenBoneSprite::get_bounds);
  ClassDB::bind_method(D_METHOD("set_text", "slot", "text"), &OpenBoneSprite::set_text);
  ClassDB::bind_method(D_METHOD("set_audio_enabled", "enabled"), &OpenBoneSprite::set_audio_enabled);
  ClassDB::bind_method(D_METHOD("get_audio_enabled"), &OpenBoneSprite::get_audio_enabled);
  ClassDB::bind_method(D_METHOD("set_audio_bus", "bus"), &OpenBoneSprite::set_audio_bus);
  ClassDB::bind_method(D_METHOD("get_audio_bus"), &OpenBoneSprite::get_audio_bus);
  ClassDB::bind_method(D_METHOD("stop_all_audio"), &OpenBoneSprite::stop_all_audio);
  ClassDB::bind_method(D_METHOD("_on_voice_finished", "id"), &OpenBoneSprite::_on_voice_finished);

  ADD_PROPERTY(PropertyInfo(Variant::STRING, "document", PROPERTY_HINT_FILE, "*.obone,*.obonb"), "set_document", "get_document");
  ADD_PROPERTY(PropertyInfo(Variant::STRING, "animation"), "set_animation", "get_animation");
  ADD_PROPERTY(PropertyInfo(Variant::STRING, "state_machine"), "set_state_machine", "get_state_machine");
  ADD_PROPERTY(PropertyInfo(Variant::STRING, "skin"), "set_skin", "get_skin");
  ADD_PROPERTY(PropertyInfo(Variant::BOOL, "looping"), "set_looping", "get_looping");
  ADD_PROPERTY(PropertyInfo(Variant::BOOL, "playing"), "set_playing", "is_playing");
  ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "speed"), "set_speed", "get_speed");
  ADD_PROPERTY(PropertyInfo(Variant::BOOL, "scripts_enabled"), "set_scripts_enabled", "get_scripts_enabled");
  ADD_PROPERTY(PropertyInfo(Variant::BOOL, "handle_input"), "set_handle_input", "get_handle_input");
  ADD_PROPERTY(PropertyInfo(Variant::BOOL, "audio_enabled"), "set_audio_enabled", "get_audio_enabled");
  ADD_PROPERTY(PropertyInfo(Variant::STRING, "audio_bus"), "set_audio_bus", "get_audio_bus");

  ADD_SIGNAL(MethodInfo("animation_event", PropertyInfo(Variant::STRING, "name"), PropertyInfo(Variant::FLOAT, "time"), PropertyInfo(Variant::INT, "int_value"),
                        PropertyInfo(Variant::FLOAT, "float_value"), PropertyInfo(Variant::STRING, "string_value")));
  ADD_SIGNAL(MethodInfo("audio_command", PropertyInfo(Variant::DICTIONARY, "command")));
  ADD_SIGNAL(MethodInfo("state_changed", PropertyInfo(Variant::STRING, "layer"), PropertyInfo(Variant::STRING, "from"), PropertyInfo(Variant::STRING, "to")));
}

// ---------------- Properties ----------------

void OpenBoneSprite::set_document(const String& path) {
  document_path = path;
  if (is_inside_tree()) load(path);
}

void OpenBoneSprite::set_animation(const String& name) {
  animation = name;
  if (instance && !name.is_empty() && state_machine.is_empty()) play(name, looping);
}

void OpenBoneSprite::set_state_machine(const String& name) {
  state_machine = name;
  if (instance && !name.is_empty()) use_state_machine(name);
}

void OpenBoneSprite::set_skin(const String& name) {
  skin = name;
  if (!instance) return;
  if (name.is_empty()) instance->skeleton->setSkin(nullptr);
  else instance->skeleton->setSkin(U(name));
  instance->advance(0);
  dirty = true;
  queue_redraw();
}

// ---------------- Loading ----------------

bool OpenBoneSprite::load(const String& path_ref) {
  // Copy first: _ready() passes document_path itself, and assigning a godot::String to itself empties it.
  const String path = path_ref;
  document_path = path;
  PackedByteArray bytes = FileAccess::get_file_as_bytes(path);
  if (bytes.is_empty()) {
    UtilityFunctions::push_error("OpenBone: cannot read ", path);
    return false;
  }
  try {
    doc = ob::loadDocument(bytes.ptr(), (size_t)bytes.size());
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", path, ": ", e.what());
    return false;
  }
  textures.clear();
  premultiplied.clear();
  stop_all_audio();
  streams.clear();
  instance = std::make_unique<ob::Instance>(doc, scripts_enabled ? ob::createQuickJsHost() : nullptr);
  instance->onEvent = [this](const ob::FiredEvent& e) {
    emit_signal("animation_event", S(e.name), e.time, (int64_t)e.intValue, e.floatValue, S(e.stringValue));
  };
  instance->onAudio = [this](const ob::AudioCommand& c) {
    Dictionary d;
    d["type"] = c.type == ob::AudioCommand::Type::Play ? "play" : c.type == ob::AudioCommand::Type::Stop ? "stop" : "fade";
    d["id"] = S(c.id);
    if (c.type == ob::AudioCommand::Type::Play) {
      d["sound"] = S(c.sound);
      d["asset"] = S(c.asset);
      d["bus"] = c.bus ? Variant(S(*c.bus)) : Variant();
      d["volume"] = c.volume;
      d["rate"] = c.rate;
      d["loop"] = c.loop;
      d["fade_in"] = c.fadeIn;
      d["source"] = S(c.source);
    } else if (c.type == ob::AudioCommand::Type::Stop)
      d["fade"] = c.fade;
    else {
      d["volume"] = c.volume;
      d["duration"] = c.duration;
    }
    emit_signal("audio_command", d);
    handle_audio(c);
  };
  instance->onStateChange = [this](const std::string& layer, const std::string* from, const std::string& to) {
    emit_signal("state_changed", S(layer), from ? S(*from) : String(), S(to));
  };
  if (doc->atlas)
    for (const auto& p : doc->atlas->pages) premultiplied[p.id] = doc->atlas->premultipliedAlpha;
  start();
  return true;
}

void OpenBoneSprite::start() {
  if (!instance) return;
  if (!skin.is_empty()) instance->skeleton->setSkin(U(skin));
  try {
    if (!state_machine.is_empty()) instance->useStateMachine(U(state_machine));
    else if (!animation.is_empty()) instance->play(U(animation), looping);
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
  }
  instance->advance(0);
  dirty = true;
  queue_redraw();
}

void OpenBoneSprite::_ready() {
  set_process(true);
  set_process_unhandled_input(true);
  if (!instance && !document_path.is_empty()) load(document_path);
}

// ---------------- Playback ----------------

bool OpenBoneSprite::play(const String& name, bool loop, int track) {
  if (!instance) return false;
  try {
    instance->play(U(name), loop, track);
    animation = name;
    state_machine = String();
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

bool OpenBoneSprite::queue(const String& name, bool loop, int track, double delay) {
  if (!instance) return false;
  try {
    instance->animationState->addAnimation(track, U(name), loop, delay);
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

bool OpenBoneSprite::use_state_machine(const String& name) {
  if (!instance) return false;
  try {
    instance->useStateMachine(U(name));
    state_machine = name;
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

bool OpenBoneSprite::set_input(const String& name, const Variant& value) {
  if (!instance || !instance->stateMachine) return false;
  try {
    instance->stateMachine->setInput(U(name), toValue(value));
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

bool OpenBoneSprite::fire(const String& name) {
  if (!instance || !instance->stateMachine) return false;
  try {
    instance->stateMachine->fire(U(name));
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

Variant OpenBoneSprite::get_input(const String& name) const {
  if (!instance || !instance->stateMachine) return Variant();
  const ob::Value v = instance->stateMachine->getInput(U(name));
  if (v.isBool()) return v.b;
  if (v.isNumber()) return v.n;
  if (v.isString()) return S(v.s);
  return Variant();
}

String OpenBoneSprite::get_active_state(int layer) const {
  if (!instance || !instance->stateMachine) return String();
  const auto& layers = instance->stateMachine->data.layers;
  if (layer < 0 || layer >= (int)layers.size()) return String();
  for (const auto& [name, state] : instance->stateMachine->activeStates())
    if (name == layers[layer].name) return state ? S(*state) : String();
  return String();
}

void OpenBoneSprite::pointer(int type, const Vector2& p) {
  if (!instance) return;
  instance->pointer(type == 0 ? ob::PointerEvent::Down : type == 1 ? ob::PointerEvent::Up : ob::PointerEvent::Move, p.x, p.y);
}

void OpenBoneSprite::_unhandled_input(const Ref<InputEvent>& event) {
  if (!handle_input || !instance || !instance->stateMachine || Engine::get_singleton()->is_editor_hint()) return;
  Ref<InputEventMouseButton> mb = event;
  Ref<InputEventMouseMotion> mm = event;
  if (mb.is_valid() && mb->get_button_index() == MOUSE_BUTTON_LEFT) {
    const Vector2 local = to_local(get_global_mouse_position());
    pointer(mb->is_pressed() ? 0 : 1, Vector2(local.x, -local.y));
  } else if (mm.is_valid()) {
    const Vector2 local = to_local(get_global_mouse_position());
    pointer(4, Vector2(local.x, -local.y));
  }
}

void OpenBoneSprite::advance(double delta) {
  if (!instance) return;
  instance->advance(delta);
  dirty = true;
  queue_redraw();
  redraw();
}

void OpenBoneSprite::_process(double delta) {
  if (!instance) return;
  if (playing && !Engine::get_singleton()->is_editor_hint()) {
    instance->advance(delta * speed);
    dirty = true;
  }
  if (dirty) redraw();
}

// ---------------- Queries ----------------

PackedStringArray OpenBoneSprite::get_animations() const {
  PackedStringArray out;
  if (doc)
    for (const auto& a : doc->animations) out.push_back(S(a.name));
  return out;
}
PackedStringArray OpenBoneSprite::get_state_machines() const {
  PackedStringArray out;
  if (doc)
    for (const auto& s : doc->stateMachines) out.push_back(S(s.name));
  return out;
}
PackedStringArray OpenBoneSprite::get_skins() const {
  PackedStringArray out;
  if (doc)
    for (const auto& s : doc->skeleton.skins) out.push_back(S(s.name));
  return out;
}

Transform2D OpenBoneSprite::get_bone_transform(const String& bone) const {
  if (!instance) return Transform2D();
  const ob::Bone* b = instance->skeleton->findBone(U(bone));
  return b ? flip(b->world) : Transform2D();
}

Array OpenBoneSprite::get_draw_items() const {
  Array out;
  if (!instance) return out;
  const ob::DrawList list = instance->drawList();
  for (const auto& it : list.items) {
    Dictionary d;
    d["slot"] = S(it.slot->data->name);
    d["attachment"] = S(it.attachment->name);
    d["type"] = it.type;
    d["texture"] = it.texture ? Variant(S(it.texture->id)) : Variant();
    d["vertex_count"] = (int64_t)(it.vertices.size() / 2);
    d["triangle_count"] = (int64_t)(it.indices.size() / 3);
    d["clip"] = it.clip;
    if (it.text) d["text"] = S(it.text->content);
    out.push_back(d);
  }
  return out;
}

Rect2 OpenBoneSprite::get_bounds() const {
  if (!instance) return Rect2();
  const auto b = instance->skeleton->bounds();
  return Rect2(b[0], -b[3], b[2] - b[0], b[3] - b[1]);
}

bool OpenBoneSprite::set_text(const String& slot, const String& text) {
  if (!instance) return false;
  try {
    instance->skeleton->setText(U(slot), text.is_empty() ? std::nullopt : std::optional<std::string>(U(text)));
    dirty = true;
    return true;
  } catch (const std::exception& e) {
    UtilityFunctions::push_error("OpenBone: ", e.what());
    return false;
  }
}

// ---------------- Drawing ----------------

Ref<Texture2D> OpenBoneSprite::texture_for(const std::string& id, const std::string& src, bool page) {
  auto it = textures.find(id);
  if (it != textures.end()) return it->second;
  Ref<Texture2D> tex;
  if (id == ob::PARTICLE_DOT_TEXTURE) {
    const int n = ob::PARTICLE_DOT_SIZE;
    PackedByteArray px;
    px.resize(n * n * 4);
    for (int y = 0; y < n; y++)
      for (int x = 0; x < n; x++) {
        const double dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
        const uint8_t a = (uint8_t)std::lround(ob::particleDotAlpha(std::sqrt(dx * dx + dy * dy)) * 255);
        uint8_t* p = px.ptrw() + (y * n + x) * 4;
        p[0] = p[1] = p[2] = 255;
        p[3] = a;
      }
    tex = ImageTexture::create_from_image(Image::create_from_data(n, n, false, Image::FORMAT_RGBA8, px));
  } else if (src.rfind("data:", 0) == 0) {
    const size_t comma = src.find(',');
    const std::string meta = src.substr(5, comma == std::string::npos ? 0 : comma - 5);
    PackedByteArray raw = Marshalls::get_singleton()->base64_to_raw(S(comma == std::string::npos ? "" : src.substr(comma + 1)));
    Ref<Image> img;
    img.instantiate();
    Error err = meta.find("jpeg") != std::string::npos || meta.find("jpg") != std::string::npos ? img->load_jpg_from_buffer(raw)
              : meta.find("webp") != std::string::npos                                          ? img->load_webp_from_buffer(raw)
                                                                                                  : img->load_png_from_buffer(raw);
    if (err == OK) tex = ImageTexture::create_from_image(img);
  } else if (!src.empty()) {
    // A path relative to the document.
    const String path = document_path.get_base_dir().path_join(S(src));
    if (ResourceLoader::get_singleton()->exists(path)) tex = ResourceLoader::get_singleton()->load(path);
    else {
      Ref<Image> img = Image::load_from_file(path);
      if (img.is_valid()) tex = ImageTexture::create_from_image(img);
    }
  }
  (void)page;
  textures[id] = tex;
  return tex;
}

RID OpenBoneSprite::material_for(ob::BlendMode blend, const std::optional<ob::RGBA>& dark, bool pma) {
  RenderingServer* rs = RenderingServer::get_singleton();
  const auto key = std::make_tuple((int)blend, dark.has_value(), dark ? (float)(*dark)[0] : 0.f, dark ? (float)(*dark)[1] : 0.f,
                                   dark ? (float)(*dark)[2] : 0.f, pma);
  auto it = materials.find(key);
  if (it != materials.end()) return it->second;
  // Screen has no built-in canvas blend mode; it falls back to additive.
  const char* mode = blend == ob::BlendMode::Additive || blend == ob::BlendMode::Screen ? "blend_add" : blend == ob::BlendMode::Multiply ? "blend_mul" : "blend_mix";
  RID sh;
  auto s = shaders.find(mode);
  if (s == shaders.end()) {
    sh = rs->shader_create();
    char code[2048];
    std::snprintf(code, sizeof code, SHADER, mode);
    rs->shader_set_code(sh, code);
    shaders[mode] = sh;
  } else
    sh = s->second;
  RID mat = rs->material_create();
  rs->material_set_shader(mat, sh);
  rs->material_set_param(mat, "has_dark", dark.has_value());
  if (dark) rs->material_set_param(mat, "dark", Vector3((*dark)[0], (*dark)[1], (*dark)[2]));
  rs->material_set_param(mat, "premultiplied", pma);
  materials[key] = mat;
  return mat;
}

RID OpenBoneSprite::canvas_item(size_t index) {
  RenderingServer* rs = RenderingServer::get_singleton();
  while (items.size() <= index) items.push_back(rs->canvas_item_create());
  return items[index];
}

void OpenBoneSprite::redraw() {
  dirty = false;
  if (!instance) return;
  RenderingServer* rs = RenderingServer::get_singleton();
  const ob::DrawList list = instance->drawList();
  const RID parent = get_canvas_item();
  size_t used = 0;
  int clipItem = -1;  // index in `items` of the open clip group
  int openClip = -1;
  int order = 0;
  for (const auto& it : list.items) {
    // Clipping: items under a mask become children of a canvas group that draws the mask in clip-only mode.
    if (it.clip != openClip) {
      openClip = it.clip;
      clipItem = -1;
      if (it.clip >= 0) {
        const ob::ClipRegion& c = list.clips[it.clip];
        const RID group = canvas_item(used);
        clipItem = (int)used++;
        rs->canvas_item_clear(group);
        rs->canvas_item_set_parent(group, parent);
        rs->canvas_item_set_draw_index(group, order++);
        rs->canvas_item_set_material(group, RID());
        rs->canvas_item_set_canvas_group_mode(group, RenderingServer::CANVAS_GROUP_MODE_CLIP_ONLY);
        PackedVector2Array pts;
        for (size_t i = 0; i + 1 < c.polygon.size(); i += 2) pts.push_back(Vector2(c.polygon[i], -c.polygon[i + 1]));
        PackedInt32Array idx;
        for (uint16_t i : c.indices) idx.push_back(i);
        rs->canvas_item_add_triangle_array(group, idx, pts, PackedColorArray({Color(1, 1, 1, 1)}));
      }
    }
    const RID ci = canvas_item(used++);
    rs->canvas_item_clear(ci);
    rs->canvas_item_set_canvas_group_mode(ci, RenderingServer::CANVAS_GROUP_MODE_DISABLED);
    rs->canvas_item_set_parent(ci, clipItem >= 0 ? items[clipItem] : parent);
    rs->canvas_item_set_draw_index(ci, order++);
    if (it.text) {
      const ob::TextDraw& t = *it.text;
      Ref<Font> font = ThemeDB::get_singleton()->get_fallback_font();
      rs->canvas_item_set_material(ci, RID());
      if (font.is_valid()) {
        rs->canvas_item_add_set_transform(ci, flip(t.matrix));
        const int size = (int)std::lround(t.size);
        const Color fill(t.fill[0] * it.color[0], t.fill[1] * it.color[1], t.fill[2] * it.color[2], t.fill[3] * it.color[3]);
        const HorizontalAlignment align = t.align == ob::TextAlign::Left ? HORIZONTAL_ALIGNMENT_LEFT
                                        : t.align == ob::TextAlign::Right ? HORIZONTAL_ALIGNMENT_RIGHT
                                                                          : HORIZONTAL_ALIGNMENT_CENTER;
        const double asc = font->get_ascent(size), desc = font->get_descent(size);
        const PackedStringArray lines = S(t.content).split("\n");
        const double lh = t.size * 1.2;
        const double y0 = -(lines.size() - 1) * lh / 2;
        for (int64_t i = 0; i < lines.size(); i++)
          font->draw_string(ci, Vector2(-t.width / 2, y0 + i * lh + (asc - desc) / 2), lines[i], align, t.width, size, fill);
      }
      continue;
    }
    PackedVector2Array pts, uvs;
    pts.resize(it.vertices.size() / 2);
    uvs.resize(it.uvs.size() / 2);
    for (size_t i = 0; i + 1 < it.vertices.size(); i += 2) pts.set(i / 2, Vector2(it.vertices[i], -it.vertices[i + 1]));
    for (size_t i = 0; i + 1 < it.uvs.size(); i += 2) uvs.set(i / 2, Vector2(it.uvs[i], it.uvs[i + 1]));
    PackedInt32Array idx;
    idx.resize(it.indices.size());
    for (size_t i = 0; i < it.indices.size(); i++) idx.set(i, it.indices[i]);
    PackedColorArray colors;
    if (it.isParticles)
      for (size_t i = 0; i + 3 < it.colors.size(); i += 4) colors.push_back(Color(it.colors[i], it.colors[i + 1], it.colors[i + 2], it.colors[i + 3]));
    else
      colors.push_back(Color(it.color[0], it.color[1], it.color[2], it.color[3]));
    RID tex;
    bool pma = false;
    if (it.texture) {
      Ref<Texture2D> t = texture_for(it.texture->id, it.texture->src ? *it.texture->src : std::string(), false);
      if (t.is_valid()) tex = t->get_rid();
      auto p = premultiplied.find(it.texture->id);
      pma = p != premultiplied.end() && p->second;
    }
    rs->canvas_item_set_material(ci, material_for(it.blend, it.dark, pma));
    rs->canvas_item_add_triangle_array(ci, idx, pts, colors, uvs, PackedInt32Array(), PackedFloat32Array(), tex);
  }
  for (size_t i = used; i < items.size(); i++) rs->canvas_item_clear(items[i]);
}
