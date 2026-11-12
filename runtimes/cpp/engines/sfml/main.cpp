// SFML 2.6 sample renderer for OpenBone: plays a document's first state machine (or an animation), forwards the mouse,
// and draws the draw list as textured triangle arrays. Two-colour tint uses a small GLSL shader when available.
//
//   openbone_sfml file.obone [--animation name] [--skin name] [--font file.ttf]
//   openbone_sfml file.obone --frames 60 --out frame.png      (offscreen sf::RenderTexture, no window)
//
// SFML 2 has no stencil buffer access, so clipping masks are not applied. Text uses sf::Text with the document's own
// fonts (the first family of a text's font list the document ships, closest weight) and otherwise the --font path.ttf
// (SFML can't look up installed fonts); text without either is skipped. Screen blending falls back to additive.
//
// Sounds play through sf::SoundBuffer / sf::Sound (built with OPENBONE_SFML_AUDIO): volume × bus × master, rate as
// pitch, looping and fades stepped every frame (engines/common/openbone_audio.hpp). --mute turns them off; the audio
// commands are printed either way.
// SPDX-License-Identifier: MIT
#include <SFML/Graphics.hpp>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"
#include "openbone_assets.hpp"

#if OPENBONE_SFML_AUDIO
#include <SFML/Audio.hpp>

#include "openbone_audio.hpp"
#endif

namespace ob = openbone;

namespace {

const char* DARK_SHADER = R"(
uniform sampler2D texture;
uniform vec3 dark;
uniform float premultiplied;
void main() {
  vec4 tex = texture2D(texture, gl_TexCoord[0].xy);
  if (premultiplied > 0.5 && tex.a > 0.0) tex.rgb /= tex.a;
  gl_FragColor = vec4(dark + (gl_Color.rgb - dark) * tex.rgb, tex.a * gl_Color.a);
}
)";

struct Textures {
  std::string documentPath;
  std::map<std::string, std::unique_ptr<sf::Texture>> cache;
  const sf::Texture* get(const ob::TextureRef& ref) {
    auto it = cache.find(ref.id);
    if (it != cache.end()) return it->second.get();
    auto tex = std::make_unique<sf::Texture>();
    bool ok = false;
    if (ref.id == ob::PARTICLE_DOT_TEXTURE) {
      sf::Image img;
      const auto px = ob::assets::particleDot();
      img.create(ob::PARTICLE_DOT_SIZE, ob::PARTICLE_DOT_SIZE, px.data());
      ok = tex->loadFromImage(img);
    } else if (ref.src) {
      const auto bytes = ob::assets::readSource(*ref.src, documentPath);
      ok = !bytes.empty() && tex->loadFromMemory(bytes.data(), bytes.size());
    }
    tex->setSmooth(true);
    const sf::Texture* out = ok ? tex.get() : nullptr;
    cache[ref.id] = ok ? std::move(tex) : nullptr;
    return out;
  }
};

sf::BlendMode blendOf(ob::BlendMode b) {
  switch (b) {
    case ob::BlendMode::Additive:
    case ob::BlendMode::Screen: return sf::BlendAdd;
    case ob::BlendMode::Multiply: return sf::BlendMultiply;
    default: return sf::BlendAlpha;
  }
}

sf::Color colorOf(double r, double g, double b, double a) {
  auto ch = [](double x) { return sf::Uint8(x <= 0 ? 0 : x >= 1 ? 255 : x * 255 + 0.5); };
  return sf::Color(ch(r), ch(g), ch(b), ch(a));
}

/** sf::Font per document font (loaded from memory, so the bytes stay alive with it), falling back to --font. */
struct Fonts {
  std::shared_ptr<const ob::Document> doc;
  std::string documentPath;
  const sf::Font* fallback = nullptr;
  struct Entry {
    std::vector<uint8_t> bytes;  // sf::Font reads from these while it lives
    sf::Font font;
    bool ok = false;
  };
  std::map<std::string, std::unique_ptr<Entry>> cache;  // by font id
  const sf::Font* forText(const std::string& families, double weight) {
    for (const std::string& family : ob::splitFontFamilies(families)) {
      const ob::FontAsset* asset = doc->findFont(family, weight);
      if (!asset) continue;
      auto& e = cache[asset->id];
      if (!e) {
        e = std::make_unique<Entry>();
        e->bytes = ob::assets::readSource(asset->src, documentPath);
        e->ok = !e->bytes.empty() && e->font.loadFromMemory(e->bytes.data(), e->bytes.size());
        if (!e->ok) std::fprintf(stderr, "cannot load font %s (%s)\n", asset->family.c_str(), asset->name.c_str());
      }
      if (e->ok) return &e->font;
    }
    return fallback;
  }
};

class OpenBoneDrawable : public sf::Drawable, public sf::Transformable {
 public:
  OpenBoneDrawable(ob::Instance& inst, Textures& textures, sf::Shader* darkShader, Fonts& fonts)
      : inst(inst), textures(textures), darkShader(darkShader), fonts(fonts) {}

 private:
  ob::Instance& inst;
  Textures& textures;
  sf::Shader* darkShader;
  Fonts& fonts;

  void draw(sf::RenderTarget& target, sf::RenderStates states) const override {
    // Skeleton space is y-up: flip into SFML's y-down space.
    states.transform *= getTransform();
    states.transform.scale(1, -1);
    const ob::DrawList list = inst.drawList();
    const bool pma = inst.doc->atlas && inst.doc->atlas->premultipliedAlpha;
    for (const ob::DrawItem& it : list.items) {
      if (it.text) {
        const ob::TextDraw& t = *it.text;
        const sf::Font* font = fonts.forText(t.font, t.weight);
        if (!font) continue;
        sf::Text text(sf::String::fromUtf8(t.content.begin(), t.content.end()), *font, (unsigned)t.size);
        text.setFillColor(colorOf(t.fill[0] * it.color[0], t.fill[1] * it.color[1], t.fill[2] * it.color[2], t.fill[3] * it.color[3]));
        // Outline outside the glyphs by outlineWidth: the web player's canvas stroke (2 × outlineWidth, half outside).
        if (t.outline && t.outlineWidth > 0) {
          const ob::RGBA& o = *t.outline;
          text.setOutlineColor(colorOf(o[0] * it.color[0], o[1] * it.color[1], o[2] * it.color[2], o[3] * it.color[3]));
          text.setOutlineThickness(float(t.outlineWidth));
        }
        const sf::FloatRect b = text.getLocalBounds();
        const float x = t.align == ob::TextAlign::Left ? -t.width / 2 : t.align == ob::TextAlign::Right ? t.width / 2 - b.width : -b.width / 2;
        text.setPosition(x - b.left, -b.height / 2 - b.top);
        sf::RenderStates ts = states;
        const ob::Affine& m = t.matrix;
        // Box frame (y down) → skeleton (y up) → screen: flip on both sides of the text matrix.
        ts.transform *= sf::Transform(float(m.a), float(-m.b), float(m.x), float(m.c), float(-m.d), float(m.y), 0, 0, 1);
        target.draw(text, ts);
        continue;
      }
      const sf::Texture* tex = it.texture ? textures.get(*it.texture) : nullptr;
      const sf::Vector2f size = tex ? sf::Vector2f(tex->getSize()) : sf::Vector2f(1, 1);
      sf::VertexArray va(sf::Triangles, it.indices.size());
      for (size_t k = 0; k < it.indices.size(); k++) {
        const size_t i = it.indices[k];
        sf::Vertex& v = va[k];
        v.position = {it.vertices[i * 2], it.vertices[i * 2 + 1]};
        if (i * 2 + 1 < it.uvs.size()) v.texCoords = {it.uvs[i * 2] * size.x, it.uvs[i * 2 + 1] * size.y};
        v.color = it.isParticles ? colorOf(it.colors[i * 4], it.colors[i * 4 + 1], it.colors[i * 4 + 2], it.colors[i * 4 + 3])
                                 : colorOf(it.color[0], it.color[1], it.color[2], it.color[3]);
      }
      sf::RenderStates rs = states;
      rs.texture = tex;
      rs.blendMode = blendOf(it.blend);
      if (tex && it.dark && darkShader) {
        darkShader->setUniform("texture", sf::Shader::CurrentTexture);
        darkShader->setUniform("dark", sf::Glsl::Vec3(float((*it.dark)[0]), float((*it.dark)[1]), float((*it.dark)[2])));
        darkShader->setUniform("premultiplied", pma ? 1.f : 0.f);
        rs.shader = darkShader;
      }
      target.draw(va, rs);
    }
  }
};

#if OPENBONE_SFML_AUDIO
/** sf::Sound voices for the shared mixer: one sf::SoundBuffer per asset (WAV, OGG, FLAC, MP3), pitch = rate. */
struct SfmlAudio : ob::audio::Output {
  std::string documentPath;
  std::map<std::string, std::unique_ptr<sf::SoundBuffer>> buffers;  // null = cannot be loaded
  std::map<int, std::unique_ptr<sf::Sound>> voices;                 // declared after buffers: destroyed first

  explicit SfmlAudio(std::string path) : documentPath(std::move(path)) {}

  const sf::SoundBuffer* buffer(const ob::AudioAsset& a) {
    auto it = buffers.find(a.id);
    if (it != buffers.end()) return it->second.get();
    auto b = std::make_unique<sf::SoundBuffer>();
    const auto bytes = ob::assets::readSource(a.src, documentPath);
    if (bytes.empty() || !b->loadFromMemory(bytes.data(), bytes.size())) {
      std::fprintf(stderr, "cannot load sound \"%s\" (%.60s)\n", a.name.c_str(), a.src.c_str());
      b.reset();
    }
    return (buffers[a.id] = std::move(b)).get();
  }

  static float volumeOf(double gain) { return float(std::clamp(gain, 0.0, 1.0) * 100); }

  bool start(int voice, const ob::AudioAsset& asset, double gain, double rate, bool loop) override {
    const sf::SoundBuffer* b = buffer(asset);
    if (!b) return false;
    auto s = std::make_unique<sf::Sound>(*b);
    s->setVolume(volumeOf(gain));
    s->setPitch(float(rate));
    s->setLoop(loop);
    s->play();
    voices[voice] = std::move(s);
    return true;
  }

  void setGain(int voice, double gain) override {
    auto it = voices.find(voice);
    if (it != voices.end()) it->second->setVolume(volumeOf(gain));
  }

  void stop(int voice) override {
    auto it = voices.find(voice);
    if (it == voices.end()) return;
    it->second->stop();
    voices.erase(it);
  }

  /** Release voices whose sound reached its end and tell the mixer. */
  void poll(ob::audio::Mixer& mixer) {
    for (auto it = voices.begin(); it != voices.end();) {
      if (it->second->getStatus() != sf::Sound::Stopped) {
        ++it;
        continue;
      }
      const int voice = it->first;
      it = voices.erase(it);
      mixer.voiceFinished(voice);
    }
  }
};
#endif

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s file.obone [--animation name] [--skin name] [--font file.ttf] [--mute]\n", argv[0]);
    return 2;
  }
  std::string path = argv[1], animation, skin, fontPath, out;
  int frames = 0;
  bool mute = false;
  for (int i = 2; i < argc; i++) {
    const std::string k = argv[i];
    if (k == "--mute") mute = true;
    else if (i + 1 >= argc) break;
    else if (k == "--animation") animation = argv[++i];
    else if (k == "--skin") skin = argv[++i];
    else if (k == "--font") fontPath = argv[++i];
    else if (k == "--frames") frames = std::atoi(argv[++i]);
    else if (k == "--out") out = argv[++i];
  }
  std::shared_ptr<const ob::Document> doc;
  try {
    doc = ob::loadFile(path);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "%s\n", e.what());
    return 1;
  }
#if OPENBONE_SFML_AUDIO
  // Declared before the instance so they outlive its audio callback. Offscreen renders (--out) stay silent.
  SfmlAudio audioOut(path);
  std::unique_ptr<ob::audio::Mixer> audio = mute || !out.empty() ? nullptr : std::make_unique<ob::audio::Mixer>(doc, audioOut);
#else
  (void)mute;
#endif
  ob::Instance inst(doc, ob::createQuickJsHost());
  if (!skin.empty()) inst.skeleton->setSkin(skin);
  if (animation.empty() && !doc->stateMachines.empty()) inst.useStateMachine();
  else if (!doc->animations.empty()) inst.play(animation.empty() ? doc->animations[0].name : animation);
  inst.onEvent = [](const ob::FiredEvent& e) { std::printf("event %s\n", e.name.c_str()); };
  inst.onAudio = [&](const ob::AudioCommand& c) {
    if (c.type == ob::AudioCommand::Type::Play) std::printf("audio play %s (%s)\n", c.sound.c_str(), c.source.c_str());
#if OPENBONE_SFML_AUDIO
    if (audio) audio->handle(c);
#endif
  };
  inst.advance(0);

  const unsigned W = doc->width > 0 ? unsigned(doc->width) : 800, H = doc->height > 0 ? unsigned(doc->height) : 600;
  Textures textures{path, {}};
  sf::Shader shader;
  sf::Shader* darkShader = sf::Shader::isAvailable() && shader.loadFromMemory(DARK_SHADER, sf::Shader::Fragment) ? &shader : nullptr;
  sf::Font font;
  Fonts fonts{doc, path, !fontPath.empty() && font.loadFromFile(fontPath) ? &font : nullptr, {}};
  OpenBoneDrawable drawable(inst, textures, darkShader, fonts);
  drawable.setPosition(float(doc->originX), float(doc->originY));

  if (!out.empty()) {
    sf::RenderTexture rt;
    if (!rt.create(W, H)) return 1;
    for (int i = 0; i < frames; i++) inst.advance(1.0 / 60);
    rt.clear(sf::Color(40, 44, 52));
    rt.draw(drawable);
    rt.display();
    const bool ok = rt.getTexture().copyToImage().saveToFile(out);
    std::printf("%s %d items -> %s\n", ok ? "wrote" : "failed", (int)inst.drawList().items.size(), out.c_str());
    return ok ? 0 : 1;
  }

  sf::RenderWindow window(sf::VideoMode(W, H), "OpenBone - " + doc->name);
  window.setVerticalSyncEnabled(true);
  sf::Clock clock;
  while (window.isOpen()) {
    sf::Event e;
    while (window.pollEvent(e)) {
      if (e.type == sf::Event::Closed) window.close();
      else if (e.type == sf::Event::MouseButtonPressed || e.type == sf::Event::MouseButtonReleased || e.type == sf::Event::MouseMoved) {
        const sf::Vector2i p = e.type == sf::Event::MouseMoved ? sf::Vector2i(e.mouseMove.x, e.mouseMove.y) : sf::Vector2i(e.mouseButton.x, e.mouseButton.y);
        const sf::Vector2f w = window.mapPixelToCoords(p);
        const ob::PointerEvent t = e.type == sf::Event::MouseButtonPressed ? ob::PointerEvent::Down
                                 : e.type == sf::Event::MouseButtonReleased ? ob::PointerEvent::Up
                                                                            : ob::PointerEvent::Move;
        inst.pointer(t, w.x - doc->originX, doc->originY - w.y);
      }
    }
    const float dt = clock.restart().asSeconds();
    inst.advance(dt);
#if OPENBONE_SFML_AUDIO
    if (audio) {
      audio->update(dt);
      audioOut.poll(*audio);
    }
#endif
    window.clear(sf::Color(40, 44, 52));
    window.draw(drawable);
    window.display();
  }
#if OPENBONE_SFML_AUDIO
  if (audio) audio->stopAll();
#endif
  return 0;
}
