// GLFW + OpenGL 3.3 sample renderer for OpenBone: plays a document's first state machine (or an animation) and draws
// the runtime's draw list with the same shader and blending as the WebGL2 renderer: two-colour tint, premultiplied
// atlas pages, normal / additive / multiply / screen blending and stencil clipping masks. Mouse input goes to the
// state machine.
//
//   openbone_glfw file.obone [--animation name] [--skin name]
//   openbone_glfw file.obone --frames 60 --out frame.png      (renders into a hidden window and saves a PNG)
//
// Text items are not rasterised here (the Godot extension and the web renderers draw text), and sound commands are
// printed rather than played (GLFW has no audio; see the SFML and SDL2 samples).
// SPDX-License-Identifier: MIT
#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"
#include "openbone_assets.hpp"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace ob = openbone;

// ---------------- The OpenGL 3.3 core subset this sample uses, loaded through glfwGetProcAddress ----------------

using GLenum = unsigned int;
using GLuint = unsigned int;
using GLint = int;
using GLsizei = int;
using GLboolean = unsigned char;
using GLbitfield = unsigned int;
using GLfloat = float;
using GLchar = char;
using GLsizeiptr = std::ptrdiff_t;

enum : GLenum {
  GL_TRIANGLES = 0x0004, GL_UNSIGNED_SHORT = 0x1403, GL_FLOAT = 0x1406, GL_UNSIGNED_BYTE = 0x1401,
  GL_COLOR_BUFFER_BIT = 0x4000, GL_STENCIL_BUFFER_BIT = 0x0400, GL_BLEND = 0x0BE2, GL_STENCIL_TEST = 0x0B90,
  GL_ZERO = 0, GL_ONE = 1, GL_SRC_COLOR = 0x0300, GL_ONE_MINUS_SRC_COLOR = 0x0301, GL_ONE_MINUS_SRC_ALPHA = 0x0303,
  GL_DST_COLOR = 0x0306, GL_ALWAYS = 0x0207, GL_EQUAL = 0x0202, GL_KEEP = 0x1E00, GL_REPLACE = 0x1E01,
  GL_TEXTURE_2D = 0x0DE1, GL_RGBA = 0x1908, GL_RGBA8 = 0x8058, GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800,
  GL_LINEAR = 0x2601, GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803, GL_CLAMP_TO_EDGE = 0x812F, GL_TEXTURE0 = 0x84C0,
  GL_ARRAY_BUFFER = 0x8892, GL_ELEMENT_ARRAY_BUFFER = 0x8893, GL_STREAM_DRAW = 0x88E0, GL_VERTEX_SHADER = 0x8B31,
  GL_FRAGMENT_SHADER = 0x8B30, GL_COMPILE_STATUS = 0x8B81, GL_LINK_STATUS = 0x8B82, GL_PACK_ALIGNMENT = 0x0D05,
  GL_UNPACK_ALIGNMENT = 0x0CF5,
};

#define GL_FUNCS(X)                                                                                  \
  X(void, Viewport, GLint, GLint, GLsizei, GLsizei)                                                  \
  X(void, ClearColor, GLfloat, GLfloat, GLfloat, GLfloat)                                            \
  X(void, ClearStencil, GLint)                                                                       \
  X(void, Clear, GLbitfield)                                                                         \
  X(void, Enable, GLenum)                                                                            \
  X(void, Disable, GLenum)                                                                           \
  X(void, BlendFunc, GLenum, GLenum)                                                                 \
  X(void, ColorMask, GLboolean, GLboolean, GLboolean, GLboolean)                                     \
  X(void, StencilFunc, GLenum, GLint, GLuint)                                                        \
  X(void, StencilOp, GLenum, GLenum, GLenum)                                                         \
  X(void, GenTextures, GLsizei, GLuint*)                                                             \
  X(void, DeleteTextures, GLsizei, const GLuint*)                                                    \
  X(void, BindTexture, GLenum, GLuint)                                                               \
  X(void, ActiveTexture, GLenum)                                                                     \
  X(void, TexImage2D, GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*)   \
  X(void, TexParameteri, GLenum, GLenum, GLint)                                                      \
  X(void, PixelStorei, GLenum, GLint)                                                                \
  X(void, ReadPixels, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void*)                         \
  X(GLuint, CreateShader, GLenum)                                                                    \
  X(void, ShaderSource, GLuint, GLsizei, const GLchar* const*, const GLint*)                        \
  X(void, CompileShader, GLuint)                                                                     \
  X(void, GetShaderiv, GLuint, GLenum, GLint*)                                                       \
  X(void, GetShaderInfoLog, GLuint, GLsizei, GLsizei*, GLchar*)                                      \
  X(GLuint, CreateProgram)                                                                           \
  X(void, AttachShader, GLuint, GLuint)                                                              \
  X(void, BindAttribLocation, GLuint, GLuint, const GLchar*)                                         \
  X(void, LinkProgram, GLuint)                                                                       \
  X(void, GetProgramiv, GLuint, GLenum, GLint*)                                                      \
  X(void, UseProgram, GLuint)                                                                        \
  X(GLint, GetUniformLocation, GLuint, const GLchar*)                                                \
  X(void, Uniform1i, GLint, GLint)                                                                   \
  X(void, Uniform2f, GLint, GLfloat, GLfloat)                                                        \
  X(void, GenVertexArrays, GLsizei, GLuint*)                                                         \
  X(void, BindVertexArray, GLuint)                                                                   \
  X(void, GenBuffers, GLsizei, GLuint*)                                                              \
  X(void, BindBuffer, GLenum, GLuint)                                                                \
  X(void, BufferData, GLenum, GLsizeiptr, const void*, GLenum)                                       \
  X(void, VertexAttribPointer, GLuint, GLint, GLenum, GLboolean, GLsizei, const void*)              \
  X(void, EnableVertexAttribArray, GLuint)                                                           \
  X(void, DrawElements, GLenum, GLsizei, GLenum, const void*)

#define GL_DECLARE(ret, name, ...) using PFN_gl##name = ret (*)(__VA_ARGS__); PFN_gl##name gl##name = nullptr;
GL_FUNCS(GL_DECLARE)
#undef GL_DECLARE

bool loadGl() {
  bool ok = true;
#define GL_LOAD(ret, name, ...)                                                                  \
  gl##name = reinterpret_cast<PFN_gl##name>(glfwGetProcAddress("gl" #name));                     \
  if (!gl##name) {                                                                               \
    std::fprintf(stderr, "missing OpenGL function gl%s\n", #name);                               \
    ok = false;                                                                                  \
  }
  GL_FUNCS(GL_LOAD)
#undef GL_LOAD
  return ok;
}

namespace {

// The WebGL2 renderer's shaders (packages/render-webgl), as GLSL 3.30. Vertices are skeleton-space x/y; uView maps
// them to clip space. Two-colour tint on a premultiplied texture: rgb = dark * (a - rgb) + light * rgb.
const char* VS = R"(#version 330 core
in vec2 aPos; in vec2 aUv; in vec4 aColor; in vec3 aDark;
uniform vec2 uScale; uniform vec2 uOffset;
out vec2 vUv; out vec4 vColor; out vec3 vDark;
void main() { gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); vUv = aUv; vColor = aColor; vDark = aDark; })";
const char* FS = R"(#version 330 core
in vec2 vUv; in vec4 vColor; in vec3 vDark; uniform sampler2D uTex; out vec4 o;
void main() { vec4 t = texture(uTex, vUv); o = vec4(vDark * (t.a - t.rgb) + t.rgb * vColor.rgb, t.a) * vColor.a; })";

/** Floats per vertex: x, y, u, v, r, g, b, a, dark r, g, b. */
constexpr int STRIDE = 11;

GLuint compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
    glGetShaderInfoLog(s, sizeof log, nullptr, log);
    std::fprintf(stderr, "shader: %s\n", log);
  }
  return s;
}

/** Textures by id, uploaded premultiplied (loose images are premultiplied on load; premultiplied pages as they are). */
struct Textures {
  std::string documentPath;
  bool pagesPremultiplied = false;
  std::map<std::string, GLuint> cache;
  GLuint white = 0;

  GLuint upload(std::vector<uint8_t>& px, int w, int h, bool premultiplied) {
    if (!premultiplied)
      for (size_t i = 0; i < px.size(); i += 4)
        for (int k = 0; k < 3; k++) px[i + k] = uint8_t((px[i + k] * px[i + 3] + 127) / 255);
    GLuint t = 0;
    glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return t;
  }

  GLuint whiteTexture() {
    if (!white) {
      std::vector<uint8_t> px{255, 255, 255, 255};
      white = upload(px, 1, 1, true);
    }
    return white;
  }

  GLuint get(const ob::TextureRef& ref, bool isAtlasPage) {
    auto it = cache.find(ref.id);
    if (it != cache.end()) return it->second;
    GLuint tex = 0;
    if (ref.id == ob::PARTICLE_DOT_TEXTURE) {
      auto px = ob::assets::particleDot();
      tex = upload(px, ob::PARTICLE_DOT_SIZE, ob::PARTICLE_DOT_SIZE, false);
    } else if (ref.src) {
      const auto bytes = ob::assets::readSource(*ref.src, documentPath);
      int w, h, n;
      if (unsigned char* data = bytes.empty() ? nullptr : stbi_load_from_memory(bytes.data(), (int)bytes.size(), &w, &h, &n, 4)) {
        std::vector<uint8_t> px(data, data + size_t(w) * h * 4);
        stbi_image_free(data);
        tex = upload(px, w, h, isAtlasPage && pagesPremultiplied);
      }
    }
    cache[ref.id] = tex;
    return tex;
  }
};

struct Renderer {
  GLuint program = 0, vao = 0, vbo = 0, ibo = 0;
  GLint uScale = -1, uOffset = -1;
  std::vector<float> verts;
  std::vector<uint16_t> idx;

  bool init() {
    program = glCreateProgram();
    glAttachShader(program, compile(GL_VERTEX_SHADER, VS));
    glAttachShader(program, compile(GL_FRAGMENT_SHADER, FS));
    glBindAttribLocation(program, 0, "aPos");
    glBindAttribLocation(program, 1, "aUv");
    glBindAttribLocation(program, 2, "aColor");
    glBindAttribLocation(program, 3, "aDark");
    glLinkProgram(program);
    GLint ok = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if (!ok) return false;
    uScale = glGetUniformLocation(program, "uScale");
    uOffset = glGetUniformLocation(program, "uOffset");
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    glGenBuffers(1, &vbo);
    glGenBuffers(1, &ibo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    const GLsizei s = STRIDE * sizeof(float);
    glVertexAttribPointer(0, 2, GL_FLOAT, 0, s, (void*)0);
    glVertexAttribPointer(1, 2, GL_FLOAT, 0, s, (void*)(2 * sizeof(float)));
    glVertexAttribPointer(2, 4, GL_FLOAT, 0, s, (void*)(4 * sizeof(float)));
    glVertexAttribPointer(3, 3, GL_FLOAT, 0, s, (void*)(8 * sizeof(float)));
    for (GLuint i = 0; i < 4; i++) glEnableVertexAttribArray(i);
    glUseProgram(program);
    glUniform1i(glGetUniformLocation(program, "uTex"), 0);
    return true;
  }

  void drawTriangles(GLuint tex) {
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, tex);
    glBufferData(GL_ARRAY_BUFFER, GLsizeiptr(verts.size() * sizeof(float)), verts.data(), GL_STREAM_DRAW);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, GLsizeiptr(idx.size() * sizeof(uint16_t)), idx.data(), GL_STREAM_DRAW);
    glDrawElements(GL_TRIANGLES, GLsizei(idx.size()), GL_UNSIGNED_SHORT, nullptr);
  }

  static void blend(ob::BlendMode b) {
    switch (b) {
      case ob::BlendMode::Additive: glBlendFunc(GL_ONE, GL_ONE); break;
      case ob::BlendMode::Multiply: glBlendFunc(GL_DST_COLOR, GL_ONE_MINUS_SRC_ALPHA); break;
      case ob::BlendMode::Screen: glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_COLOR); break;
      default: glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA); break;
    }
  }

  /** Writes a clipping mask into the stencil buffer (1 inside), then draws only where it is set. */
  void setClip(const ob::ClipRegion* clip, Textures& textures) {
    if (!clip) {
      glDisable(GL_STENCIL_TEST);
      return;
    }
    glEnable(GL_STENCIL_TEST);
    glClearStencil(0);
    glClear(GL_STENCIL_BUFFER_BIT);
    glColorMask(0, 0, 0, 0);
    glStencilFunc(GL_ALWAYS, 1, 0xff);
    glStencilOp(GL_KEEP, GL_KEEP, GL_REPLACE);
    verts.clear();
    for (size_t i = 0; i + 1 < clip->polygon.size(); i += 2) verts.insert(verts.end(), {clip->polygon[i], clip->polygon[i + 1], 0, 0, 1, 1, 1, 1, 0, 0, 0});
    idx.assign(clip->indices.begin(), clip->indices.end());
    drawTriangles(textures.whiteTexture());
    glColorMask(1, 1, 1, 1);
    glStencilFunc(GL_EQUAL, 1, 0xff);
    glStencilOp(GL_KEEP, GL_KEEP, GL_KEEP);
  }

  /** Draws the instance with the skeleton origin at (ox, oy) in a w × h pixel viewport (y down, as the artboard). */
  void draw(const ob::Instance& inst, const ob::Document& doc, Textures& textures, int w, int h, float ox, float oy, float scale) {
    glUseProgram(program);
    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    // Skeleton (x, y-up) → artboard pixels (ox + x·s, oy − y·s) → clip space.
    glUniform2f(uScale, 2 * scale / w, 2 * scale / h);
    glUniform2f(uOffset, 2 * ox / w - 1, 1 - 2 * oy / h);
    glEnable(GL_BLEND);
    const ob::DrawList list = inst.drawList();
    int clip = -1;
    for (const ob::DrawItem& it : list.items) {
      if (it.text) continue;
      if (it.clip != clip) {
        clip = it.clip;
        setClip(clip >= 0 && clip < (int)list.clips.size() ? &list.clips[clip] : nullptr, textures);
      }
      bool isPage = false;
      if (it.texture && doc.atlas)
        for (const auto& p : doc.atlas->pages)
          if (p.id == it.texture->id) isPage = true;
      GLuint tex = it.texture ? textures.get(*it.texture, isPage) : 0;
      if (!tex) tex = textures.whiteTexture();
      const size_t n = it.vertices.size() / 2;
      verts.clear();
      verts.reserve(n * STRIDE);
      const ob::RGBA dark = it.dark.value_or(ob::RGBA{0, 0, 0, 1});
      for (size_t i = 0; i < n; i++) {
        const float u = i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2] : 0.f, v = i * 2 + 1 < it.uvs.size() ? it.uvs[i * 2 + 1] : 0.f;
        float r = (float)it.color[0], g = (float)it.color[1], b = (float)it.color[2], a = (float)it.color[3];
        if (it.isParticles && i * 4 + 3 < it.colors.size()) r = it.colors[i * 4], g = it.colors[i * 4 + 1], b = it.colors[i * 4 + 2], a = it.colors[i * 4 + 3];
        verts.insert(verts.end(), {it.vertices[i * 2], it.vertices[i * 2 + 1], u, v, r, g, b, a, (float)dark[0], (float)dark[1], (float)dark[2]});
      }
      idx.assign(it.indices.begin(), it.indices.end());
      blend(it.blend);
      drawTriangles(tex);
    }
    glDisable(GL_STENCIL_TEST);
  }
};

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s file.obone [--animation name] [--skin name] [--frames n --out frame.png]\n", argv[0]);
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
  const bool headless = !out.empty();
  if (!glfwInit()) {
    std::fprintf(stderr, "glfwInit failed\n");
    return 1;
  }
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
  glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
  glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, 1);  // required on macOS
  glfwWindowHint(GLFW_STENCIL_BITS, 8);
  if (headless) glfwWindowHint(GLFW_VISIBLE, 0);
  GLFWwindow* window = glfwCreateWindow(W, H, ("OpenBone — " + doc->name).c_str(), nullptr, nullptr);
  if (!window) {
    std::fprintf(stderr, "could not create an OpenGL 3.3 window\n");
    glfwTerminate();
    return 1;
  }
  glfwMakeContextCurrent(window);
  glfwSwapInterval(1);
  Renderer renderer;
  if (!loadGl() || !renderer.init()) {
    std::fprintf(stderr, "OpenGL setup failed\n");
    return 1;
  }
  Textures textures{path, doc->atlas && doc->atlas->premultipliedAlpha};
  const float ox = (float)doc->originX, oy = (float)doc->originY;

  auto frame = [&](int fw, int fh) {
    glViewport(0, 0, fw, fh);
    glClearColor(40 / 255.f, 44 / 255.f, 52 / 255.f, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    // Fit the artboard into the framebuffer (it can differ from the window size on high-DPI screens or on resize).
    const float scale = std::min(fw / float(W), fh / float(H));
    const float offX = (fw - W * scale) / 2, offY = (fh - H * scale) / 2;
    renderer.draw(inst, *doc, textures, fw, fh, offX + ox * scale, offY + oy * scale, scale);
    return std::pair{scale, std::pair{offX, offY}};
  };

  if (headless) {
    for (int i = 0; i < frames; i++) inst.advance(1.0 / 60);
    int fw, fh;
    glfwGetFramebufferSize(window, &fw, &fh);
    frame(fw, fh);
    std::vector<uint8_t> px(size_t(fw) * fh * 4);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, fw, fh, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
    std::vector<uint8_t> flipped(px.size());
    for (int y = 0; y < fh; y++) std::memcpy(&flipped[size_t(y) * fw * 4], &px[size_t(fh - 1 - y) * fw * 4], size_t(fw) * 4);
    const int ok = stbi_write_png(out.c_str(), fw, fh, 4, flipped.data(), fw * 4);
    std::printf("%s %d items -> %s\n", ok ? "wrote" : "failed", (int)inst.drawList().items.size(), out.c_str());
    glfwDestroyWindow(window);
    glfwTerminate();
    return ok ? 0 : 1;
  }

  struct Pointer {
    ob::Instance* inst;
    float ox, oy, scale = 1, offX = 0, offY = 0, xScale = 1, yScale = 1;
    void send(GLFWwindow* w, ob::PointerEvent type) {
      double mx, my;
      glfwGetCursorPos(w, &mx, &my);  // window coordinates; the framebuffer may be larger (high DPI)
      const float fx = float(mx) * xScale, fy = float(my) * yScale;
      inst->pointer(type, ((fx - offX) / scale) - ox, oy - ((fy - offY) / scale));
    }
  } pointer{&inst, ox, oy};
  glfwSetWindowUserPointer(window, &pointer);
  glfwSetMouseButtonCallback(window, [](GLFWwindow* w, int button, int action, int) {
    if (button == GLFW_MOUSE_BUTTON_LEFT) static_cast<Pointer*>(glfwGetWindowUserPointer(w))->send(w, action == GLFW_PRESS ? ob::PointerEvent::Down : ob::PointerEvent::Up);
  });
  glfwSetCursorPosCallback(window, [](GLFWwindow* w, double, double) { static_cast<Pointer*>(glfwGetWindowUserPointer(w))->send(w, ob::PointerEvent::Move); });

  double last = glfwGetTime();
  while (!glfwWindowShouldClose(window)) {
    glfwPollEvents();
    const double now = glfwGetTime();
    inst.advance(now - last);
    last = now;
    int fw, fh, ww, wh;
    glfwGetFramebufferSize(window, &fw, &fh);
    glfwGetWindowSize(window, &ww, &wh);
    const auto [scale, off] = frame(fw, fh);
    pointer.scale = scale, pointer.offX = off.first, pointer.offY = off.second;
    pointer.xScale = ww > 0 ? fw / float(ww) : 1, pointer.yScale = wh > 0 ? fh / float(wh) : 1;
    glfwSwapBuffers(window);
  }
  glfwDestroyWindow(window);
  glfwTerminate();
  return 0;
}
