// SPDX-License-Identifier: MIT
#include "OpenBoneNode.h"

#include "audio/include/AudioEngine.h"

#include "openbone_assets.hpp"
#include "renderer/backend/Device.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#if CC_TARGET_PLATFORM == CC_PLATFORM_LINUX
#include <fontconfig/fontconfig.h>
#endif

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
  syncText();
  return true;
}

void OpenBoneNode::onExit() {
  stopAllAudio();
  Node::onExit();
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
  syncText();
}

// ---------------- Text ----------------

namespace {
std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  return s;
}

std::vector<std::string> splitFamilies(const std::string& list) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= list.size()) {
    size_t end = list.find(',', start);
    if (end == std::string::npos) end = list.size();
    std::string n = list.substr(start, end - start);
    const auto b = n.find_first_not_of(" \t\"'"), e = n.find_last_not_of(" \t\"'");
    n = b == std::string::npos ? "" : n.substr(b, e - b + 1);
    if (!n.empty()) out.push_back(n);
    start = end + 1;
  }
  return out;
}

std::vector<char32_t> codepoints(const std::string& s) {
  std::vector<char32_t> out;
  std::u32string u;
  if (StringUtils::UTF8ToUTF32(s, u)) out.assign(u.begin(), u.end());
  return out;
}

Color4B color4(const ob::RGBA& c, const ob::RGBA& tint) {
  auto ch = [](double x) { return (uint8_t)(x <= 0 ? 0 : x >= 1 ? 255 : x * 255 + 0.5); };
  return Color4B(ch(c[0] * tint[0]), ch(c[1] * tint[1]), ch(c[2] * tint[2]), ch(c[3] * tint[3]));
}

#if CC_TARGET_PLATFORM == CC_PLATFORM_LINUX
/** fontconfig: the file for a family if it is installed (generic names always resolve) and has every character. */
std::string fontconfigFile(const std::string& family, const std::vector<char32_t>& chars) {
  static bool ready = FcInit();
  if (!ready) return "";
  const std::string fam = lower(family);
  const bool generic = fam == "serif" || fam == "sans-serif" || fam == "monospace" || fam == "cursive" || fam == "fantasy" ||
                       fam == "system-ui" || fam.rfind("ui-", 0) == 0;
  const std::string query = fam == "system-ui" || fam == "ui-sans-serif" ? "sans-serif" : fam == "ui-serif" ? "serif" : fam == "ui-monospace" ? "monospace" : family;
  FcPattern* pat = FcNameParse((const FcChar8*)query.c_str());
  if (!pat) return "";
  FcConfigSubstitute(nullptr, pat, FcMatchPattern);
  FcDefaultSubstitute(pat);
  FcResult res;
  FcPattern* match = FcFontMatch(nullptr, pat, &res);
  FcPatternDestroy(pat);
  if (!match) return "";
  std::string file;
  bool named = generic;
  FcChar8* s = nullptr;
  for (int i = 0; !named && FcPatternGetString(match, FC_FAMILY, i, &s) == FcResultMatch; i++)
    if (lower((const char*)s) == fam) named = true;
  FcCharSet* cs = nullptr;
  bool covers = FcPatternGetCharSet(match, FC_CHARSET, 0, &cs) == FcResultMatch;
  for (char32_t c : chars)
    if (covers && c > 32 && !FcCharSetHasChar(cs, (FcChar32)c)) covers = false;
  // Cocos2d-x loads face 0 of a file, so skip faces further into a collection (.ttc).
  int index = 0;
  FcPatternGetInteger(match, FC_INDEX, 0, &index);
  if (named && covers && index == 0 && FcPatternGetString(match, FC_FILE, 0, &s) == FcResultMatch) file = (const char*)s;
  FcPatternDestroy(match);
  return file;
}
#endif
}  // namespace

void OpenBoneNode::setFontFile(const std::string& family, const std::string& file) {
  _fontFiles[lower(family)] = file;
  _fontCache.clear();
  for (auto* l : _labels) l->removeFromParent();
  _labels.clear();
  syncText();
}

void OpenBoneNode::setTextEnabled(bool enabled) {
  _textEnabled = enabled;
  syncText();
}

std::string OpenBoneNode::fontFileFor(const std::string& families, const std::string& text) {
  const std::string key = families + '\n' + text;
  auto hit = _fontCache.find(key);
  if (hit != _fontCache.end()) return hit->second;
  std::string file;
  const auto fams = splitFamilies(families);
  for (const auto& f : fams) {
    auto reg = _fontFiles.find(lower(f));
    if (reg != _fontFiles.end()) {
      file = reg->second;
      break;
    }
#if CC_TARGET_PLATFORM == CC_PLATFORM_LINUX
    file = fontconfigFile(f, codepoints(text));
    if (!file.empty()) break;
#endif
  }
  _fontCache[key] = file;
  return file;
}

/**
 * One Label per text item, in draw order, placed with the text's box matrix (centre, rotation, scale; skeleton space is
 * node space). Called after each advance, outside the render pass, since it adds and removes children.
 */
void OpenBoneNode::syncText() {
  size_t used = 0;
  if (_textEnabled && _instance) {
    const ob::DrawList list = _instance->drawList();
    for (const ob::DrawItem& it : list.items) {
      if (!it.text || it.text->content.empty()) continue;
      const ob::TextDraw& t = *it.text;
      const std::string file = fontFileFor(t.font, t.content);
      const auto fams = splitFamilies(t.font);
      const float size = (float)t.size;
      Label* label = used < _labels.size() ? _labels[used] : nullptr;
      // A label keeps its font kind (TTF or system) and file; make a new one when those change.
      const bool multiline = t.content.find('\n') != std::string::npos;
      const std::string want = (file.empty() ? "sys:" + (fams.empty() ? std::string("sans-serif") : fams[0]) : "ttf:" + file) + (multiline ? "|multi" : "");
      if (label && label->getName() != want + "|" + std::to_string(size)) {
        label->removeFromParent();
        label = nullptr;
      }
      if (!label) {
        if (!file.empty()) {
          TTFConfig cfg(file, size, GlyphCollection::DYNAMIC);
          cfg.outlineSize = 0;
          label = Label::createWithTTF(cfg, t.content);
        }
        if (!label) label = Label::createWithSystemFont(t.content, fams.empty() ? "sans-serif" : fams[0], size);
        label->setName(want + "|" + std::to_string(size));
        addChild(label, 1);
        if (used < _labels.size()) _labels[used] = label;
        else _labels.push_back(label);
      }
      label->setVisible(true);
      if (label->getString() != t.content) label->setString(t.content);
      label->setDimensions((float)t.width, 0);
      label->setAlignment(t.align == ob::TextAlign::Left ? TextHAlignment::LEFT : t.align == ob::TextAlign::Right ? TextHAlignment::RIGHT : TextHAlignment::CENTER,
                          TextVAlignment::CENTER);
      // Single lines keep the font's own line box, which centres on the glyphs like the canvas's "middle" baseline
      // (a taller forced line box puts them low); several lines are spaced 1.2 × size apart like the web player.
      if (multiline) label->setLineHeight(size * 1.2f);
      label->setTextColor(color4(t.fill, it.color));
      if (t.outline && t.outlineWidth > 0) label->enableOutline(color4(*t.outline, it.color), std::max(1, (int)std::lround(t.outlineWidth)));
      else label->disableEffect(LabelEffect::OUTLINE);
      const ob::Affine& m = t.matrix;
      const float sx = (float)std::sqrt(m.a * m.a + m.b * m.b), sy = (float)std::sqrt(m.c * m.c + m.d * m.d);
      label->setAnchorPoint(Vec2(0.5f, 0.5f));
      label->setPosition(Vec2((float)m.x, (float)m.y));
      label->setRotation((float)(-std::atan2(m.b, m.a) * 180 / M_PI));  // Cocos2d-x rotates clockwise
      label->setScale(sx, sy);
      used++;
    }
  }
  for (size_t i = used; i < _labels.size(); i++) _labels[i]->setVisible(false);
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
  syncText();
  // Volume fades (Cocos2d-x's AudioEngine has none of its own). Voices that faded out are stopped after the walk,
  // since stopping one can erase map entries through its finish callback.
  std::vector<int> faded;
  for (auto it = _voices.begin(); it != _voices.end();) {
    Voice& v = it->second;
    if (v.duration > 0 && v.time < v.duration) {
      v.time = std::min(v.duration, v.time + dt);
      v.volume = v.from + (v.to - v.from) * (v.time / v.duration);
      AudioEngine::setVolume(v.id, v.volume);
    }
    if (v.stopWhenFaded && v.time >= v.duration) {
      faded.push_back(v.id);
      it = _voices.erase(it);
    } else {
      ++it;
    }
  }
  for (int id : faded) AudioEngine::stop(id);
}

// ---------------- Audio ----------------

void OpenBoneNode::setAudioEnabled(bool enabled) {
  _audioEnabled = enabled;
  if (!enabled) stopAllAudio();
}

// AudioEngine::stop() can run a sound's finish callback right away (FMOD on Linux), and that callback erases the voice
// from _voices: always take voices out of the map before stopping them.
void OpenBoneNode::stopAllAudio() {
  auto voices = std::move(_voices);
  _voices.clear();
  for (auto& v : voices) AudioEngine::stop(v.second.id);
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
      const int id = v.id;
      _voices.erase(it);
      AudioEngine::stop(id);
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
    if (it.text) continue;  // drawn by the Label children (syncText)
    if (_batches.size() <= used) {
      auto b = std::make_unique<Batch>();
      auto* program = backend::Program::getBuiltinProgram(backend::ProgramType::POSITION_TEXTURE_COLOR);
      b->state = new backend::ProgramState(program);
      b->command.getPipelineDescriptor().programState = b->state;
      _batches.push_back(std::move(b));
    }
    Batch& b = *_batches[used++];
    Texture2D* tex = it.texture ? texture(*it.texture) : nullptr;
    if (!tex) tex = _white;
    const bool pma = tex->hasPremultipliedAlpha();
    const size_t n = it.vertices.size() / 2;
    b.verts.resize(n);
    for (size_t i = 0; i < n; i++) {
      auto& v = b.verts[i];
      v.vertices = Vec3(it.vertices[i * 2], it.vertices[i * 2 + 1], 0);
      v.texCoords = Tex2F(i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2] : 0, i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2 + 1] : 0);
      auto ch = [](double x) { return (uint8_t)(x <= 0 ? 0 : x >= 1 ? 255 : x * 255 + 0.5); };
      const float* c = it.isParticles ? &it.colors[i * 4] : nullptr;
      const double r = c ? c[0] : it.color[0], g = c ? c[1] : it.color[1], bl = c ? c[2] : it.color[2];
      const double a = c ? c[3] : it.color[3] * _displayedOpacity / 255.0;
      // Premultiplied textures (Cocos2d-x premultiplies PNGs as it loads them) take a premultiplied vertex colour.
      const double k = pma ? a : 1;
      v.colors = Color4B(ch(r * k), ch(g * k), ch(bl * k), ch(a));
    }
    b.indices.assign(it.indices.begin(), it.indices.end());
    // Blend to match how the texture's pixels are stored: straight alpha blended as straight alpha leaves dark fringes
    // when Cocos2d-x has premultiplied the image (its default for PNGs), so pick the premultiplied forms then.
    BlendFunc blend = pma ? BlendFunc::ALPHA_PREMULTIPLIED : BlendFunc::ALPHA_NON_PREMULTIPLIED;
    if (it.blend == ob::BlendMode::Additive) blend = pma ? BlendFunc{backend::BlendFactor::ONE, backend::BlendFactor::ONE} : BlendFunc::ADDITIVE;
    else if (it.blend == ob::BlendMode::Screen) blend = pma ? BlendFunc{backend::BlendFactor::ONE, backend::BlendFactor::ONE_MINUS_SRC_COLOR} : BlendFunc::ADDITIVE;
    else if (it.blend == ob::BlendMode::Multiply) blend = {backend::BlendFactor::DST_COLOR, backend::BlendFactor::ONE_MINUS_SRC_ALPHA};
    b.state->setUniform(b.state->getUniformLocation("u_MVPMatrix"), projection.m, sizeof(projection.m));
    // Cocos2d-x 4's renderer binds textures from the program state (TrianglesCommand only keeps it for batching).
    b.state->setTexture(b.state->getUniformLocation("u_texture"), 0, tex->getBackendTexture());
    TrianglesCommand::Triangles tris{b.verts.data(), b.indices.data(), (unsigned)b.verts.size(), (unsigned)b.indices.size()};
    b.command.init(_globalZOrder, tex, blend, tris, transform, flags);
    renderer->addCommand(&b.command);
  }
}
