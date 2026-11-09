// SFML 2.6 sample renderer for OpenBone: plays a document's first state machine (or an animation), forwards the mouse,
// and draws the draw list as textured triangle arrays. Two-colour tint uses a small GLSL shader when available.
//
//   openbone_sfml file.obone [--animation name] [--skin name]
//
// SFML 2 has no stencil buffer access, so clipping masks are not applied; text uses sf::Text when a font is given with
// --font path.ttf. Screen blending falls back to additive.
// SPDX-License-Identifier: MIT
#include <SFML/Graphics.hpp>

#include <cstdio>
#include <map>
#include <memory>
#include <string>

#include "openbone/runtime.hpp"
#include "openbone_assets.hpp"

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

class OpenBoneDrawable : public sf::Drawable, public sf::Transformable {
 public:
  OpenBoneDrawable(ob::Instance& inst, Textures& textures, sf::Shader* darkShader, const sf::Font* font)
      : inst(inst), textures(textures), darkShader(darkShader), font(font) {}

 private:
  ob::Instance& inst;
  Textures& textures;
  sf::Shader* darkShader;
  const sf::Font* font;

  void draw(sf::RenderTarget& target, sf::RenderStates states) const override {
    // Skeleton space is y-up: flip into SFML's y-down space.
    states.transform *= getTransform();
    states.transform.scale(1, -1);
    const ob::DrawList list = inst.drawList();
    const bool pma = inst.doc->atlas && inst.doc->atlas->premultipliedAlpha;
    for (const ob::DrawItem& it : list.items) {
      if (it.text) {
        if (!font) continue;
        const ob::TextDraw& t = *it.text;
        sf::Text text(sf::String::fromUtf8(t.content.begin(), t.content.end()), *font, (unsigned)t.size);
        text.setFillColor(colorOf(t.fill[0] * it.color[0], t.fill[1] * it.color[1], t.fill[2] * it.color[2], t.fill[3] * it.color[3]));
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

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s file.obone [--animation name] [--skin name] [--font file.ttf]\n", argv[0]);
    return 2;
  }
  std::string path = argv[1], animation, skin, fontPath;
  for (int i = 2; i + 1 < argc; i += 2) {
    const std::string k = argv[i];
    if (k == "--animation") animation = argv[i + 1];
    else if (k == "--skin") skin = argv[i + 1];
    else if (k == "--font") fontPath = argv[i + 1];
  }
  std::shared_ptr<const ob::Document> doc;
  try {
    doc = ob::loadFile(path);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "%s\n", e.what());
    return 1;
  }
  ob::Instance inst(doc, ob::createQuickJsHost());
  if (!skin.empty()) inst.skeleton->setSkin(skin);
  if (animation.empty() && !doc->stateMachines.empty()) inst.useStateMachine();
  else if (!doc->animations.empty()) inst.play(animation.empty() ? doc->animations[0].name : animation);
  inst.onEvent = [](const ob::FiredEvent& e) { std::printf("event %s\n", e.name.c_str()); };
  inst.advance(0);

  const unsigned W = doc->width > 0 ? unsigned(doc->width) : 800, H = doc->height > 0 ? unsigned(doc->height) : 600;
  sf::RenderWindow window(sf::VideoMode(W, H), "OpenBone - " + doc->name);
  window.setVerticalSyncEnabled(true);
  Textures textures{path, {}};
  sf::Shader shader;
  sf::Shader* darkShader = sf::Shader::isAvailable() && shader.loadFromMemory(DARK_SHADER, sf::Shader::Fragment) ? &shader : nullptr;
  sf::Font font;
  const sf::Font* fontPtr = !fontPath.empty() && font.loadFromFile(fontPath) ? &font : nullptr;
  OpenBoneDrawable drawable(inst, textures, darkShader, fontPtr);
  drawable.setPosition(float(doc->originX), float(doc->originY));

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
    inst.advance(clock.restart().asSeconds());
    window.clear(sf::Color(40, 44, 52));
    window.draw(drawable);
    window.display();
  }
  return 0;
}
