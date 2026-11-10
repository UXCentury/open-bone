// OpenBone GDExtension: an OpenBoneSprite node (Node2D) that loads a .obone/.obonb document, plays animations or a
// state machine, forwards pointer input, and draws the runtime's draw list with RenderingServer canvas items.
// SPDX-License-Identifier: MIT
#pragma once

#include <godot_cpp/classes/input_event.hpp>
#include <godot_cpp/classes/audio_stream.hpp>
#include <godot_cpp/classes/audio_stream_player.hpp>
#include <godot_cpp/classes/node2d.hpp>
#include <godot_cpp/classes/texture2d.hpp>
#include <godot_cpp/variant/rid.hpp>

#include <map>
#include <memory>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "openbone/runtime.hpp"

namespace godot {

class OpenBoneSprite : public Node2D {
  GDCLASS(OpenBoneSprite, Node2D)

 public:
  OpenBoneSprite();
  ~OpenBoneSprite() override;

  void _ready() override;
  void _exit_tree() override;
  void _process(double delta) override;
  void _unhandled_input(const Ref<InputEvent>& event) override;

  // Properties
  void set_document(const String& path);
  String get_document() const { return document_path; }
  void set_animation(const String& name);
  String get_animation() const { return animation; }
  void set_state_machine(const String& name);
  String get_state_machine() const { return state_machine; }
  void set_skin(const String& name);
  String get_skin() const { return skin; }
  void set_looping(bool v) { looping = v; }
  bool get_looping() const { return looping; }
  void set_playing(bool v) { playing = v; }
  bool is_playing() const { return playing; }
  void set_speed(double v) { speed = v; }
  double get_speed() const { return speed; }
  void set_scripts_enabled(bool v) { scripts_enabled = v; }
  bool get_scripts_enabled() const { return scripts_enabled; }
  void set_handle_input(bool v) { handle_input = v; }
  bool get_handle_input() const { return handle_input; }
  /** Play the document's sounds through AudioStreamPlayer children (on by default; the audio_command signal fires either way). */
  void set_audio_enabled(bool v);
  bool get_audio_enabled() const { return audio_enabled; }
  void set_audio_bus(const String& v) { audio_bus = v; }
  String get_audio_bus() const { return audio_bus; }
  void stop_all_audio();

  // Methods
  bool load(const String& path);
  bool is_loaded() const { return instance != nullptr; }
  bool play(const String& name, bool loop = true, int track = 0);
  bool queue(const String& name, bool loop = true, int track = 0, double delay = 0);
  bool use_state_machine(const String& name);
  bool set_input(const String& name, const Variant& value);
  bool fire(const String& name);
  Variant get_input(const String& name) const;
  String get_active_state(int layer = 0) const;
  void pointer(int type, const Vector2& skeleton_position);
  void advance(double delta);
  PackedStringArray get_animations() const;
  PackedStringArray get_state_machines() const;
  PackedStringArray get_skins() const;
  Transform2D get_bone_transform(const String& bone) const;
  Array get_draw_items() const;
  Rect2 get_bounds() const;
  bool set_text(const String& slot, const String& text);

 protected:
  static void _bind_methods();

 private:
  String document_path, animation, state_machine, skin;
  bool looping = true, playing = true, scripts_enabled = true, handle_input = true, audio_enabled = true;
  String audio_bus = "Master";
  std::unordered_map<std::string, Ref<AudioStream>> streams;           // by audio asset id
  std::unordered_map<std::string, AudioStreamPlayer*> voices;           // by play id
  void handle_audio(const openbone::AudioCommand& c);
  Ref<AudioStream> stream_for(const std::string& asset_id);
  double bus_gain(const std::optional<std::string>& bus) const;
  void _on_voice_finished(const String& id);
  double speed = 1;
  std::shared_ptr<const openbone::Document> doc;
  std::unique_ptr<openbone::Instance> instance;
  std::unordered_map<std::string, Ref<Texture2D>> textures;
  std::unordered_map<std::string, bool> premultiplied;
  std::vector<RID> items;  // pooled canvas items (children of this node's canvas item)
  std::map<std::tuple<int, bool, float, float, float, bool>, RID> materials;
  std::map<std::string, RID> shaders;
  bool dirty = true;

  void start();
  void redraw();
  RID canvas_item(size_t index);
  RID material_for(openbone::BlendMode blend, const std::optional<openbone::RGBA>& dark, bool pma);
  Ref<Texture2D> texture_for(const std::string& id, const std::string& src, bool page);
  void free_resources();
};

}  // namespace godot
