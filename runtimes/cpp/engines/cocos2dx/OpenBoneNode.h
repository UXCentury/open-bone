// OpenBone renderer for Cocos2d-x 4.0: a Node that plays a .obone/.obonb document (animations or a state machine)
// and queues one TrianglesCommand per draw item. Cocos2d-x is y-up like OpenBone's skeleton space, so vertices are used
// as they are (the node's position is the skeleton origin).
//
//   auto* node = OpenBoneNode::create("knight.obone");   // path resolved with FileUtils
//   node->useStateMachine("knight");
//   node->setPosition(480, 120);
//   scene->addChild(node);
//
// SPDX-License-Identifier: MIT
#pragma once

#include <functional>
#include <optional>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "cocos2d.h"
#include "openbone/runtime.hpp"

class OpenBoneNode : public cocos2d::Node {
 public:
  static OpenBoneNode* create(const std::string& file, bool scripts = true);

  bool play(const std::string& animation, bool loop = true, int track = 0);
  bool useStateMachine(const std::string& name = "");
  bool setInput(const std::string& name, const openbone::Value& value);
  bool fire(const std::string& trigger);
  std::string activeState(int layer = 0) const;
  void setSkin(const std::string& skin);
  /** Pointer in skeleton space (node space). Touch/mouse listeners installed by enableTouch() call this. */
  void pointer(openbone::PointerEvent type, const cocos2d::Vec2& p);
  void enableTouch();
  openbone::Instance* instance() { return _instance.get(); }

  std::function<void(const openbone::FiredEvent&)> onEvent;
  std::function<void(const openbone::AudioCommand&)> onAudio;

  /** Play the document's sounds with cocos2d::AudioEngine (default on; onAudio is called either way). Cocos2d-x has
      no playback rate, so `rate` is ignored. */
  void setAudioEnabled(bool enabled);
  bool isAudioEnabled() const { return _audioEnabled; }
  void stopAllAudio();

  void update(float dt) override;
  void draw(cocos2d::Renderer* renderer, const cocos2d::Mat4& transform, uint32_t flags) override;
  ~OpenBoneNode() override;

 private:
  bool init(const std::string& file, bool scripts);
  cocos2d::Texture2D* texture(const openbone::TextureRef& ref);
  void handleAudio(const openbone::AudioCommand& c);
  std::string audioFile(const std::string& assetId);
  double busGain(const std::optional<std::string>& bus) const;

  struct Voice {
    int id = -1;
    std::optional<std::string> bus;
    float volume = 1, from = 1, to = 1;  // fade from → to over duration
    float time = 0, duration = 0;
    bool stopWhenFaded = false;
  };
  bool _audioEnabled = true;
  std::unordered_map<std::string, Voice> _voices;      // by play id
  std::unordered_map<std::string, std::string> _audioFiles;  // asset id → playable file path

  std::string _path;
  std::shared_ptr<const openbone::Document> _doc;
  std::unique_ptr<openbone::Instance> _instance;
  std::map<std::string, cocos2d::Texture2D*> _textures;
  cocos2d::Texture2D* _white = nullptr;

  /** Per draw item: vertex/index storage that must outlive the frame's render pass, plus its command. */
  struct Batch {
    std::vector<cocos2d::V3F_C4B_T2F> verts;
    std::vector<unsigned short> indices;
    cocos2d::TrianglesCommand command;
    cocos2d::backend::ProgramState* state = nullptr;
  };
  std::vector<std::unique_ptr<Batch>> _batches;
};
