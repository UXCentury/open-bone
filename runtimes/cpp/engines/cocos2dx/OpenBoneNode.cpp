// SPDX-License-Identifier: MIT
#include "OpenBoneNode.h"

#include "audio/include/AudioEngine.h"

#include "openbone_assets.hpp"
#include "renderer/backend/Device.h"

USING_NS_CC;
namespace ob = openbone;

OpenBoneNode* OpenBoneNode::create(const std::string& file, bool scripts) {
  auto* node = new (std::nothrow) OpenBoneNode();
  if (node && node->init(file, scripts)) {
    node->autorelease();
    return node;
  }
  delete node;
  return nullptr;
}

bool OpenBoneNode::init(const std::string& file, bool scripts) {
  if (!Node::init()) return false;
  _path = FileUtils::getInstance()->fullPathForFilename(file);
  const Data data = FileUtils::getInstance()->getDataFromFile(_path);
  if (data.isNull()) {
    CCLOG("OpenBone: cannot read %s", file.c_str());
    return false;
  }
  try {
    _doc = ob::loadDocument(data.getBytes(), (size_t)data.getSize());
  } catch (const std::exception& e) {
    CCLOG("OpenBone: %s: %s", file.c_str(), e.what());
    return false;
  }
  _instance = std::make_unique<ob::Instance>(_doc, scripts ? ob::createQuickJsHost() : nullptr);
  _instance->onEvent = [this](const ob::FiredEvent& e) {
    if (onEvent) onEvent(e);
  };
  _instance->onAudio = [this](const ob::AudioCommand& c) {
    if (onAudio) onAudio(c);
    handleAudio(c);
  };
  _instance->advance(0);
  scheduleUpdate();
  return true;
}

OpenBoneNode::~OpenBoneNode() {
  stopAllAudio();
  for (auto& t : _textures) CC_SAFE_RELEASE(t.second);
  for (auto& b : _batches) CC_SAFE_RELEASE(b->state);
}

bool OpenBoneNode::play(const std::string& animation, bool loop, int track) {
  try {
    _instance->play(animation, loop, track);
    return true;
  } catch (const std::exception& e) {
    CCLOG("OpenBone: %s", e.what());
    return false;
  }
}

bool OpenBoneNode::useStateMachine(const std::string& name) {
  try {
    _instance->useStateMachine(name);
    return true;
  } catch (const std::exception& e) {
    CCLOG("OpenBone: %s", e.what());
    return false;
  }
}

bool OpenBoneNode::setInput(const std::string& name, const ob::Value& value) {
  if (!_instance->stateMachine) return false;
  try {
    _instance->stateMachine->setInput(name, value);
    return true;
  } catch (const std::exception& e) {
    CCLOG("OpenBone: %s", e.what());
    return false;
  }
}

bool OpenBoneNode::fire(const std::string& trigger) {
  if (!_instance->stateMachine) return false;
  try {
    _instance->stateMachine->fire(trigger);
    return true;
  } catch (const std::exception& e) {
    CCLOG("OpenBone: %s", e.what());
    return false;
  }
}

std::string OpenBoneNode::activeState(int layer) const {
  if (!_instance->stateMachine) return "";
  const auto& layers = _instance->stateMachine->data.layers;
  if (layer < 0 || layer >= (int)layers.size()) return "";
  for (const auto& s : _instance->stateMachine->activeStates())
    if (s.first == layers[layer].name) return s.second.value_or("");
  return "";
}

void OpenBoneNode::setSkin(const std::string& skin) {
  _instance->skeleton->setSkin(skin);
  _instance->advance(0);
}

void OpenBoneNode::pointer(ob::PointerEvent type, const Vec2& p) { _instance->pointer(type, p.x, p.y); }

void OpenBoneNode::enableTouch() {
  auto* touch = EventListenerTouchOneByOne::create();
  touch->onTouchBegan = [this](Touch* t, Event*) {
    pointer(ob::PointerEvent::Down, convertToNodeSpace(t->getLocation()));
    return true;
  };
  touch->onTouchMoved = [this](Touch* t, Event*) { pointer(ob::PointerEvent::Move, convertToNodeSpace(t->getLocation())); };
  touch->onTouchEnded = [this](Touch* t, Event*) { pointer(ob::PointerEvent::Up, convertToNodeSpace(t->getLocation())); };
  _eventDispatcher->addEventListenerWithSceneGraphPriority(touch, this);
  auto* mouse = EventListenerMouse::create();
  mouse->onMouseMove = [this](EventMouse* e) { pointer(ob::PointerEvent::Move, convertToNodeSpace(Vec2(e->getCursorX(), e->getCursorY()))); };
  _eventDispatcher->addEventListenerWithSceneGraphPriority(mouse, this);
}

void OpenBoneNode::update(float dt) {
  _instance->advance(dt);
  // Volume fades (Cocos2d-x's AudioEngine has none of its own).
  for (auto it = _voices.begin(); it != _voices.end();) {
    Voice& v = it->second;
    if (v.duration > 0 && v.time < v.duration) {
      v.time = std::min(v.duration, v.time + dt);
      v.volume = v.from + (v.to - v.from) * (v.time / v.duration);
      AudioEngine::setVolume(v.id, v.volume);
    }
    if (v.stopWhenFaded && v.time >= v.duration) {
      AudioEngine::stop(v.id);
      it = _voices.erase(it);
    } else {
      ++it;
    }
  }
}

// ---------------- Audio ----------------

void OpenBoneNode::setAudioEnabled(bool enabled) {
  _audioEnabled = enabled;
  if (!enabled) stopAllAudio();
}

void OpenBoneNode::stopAllAudio() {
  for (auto& v : _voices) AudioEngine::stop(v.second.id);
  _voices.clear();
}

double OpenBoneNode::busGain(const std::optional<std::string>& bus) const {
  if (!_doc || !_doc->audio) return 1;
  const ob::AudioData& a = *_doc->audio;
  if (a.muted) return 0;
  double g = a.master;
  if (bus)
    for (const auto& b : a.buses)
      if (b.id == *bus) g *= b.muted ? 0 : b.volume;
  return g;
}

std::string OpenBoneNode::audioFile(const std::string& assetId) {
  auto found = _audioFiles.find(assetId);
  if (found != _audioFiles.end()) return found->second;
  std::string path;
  const ob::AudioAsset* asset = nullptr;
  if (_doc && _doc->audio)
    for (const auto& a : _doc->audio->assets)
      if (a.id == assetId) asset = &a;
  if (asset && asset->src.rfind("data:", 0) == 0) {
    // AudioEngine plays files: write an embedded sound to the writable path once.
    const auto bytes = ob::assets::readSource(asset->src, _path);
    if (!bytes.empty()) {
      const std::string meta = asset->src.substr(5, asset->src.find(','));
      const std::string ext = meta.find("ogg") != std::string::npos ? ".ogg" : meta.find("mp") != std::string::npos ? ".mp3" : ".wav";
      path = FileUtils::getInstance()->getWritablePath() + "openbone-" + std::to_string(std::hash<std::string>{}(_path)) + "-" + asset->id + ext;
      Data d;
      d.copy(bytes.data(), (ssize_t)bytes.size());
      if (!FileUtils::getInstance()->writeDataToFile(d, path)) path.clear();
    }
  } else if (asset && !asset->src.empty()) {
    const auto slash = _path.find_last_of("/\\");
    const std::string dir = slash == std::string::npos ? "" : _path.substr(0, slash + 1);
    path = FileUtils::getInstance()->fullPathForFilename(dir + asset->src);
  }
  if (path.empty() && asset) CCLOG("OpenBone: sound \"%s\" (%s) not found", asset->name.c_str(), asset->src.c_str());
  _audioFiles[assetId] = path;
  return path;
}

void OpenBoneNode::handleAudio(const ob::AudioCommand& c) {
  if (!_audioEnabled) return;
  if (c.type == ob::AudioCommand::Type::Play) {
    const std::string file = audioFile(c.asset);
    if (file.empty()) return;
    const float target = (float)(c.volume * busGain(c.bus));
    Voice v;
    v.bus = c.bus;
    v.id = AudioEngine::play2d(file, c.loop, c.fadeIn > 0 ? 0.f : target);
    if (v.id == AudioEngine::INVALID_AUDIO_ID) return;
    v.volume = v.from = c.fadeIn > 0 ? 0.f : target;
    v.to = target;
    v.duration = (float)c.fadeIn;
    if (!c.loop)
      AudioEngine::setFinishCallback(v.id, [this, id = c.id](int, const std::string&) { _voices.erase(id); });
    _voices[c.id] = v;
    return;
  }
  auto it = _voices.find(c.id);
  if (it == _voices.end()) return;
  Voice& v = it->second;
  if (c.type == ob::AudioCommand::Type::Stop) {
    if (c.fade <= 0) {
      AudioEngine::stop(v.id);
      _voices.erase(it);
      return;
    }
    v.from = v.volume, v.to = 0, v.time = 0, v.duration = (float)c.fade, v.stopWhenFaded = true;
  } else {
    v.from = v.volume, v.to = (float)(c.volume * busGain(v.bus)), v.time = 0, v.duration = (float)std::max(0.0, c.duration);
    if (v.duration == 0) AudioEngine::setVolume(v.id, v.volume = v.to);
  }
}

Texture2D* OpenBoneNode::texture(const ob::TextureRef& ref) {
  auto it = _textures.find(ref.id);
  if (it != _textures.end()) return it->second;
  Texture2D* tex = nullptr;
  auto* image = new (std::nothrow) Image();
  bool ok = false;
  if (ref.id == ob::PARTICLE_DOT_TEXTURE) {
    const auto px = ob::assets::particleDot();
    ok = image->initWithRawData(px.data(), (ssize_t)px.size(), ob::PARTICLE_DOT_SIZE, ob::PARTICLE_DOT_SIZE, 8, false);
  } else if (ref.src) {
    const auto bytes = ob::assets::readSource(*ref.src, _path);
    ok = !bytes.empty() && image->initWithImageData(bytes.data(), (ssize_t)bytes.size());
  }
  if (ok) {
    tex = new (std::nothrow) Texture2D();
    if (tex && !tex->initWithImage(image)) CC_SAFE_RELEASE_NULL(tex);
  }
  CC_SAFE_RELEASE(image);
  _textures[ref.id] = tex;
  return tex;
}

void OpenBoneNode::draw(Renderer* renderer, const Mat4& transform, uint32_t flags) {
  if (!_white) {
    const unsigned char px[4] = {255, 255, 255, 255};
    _white = new Texture2D();
    _white->initWithData(px, 4, backend::PixelFormat::RGBA8888, 1, 1, Size(1, 1));
    _textures["@white"] = _white;
  }
  const ob::DrawList list = _instance->drawList();
  const Mat4& projection = Director::getInstance()->getMatrix(MATRIX_STACK_TYPE::MATRIX_STACK_PROJECTION);
  size_t used = 0;
  for (const ob::DrawItem& it : list.items) {
    if (it.text) continue;  // text: add a Label child per text slot if you need it (content in it.text->content)
    if (_batches.size() <= used) {
      auto b = std::make_unique<Batch>();
      auto* program = backend::Program::getBuiltinProgram(backend::ProgramType::POSITION_TEXTURE_COLOR);
      b->state = new backend::ProgramState(program);
      b->command.getPipelineDescriptor().programState = b->state;
      _batches.push_back(std::move(b));
    }
    Batch& b = *_batches[used++];
    const size_t n = it.vertices.size() / 2;
    b.verts.resize(n);
    for (size_t i = 0; i < n; i++) {
      auto& v = b.verts[i];
      v.vertices = Vec3(it.vertices[i * 2], it.vertices[i * 2 + 1], 0);
      v.texCoords = Tex2F(i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2] : 0, i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2 + 1] : 0);
      auto ch = [](double x) { return (uint8_t)(x <= 0 ? 0 : x >= 1 ? 255 : x * 255 + 0.5); };
      const float* c = it.isParticles ? &it.colors[i * 4] : nullptr;
      v.colors = c ? Color4B(ch(c[0]), ch(c[1]), ch(c[2]), ch(c[3])) : Color4B(ch(it.color[0]), ch(it.color[1]), ch(it.color[2]), ch(it.color[3] * _displayedOpacity / 255.0));
    }
    b.indices.assign(it.indices.begin(), it.indices.end());
    Texture2D* tex = it.texture ? texture(*it.texture) : nullptr;
    if (!tex) tex = _white;
    BlendFunc blend = BlendFunc::ALPHA_NON_PREMULTIPLIED;
    if (it.blend == ob::BlendMode::Additive || it.blend == ob::BlendMode::Screen) blend = BlendFunc::ADDITIVE;
    else if (it.blend == ob::BlendMode::Multiply) blend = {backend::BlendFactor::DST_COLOR, backend::BlendFactor::ONE_MINUS_SRC_ALPHA};
    b.state->setUniform(b.state->getUniformLocation("u_MVPMatrix"), projection.m, sizeof(projection.m));
    // Cocos2d-x 4's renderer binds textures from the program state (TrianglesCommand only keeps it for batching).
    b.state->setTexture(b.state->getUniformLocation("u_texture"), 0, tex->getBackendTexture());
    TrianglesCommand::Triangles tris{b.verts.data(), b.indices.data(), (unsigned)b.verts.size(), (unsigned)b.indices.size()};
    b.command.init(_globalZOrder, tex, blend, tris, transform, flags);
    renderer->addCommand(&b.command);
  }
}
