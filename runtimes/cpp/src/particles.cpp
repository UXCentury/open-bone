// Port of packages/runtime/src/particles.ts (mulberry32 RNG, fixed-step emitter, quads).
// SPDX-License-Identifier: MIT
#include <algorithm>
#include <cmath>

#include "internal.hpp"

namespace openbone {

namespace {
constexpr int MAX_PREWARM_STEPS = 600;
constexpr double EPS = 1e-9;
const float UNIT_UVS[8] = {0, 0, 1, 0, 1, 1, 0, 1};
}  // namespace

ParticleEmitter::ParticleEmitter(const Attachment* d, uint32_t salt) : data(d) {
  // (data.seed ^ salt) >>> 0 with JS ToInt32 on the seed.
  const double s = d->seed;
  double m = std::fmod(std::trunc(std::isfinite(s) ? s : 0), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  rngState = uint32_t(m) ^ salt;
}

double ParticleEmitter::next() {
  rngState = rngState + 0x6d2b79f5u;
  uint32_t t = rngState;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return double(t ^ (t >> 14)) / 4294967296.0;
}

double ParticleEmitter::range(const Range& r) { return r[0] == r[1] ? r[0] : r[0] + (r[1] - r[0]) * next(); }

void ParticleEmitter::restart() {
  cycle = 0;
  acc = 0;
  wasEmitting = false;
}

void ParticleEmitter::step(double h, const Affine& m, const EmitterValues* values) {
  const Attachment& d = *data;
  const bool emitting = values && values->emitting ? *values->emitting : d.emitting;
  const double rate = values && values->rate ? *values->rate : d.rate;
  if (steps == 0 && emitting && d.prewarm && d.loop) {
    const double n = std::min(double(MAX_PREWARM_STEPS), std::ceil(d.duration / h - 1e-6));
    lastX = m.x;
    lastY = m.y;
    for (int i = 0; i < n; i++) advance(h, m, true, rate);
  }
  advance(h, m, emitting, rate);
  steps++;
}

void ParticleEmitter::advance(double h, const Affine& m, bool emitting, double rate) {
  const Attachment& d = *data;
  const double damp = d.drag > 0 ? std::exp(-d.drag * h) : 1;
  const double g = d.gravity * h;
  size_t w = 0;
  for (size_t i = 0; i < particles.size(); i++) {
    P p = particles[i];
    p.age += h;
    if (p.age >= p.life) continue;
    p.vy -= g;
    p.vx *= damp;
    p.vy *= damp;
    p.x += p.vx * h;
    p.y += p.vy * h;
    particles[w++] = p;
  }
  particles.resize(w);

  if (emitting && !wasEmitting) {
    cycle = 0;
    acc = 0;
  }
  wasEmitting = emitting;
  const bool active = emitting && (d.loop || cycle < d.duration);
  double streamed = 0;
  double burst = pending;
  pending = 0;
  if (active) {
    acc += std::max(0.0, rate) * h;
    streamed = std::floor(acc);
    acc -= streamed;
    const double start = cycle, end = start + h;
    const bool wraps = end >= d.duration - EPS;
    const double rest = end - d.duration;
    for (const auto& b : d.bursts) {
      if (b.time > d.duration + EPS) continue;
      if (b.time >= start - EPS && b.time < end - EPS) burst += b.count;
      else if (wraps && d.loop && b.time < rest - EPS) burst += b.count;
    }
    cycle = wraps ? (d.loop ? std::max(0.0, rest) : d.duration) : end;
  }
  const double room = std::max(0.0, d.maxParticles - double(particles.size()));
  const double nb = std::min(burst, room);
  const double ns = std::min(streamed, room - nb);
  const double lx = std::isnan(lastX) ? m.x : lastX;
  const double ly = std::isnan(lastY) ? m.y : lastY;
  for (double i = 0; i < nb; i++) spawn(m, 0, m.x, m.y);
  for (double i = 0; i < ns; i++) {
    const double k = (i + 1) / ns;
    spawn(m, (1 - k) * h, lerp(lx, m.x, k), lerp(ly, m.y, k));
  }
  lastX = m.x;
  lastY = m.y;
}

void ParticleEmitter::spawn(const Affine& m, double preAge, double ox, double oy) {
  const Attachment& d = *data;
  const double rot = d.rotation * DEG;
  const double half = (d.angle / 2) * DEG;
  double f = 0, s = 0;
  double dir = rot + between(-half, half);
  switch (d.emitterShape) {
    case EmitterShape::Circle: {
      const double a = next() * PI * 2;
      const double rad = std::sqrt(next()) * d.radius;
      f = std::cos(a) * rad;
      s = std::sin(a) * rad;
      dir = rot + a;
      break;
    }
    case EmitterShape::Box:
      s = between(-d.width / 2, d.width / 2);
      f = between(-d.height / 2, d.height / 2);
      break;
    case EmitterShape::Cone:
      s = between(-d.radius, d.radius);
      if (d.radius > 0) dir = rot + (s / d.radius) * half;
      break;
    default: break;
  }
  const double cos = std::cos(rot), sin = std::sin(rot);
  double x = d.x + f * cos - s * sin;
  double y = d.y + f * sin + s * cos;
  const double speed = range(d.speed);
  double vx = std::cos(dir) * speed, vy = std::sin(dir) * speed;
  if (!d.localSpace) {
    const double wx = m.a * x + m.b * y + ox, wy = m.c * x + m.d * y + oy;
    x = wx;
    y = wy;
    const double tx = m.a * vx + m.b * vy, ty = m.c * vx + m.d * vy;
    const double len = jsHypot(tx, ty);
    vx = len > 1e-9 ? (tx / len) * speed : 0;
    vy = len > 1e-9 ? (ty / len) * speed : 0;
  }
  P p;
  p.x = x;
  p.y = y;
  p.vx = vx;
  p.vy = vy;
  p.age = 0;
  p.life = std::max(1e-3, range(d.lifetime));
  p.size0 = range(d.startSize);
  p.size1 = range(d.endSize);
  p.rot0 = range(d.startRotation);
  p.rot1 = range(d.endRotation);
  p.spin = range(d.angularVelocity);
  if (preAge > 0) {
    p.age = preAge;
    p.vy -= d.gravity * preAge;
    p.x += p.vx * preAge;
    p.y += p.vy * preAge;
  }
  if (p.age < p.life) particles.push_back(p);
}

ParticleGeometry ParticleEmitter::geometry(double frac, const Affine& m, const RGBA& tint) const {
  const Attachment& d = *data;
  const size_t n = std::min(particles.size(), size_t(16383));
  ParticleGeometry g;
  g.vertices.resize(n * 8);
  g.colors.resize(n * 16);
  g.uvs.resize(n * 8);
  g.indices.resize(n * 6);
  const bool local = d.localSpace;
  const double sizeScale = local ? std::sqrt(std::fabs(m.a * m.d - m.b * m.c)) : 1;
  int k = 0;
  for (size_t i = 0; i < n; i++) {
    const P& p = particles[i];
    const double age = std::min(p.age + frac, p.life);
    const double t = age / p.life;
    double x = p.x + p.vx * frac, y = p.y + p.vy * frac, vx = p.vx, vy = p.vy;
    if (local) {
      const double wx = m.a * x + m.b * y + m.x, wy = m.c * x + m.d * y + m.y;
      x = wx;
      y = wy;
      const double tx = m.a * vx + m.b * vy;
      vy = m.c * vx + m.d * vy;
      vx = tx;
    }
    const double size = std::max(0.0, lerp(p.size0, p.size1, t)) * sizeScale;
    const RGBA c = gradientColor(d.colors, t);
    const double a = c[3] * tint[3];
    if (size <= 0 || a <= 0) continue;
    double ux, uy, hw;
    if (d.look == ParticleLook::Spark) {
      const double sp = jsHypot(vx, vy);
      const double len = size / 2 + (sp * d.stretch) / 2;
      const double ang = sp > 1e-6 ? std::atan2(vy, vx) : (lerp(p.rot0, p.rot1, t) + p.spin * age) * DEG;
      ux = std::cos(ang) * len;
      uy = std::sin(ang) * len;
      hw = size / 2;
    } else {
      const double ang = (lerp(p.rot0, p.rot1, t) + p.spin * age) * DEG;
      ux = (std::cos(ang) * size) / 2;
      uy = (std::sin(ang) * size) / 2;
      hw = size / 2;
    }
    const double ul = orNum(jsHypot(ux, uy), 1);
    const double vx2 = (-uy / ul) * hw, vy2 = (ux / ul) * hw;
    float* v = &g.vertices[k * 8];
    v[0] = float(x - ux + vx2);
    v[1] = float(y - uy + vy2);
    v[2] = float(x + ux + vx2);
    v[3] = float(y + uy + vy2);
    v[4] = float(x + ux - vx2);
    v[5] = float(y + uy - vy2);
    v[6] = float(x - ux - vx2);
    v[7] = float(y - uy - vy2);
    std::copy(UNIT_UVS, UNIT_UVS + 8, &g.uvs[k * 8]);
    const double r = c[0] * tint[0], gg = c[1] * tint[1], b = c[2] * tint[2];
    for (int j = 0; j < 4; j++) {
      float* q = &g.colors[k * 16 + j * 4];
      q[0] = float(r);
      q[1] = float(gg);
      q[2] = float(b);
      q[3] = float(a);
    }
    uint16_t* ii = &g.indices[k * 6];
    const uint16_t base = uint16_t(k * 4);
    ii[0] = base;
    ii[1] = base + 1;
    ii[2] = base + 2;
    ii[3] = base;
    ii[4] = base + 2;
    ii[5] = base + 3;
    k++;
  }
  g.count = k;
  g.vertices.resize(k * 8);
  g.uvs.resize(k * 8);
  g.colors.resize(k * 16);
  g.indices.resize(k * 6);
  return g;
}

}  // namespace openbone
