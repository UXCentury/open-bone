// SDL2 sample renderer for OpenBone: plays a document's first state machine (or an animation) and draws the runtime's
// draw list with SDL_RenderGeometry. Mouse input goes to the state machine.
//
//   openbone_sdl2 file.obone [--animation name] [--skin name]
//   openbone_sdl2 file.obone --frames 60 --out frame.bmp     (headless: software renderer, no window)
//
// SDL's renderer has no stencil or shaders, so clipping masks and two-colour tint are not applied here and text is
// not rasterised (the Godot extension does all three). Screen blending falls back to additive.
//
// Sounds play through SDL's own audio: WAV files (SDL_LoadWAV_RW, converted to the device format once) mixed in the
// audio callback with per-voice gain (volume × bus × master), looping and rate (linear-interpolation resampling);
// fades are stepped every frame (engines/common/openbone_audio.hpp). Other formats are skipped with a message.
// --mute turns sound off; the audio commands are printed either way. Headless runs are silent.
// SPDX-License-Identifier: MIT
#include <SDL.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"
#include "openbone_assets.hpp"
#include "openbone_audio.hpp"

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

/** A small software mixer on an SDL audio device: the Output of the shared ob::audio::Mixer. */
class SdlAudio : public ob::audio::Output {
 public:
  explicit SdlAudio(std::string documentPath) : documentPath_(std::move(documentPath)) {}
  ~SdlAudio() override { close(); }

  /** Open the default device (float stereo; SDL converts if the hardware differs). */
  bool open() {
    SDL_AudioSpec want{};
    want.freq = 48000;
    want.format = AUDIO_F32SYS;
    want.channels = 2;
    want.samples = 1024;
    want.callback = &SdlAudio::callback;
    want.userdata = this;
    dev_ = SDL_OpenAudioDevice(nullptr, 0, &want, &spec_, 0);
    if (!dev_) {
      std::fprintf(stderr, "no audio device (%s): sounds are off\n", SDL_GetError());
      return false;
    }
    SDL_PauseAudioDevice(dev_, 0);
    return true;
  }

  void close() {
    if (dev_) SDL_CloseAudioDevice(dev_);
    dev_ = 0;
    voices_.clear();
  }

  bool start(int voice, const ob::AudioAsset& asset, double gain, double rate, bool loop) override {
    std::shared_ptr<const Clip> c = clip(asset);
    if (!c || c->frames() == 0) return false;
    Voice v;
    v.clip = std::move(c);
    v.rate = rate;
    v.gain = v.current = float(gain);
    v.loop = loop;
    SDL_LockAudioDevice(dev_);
    voices_[voice] = std::move(v);
    SDL_UnlockAudioDevice(dev_);
    return true;
  }

  void setGain(int voice, double gain) override {
    SDL_LockAudioDevice(dev_);
    auto it = voices_.find(voice);
    if (it != voices_.end()) it->second.gain = float(gain);
    SDL_UnlockAudioDevice(dev_);
  }

  void stop(int voice) override {
    SDL_LockAudioDevice(dev_);
    voices_.erase(voice);
    SDL_UnlockAudioDevice(dev_);
  }

  /** Release voices that played to their end and tell the mixer. */
  void poll(ob::audio::Mixer& mixer) {
    std::vector<int> done;
    SDL_LockAudioDevice(dev_);
    for (auto it = voices_.begin(); it != voices_.end();) {
      if (it->second.done) {
        done.push_back(it->first);
        it = voices_.erase(it);
      } else ++it;
    }
    SDL_UnlockAudioDevice(dev_);
    for (int v : done) mixer.voiceFinished(v);
  }

 private:
  /** Interleaved stereo float samples at the device rate. */
  struct Clip {
    std::vector<float> samples;
    size_t frames() const { return samples.size() / 2; }
  };
  struct Voice {
    std::shared_ptr<const Clip> clip;
    double pos = 0, rate = 1;
    float gain = 0, current = 0;  // target (main thread) and the gain the callback reached
    bool loop = false, done = false;
  };

  std::shared_ptr<const Clip> clip(const ob::AudioAsset& asset) {
    auto found = clips_.find(asset.id);
    if (found != clips_.end()) return found->second;
    std::shared_ptr<Clip> c;
    const auto bytes = ob::assets::readSource(asset.src, documentPath_);
    SDL_AudioSpec wav{};
    Uint8* buf = nullptr;
    Uint32 len = 0;
    SDL_RWops* rw = bytes.empty() ? nullptr : SDL_RWFromConstMem(bytes.data(), (int)bytes.size());
    if (!rw || !SDL_LoadWAV_RW(rw, 1, &wav, &buf, &len)) {
      std::fprintf(stderr, "sound \"%s\" skipped: the SDL2 sample plays WAV files only (%s)\n", asset.name.c_str(),
                   bytes.empty() ? "cannot read it" : SDL_GetError());
    } else {
      SDL_AudioCVT cvt;
      const int need = SDL_BuildAudioCVT(&cvt, wav.format, wav.channels, wav.freq, AUDIO_F32SYS, 2, spec_.freq);
      if (need >= 0) {
        std::vector<Uint8> work(size_t(len) * size_t(need > 0 ? cvt.len_mult : 1));
        std::memcpy(work.data(), buf, len);
        size_t out = len;
        if (need > 0) {
          cvt.buf = work.data();
          cvt.len = (int)len;
          if (SDL_ConvertAudio(&cvt) == 0) out = size_t(cvt.len_cvt);
          else out = 0;
        }
        c = std::make_shared<Clip>();
        c->samples.resize(out / sizeof(float));
        std::memcpy(c->samples.data(), work.data(), c->samples.size() * sizeof(float));
      }
      SDL_FreeWAV(buf);
    }
    clips_[asset.id] = c;
    return c;
  }

  static void callback(void* user, Uint8* stream, int len) {
    auto* self = static_cast<SdlAudio*>(user);
    float* out = reinterpret_cast<float*>(stream);
    const int n = len / int(sizeof(float) * 2);
    std::fill(out, out + n * 2, 0.f);
    for (auto& [id, v] : self->voices_) {
      if (v.done) continue;
      const float* s = v.clip->samples.data();
      const size_t frames = v.clip->frames();
      const float g0 = v.current, g1 = v.gain;  // ramp across the buffer: no clicks when the gain steps
      for (int i = 0; i < n; i++) {
        const size_t a = size_t(v.pos);
        const size_t b = a + 1 < frames ? a + 1 : v.loop ? 0 : a;
        const float t = float(v.pos - double(a)), g = g0 + (g1 - g0) * float(i + 1) / float(n);
        out[i * 2] += (s[a * 2] + (s[b * 2] - s[a * 2]) * t) * g;
        out[i * 2 + 1] += (s[a * 2 + 1] + (s[b * 2 + 1] - s[a * 2 + 1]) * t) * g;
        v.pos += v.rate;
        if (v.pos >= double(frames)) {
          if (!v.loop) {
            v.done = true;
            break;
          }
          v.pos = std::fmod(v.pos, double(frames));
        }
      }
      v.current = g1;
    }
    for (int i = 0; i < n * 2; i++) out[i] = std::clamp(out[i], -1.f, 1.f);
  }

  std::string documentPath_;
  SDL_AudioDeviceID dev_ = 0;
  SDL_AudioSpec spec_{};
  std::map<std::string, std::shared_ptr<const Clip>> clips_;  // null = cannot be played
  std::map<int, Voice> voices_;                               // shared with the callback: lock the device
};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s file.obone [--animation name] [--skin name] [--mute] [--frames n --out frame.bmp]\n", argv[0]);
    return 2;
  }
  std::string path = argv[1], animation, skin, out;
  int frames = 0;
  bool mute = false;
  for (int i = 2; i < argc; i++) {
    const std::string k = argv[i];
    if (k == "--mute") mute = true;
    else if (i + 1 >= argc) break;
    else if (k == "--animation") animation = argv[++i];
    else if (k == "--skin") skin = argv[++i];
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
  const bool headless = !out.empty();
  // Declared before the instance so they outlive its audio callback.
  SdlAudio audioOut(path);
  std::unique_ptr<ob::audio::Mixer> audio;
  if (!headless && !mute) {
    if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) std::fprintf(stderr, "SDL audio: %s (sounds are off)\n", SDL_GetError());
    else if (audioOut.open()) audio = std::make_unique<ob::audio::Mixer>(doc, audioOut);
  }
  ob::Instance inst(doc, ob::createQuickJsHost());
  if (!skin.empty()) inst.skeleton->setSkin(skin);
  if (animation.empty() && !doc->stateMachines.empty()) inst.useStateMachine();
  else if (!doc->animations.empty()) inst.play(animation.empty() ? doc->animations[0].name : animation);
  inst.onEvent = [](const ob::FiredEvent& e) { std::printf("event %s t=%.3f\n", e.name.c_str(), e.time); };
  inst.onAudio = [&](const ob::AudioCommand& c) {
    if (c.type == ob::AudioCommand::Type::Play) std::printf("audio play %s (%s)\n", c.sound.c_str(), c.source.c_str());
    if (audio) audio->handle(c);
  };
  inst.advance(0);

  const int W = doc->width > 0 ? (int)doc->width : 800, H = doc->height > 0 ? (int)doc->height : 600;
  const float ox = (float)doc->originX, oy = (float)doc->originY;
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
    if (audio) {
      audio->update(dt);
      audioOut.poll(*audio);
    }
    frame();
    SDL_RenderPresent(renderer);
  }
  if (audio) audio->stopAll();
  audioOut.close();
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
