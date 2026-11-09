// SDL2 sample renderer for OpenBone: plays a document's first state machine (or an animation) and draws the runtime's
// draw list with SDL_RenderGeometry. Mouse input goes to the state machine.
//
//   openbone_sdl2 file.obone [--animation name] [--skin name]
//   openbone_sdl2 file.obone --frames 60 --out frame.bmp     (headless: software renderer, no window)
//
// SDL's renderer has no stencil or shaders, so clipping masks and two-colour tint are not applied here and text is
// not rasterised (the Godot extension does all three). Screen blending falls back to additive.
// SPDX-License-Identifier: MIT
#include <SDL.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>

#include "openbone/runtime.hpp"
#include "openbone_assets.hpp"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#include "stb_image.h"

namespace ob = openbone;

namespace {

struct Textures {
  SDL_Renderer* renderer;
  std::string documentPath;
  std::map<std::string, SDL_Texture*> cache;
  bool premultiplied = false;

  SDL_Texture* fromRgba(const uint8_t* px, int w, int h) {
    SDL_Texture* t = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ABGR8888, SDL_TEXTUREACCESS_STATIC, w, h);
    if (!t) return nullptr;
    SDL_UpdateTexture(t, nullptr, px, w * 4);
    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
    return t;
  }

  SDL_Texture* get(const ob::TextureRef& ref) {
    auto it = cache.find(ref.id);
    if (it != cache.end()) return it->second;
    SDL_Texture* tex = nullptr;
    if (ref.id == ob::PARTICLE_DOT_TEXTURE) {
      const auto px = ob::assets::particleDot();
      tex = fromRgba(px.data(), ob::PARTICLE_DOT_SIZE, ob::PARTICLE_DOT_SIZE);
    } else if (ref.src) {
      const auto bytes = ob::assets::readSource(*ref.src, documentPath);
      int w, h, n;
      if (unsigned char* px = bytes.empty() ? nullptr : stbi_load_from_memory(bytes.data(), (int)bytes.size(), &w, &h, &n, 4)) {
        if (premultiplied)  // straight alpha for SDL's blend modes
          for (int i = 0; i < w * h; i++) {
            unsigned char* p = px + i * 4;
            if (p[3] && p[3] < 255)
              for (int k = 0; k < 3; k++) p[k] = (unsigned char)std::min(255, p[k] * 255 / p[3]);
          }
        tex = fromRgba(px, w, h);
        stbi_image_free(px);
      }
    }
    cache[ref.id] = tex;
    return tex;
  }

  ~Textures() {
    for (auto& t : cache)
      if (t.second) SDL_DestroyTexture(t.second);
  }
};

SDL_BlendMode blendOf(ob::BlendMode b) {
  switch (b) {
    case ob::BlendMode::Additive:
    case ob::BlendMode::Screen: return SDL_BLENDMODE_ADD;
    case ob::BlendMode::Multiply: return SDL_BLENDMODE_MUL;
    default: return SDL_BLENDMODE_BLEND;
  }
}

/** Draw the instance with the skeleton origin at (ox, oy) in window pixels, y up. */
void draw(SDL_Renderer* r, Textures& textures, const ob::Instance& inst, float ox, float oy, float scale) {
  const ob::DrawList list = inst.drawList();
  std::vector<SDL_Vertex> verts;
  std::vector<int> indices;
  for (const ob::DrawItem& it : list.items) {
    if (it.text) continue;
    SDL_Texture* tex = it.texture ? textures.get(*it.texture) : nullptr;
    const size_t n = it.vertices.size() / 2;
    verts.resize(n);
    for (size_t i = 0; i < n; i++) {
      SDL_Vertex& v = verts[i];
      v.position = {ox + it.vertices[i * 2] * scale, oy - it.vertices[i * 2 + 1] * scale};
      v.tex_coord = {i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2] : 0.f, i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2 + 1] : 0.f};
      const float* c = it.isParticles ? &it.colors[i * 4] : nullptr;
      auto ch = [](double x) { return Uint8(x <= 0 ? 0 : x >= 1 ? 255 : x * 255 + 0.5); };
      v.color = c ? SDL_Color{ch(c[0]), ch(c[1]), ch(c[2]), ch(c[3])} : SDL_Color{ch(it.color[0]), ch(it.color[1]), ch(it.color[2]), ch(it.color[3])};
    }
    indices.assign(it.indices.begin(), it.indices.end());
    if (tex) SDL_SetTextureBlendMode(tex, blendOf(it.blend));
    else SDL_SetRenderDrawBlendMode(r, blendOf(it.blend));
    SDL_RenderGeometry(r, tex, verts.data(), (int)verts.size(), indices.data(), (int)indices.size());
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s file.obone [--animation name] [--skin name] [--frames n --out frame.bmp]\n", argv[0]);
    return 2;
  }
  std::string path = argv[1], animation, skin, out;
  int frames = 0;
  for (int i = 2; i + 1 < argc; i += 2) {
    const std::string k = argv[i];
    if (k == "--animation") animation = argv[i + 1];
    else if (k == "--skin") skin = argv[i + 1];
    else if (k == "--frames") frames = std::atoi(argv[i + 1]);
    else if (k == "--out") out = argv[i + 1];
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
  inst.onEvent = [](const ob::FiredEvent& e) { std::printf("event %s t=%.3f\n", e.name.c_str(), e.time); };
  inst.onAudio = [](const ob::AudioCommand& c) {
    if (c.type == ob::AudioCommand::Type::Play) std::printf("audio play %s (%s)\n", c.sound.c_str(), c.source.c_str());
  };
  inst.advance(0);

  const int W = doc->width > 0 ? (int)doc->width : 800, H = doc->height > 0 ? (int)doc->height : 600;
  const float ox = (float)doc->originX, oy = (float)doc->originY;
  const bool headless = !out.empty();
  if (SDL_Init(headless ? 0 : SDL_INIT_VIDEO) != 0) {
    std::fprintf(stderr, "SDL_Init: %s\n", SDL_GetError());
    return 1;
  }
  SDL_Window* window = nullptr;
  SDL_Surface* surface = nullptr;
  SDL_Renderer* renderer = nullptr;
  if (headless) {
    surface = SDL_CreateRGBSurfaceWithFormat(0, W, H, 32, SDL_PIXELFORMAT_ARGB8888);
    renderer = SDL_CreateSoftwareRenderer(surface);
  } else {
    window = SDL_CreateWindow(("OpenBone — " + doc->name).c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, W, H, SDL_WINDOW_RESIZABLE);
    renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  }
  if (!renderer) {
    std::fprintf(stderr, "renderer: %s\n", SDL_GetError());
    return 1;
  }
  Textures textures{renderer, path};
  textures.premultiplied = doc->atlas && doc->atlas->premultipliedAlpha;

  auto frame = [&] {
    SDL_SetRenderDrawColor(renderer, 40, 44, 52, 255);
    SDL_RenderClear(renderer);
    draw(renderer, textures, inst, ox, oy, 1);
  };

  if (headless) {
    for (int i = 0; i < frames; i++) inst.advance(1.0 / 60);
    frame();
    SDL_RenderPresent(renderer);
    const int rc = SDL_SaveBMP(surface, out.c_str());
    std::printf("%s %d items -> %s\n", rc == 0 ? "wrote" : "failed", (int)inst.drawList().items.size(), out.c_str());
    SDL_DestroyRenderer(renderer);
    SDL_FreeSurface(surface);
    SDL_Quit();
    return rc == 0 ? 0 : 1;
  }

  Uint64 last = SDL_GetPerformanceCounter();
  for (bool running = true; running;) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) running = false;
      else if (e.type == SDL_MOUSEBUTTONDOWN || e.type == SDL_MOUSEBUTTONUP || e.type == SDL_MOUSEMOTION) {
        const int mx = e.type == SDL_MOUSEMOTION ? e.motion.x : e.button.x, my = e.type == SDL_MOUSEMOTION ? e.motion.y : e.button.y;
        const ob::PointerEvent t = e.type == SDL_MOUSEBUTTONDOWN ? ob::PointerEvent::Down : e.type == SDL_MOUSEBUTTONUP ? ob::PointerEvent::Up : ob::PointerEvent::Move;
        inst.pointer(t, mx - ox, oy - my);
      }
    }
    const Uint64 now = SDL_GetPerformanceCounter();
    const double dt = double(now - last) / SDL_GetPerformanceFrequency();
    last = now;
    inst.advance(dt);
    frame();
    SDL_RenderPresent(renderer);
  }
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
