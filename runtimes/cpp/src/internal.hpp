// Internal helpers shared by the runtime sources (not installed).
// SPDX-License-Identifier: MIT
#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "openbone/runtime.hpp"

namespace openbone {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG = PI / 180;
constexpr double RAD = 180 / PI;

// ---------- JS number semantics (jsnum.cpp) ----------
/** `String(n)` for a JS number (shortest round-trip form). */
std::string jsNumberToString(double v);
/** `n.toFixed(digits)` (exact decimal, ties away from zero). */
std::string jsToFixed(double v, int digits);
/** `Number(f.toPrecision(digits))`. */
double jsRoundPrecision(double v, int digits);
/** `Number(s)` for a string. */
double jsStringToNumber(const std::string& s);
/** JS `a % b` (fmod: sign of the dividend). */
inline double jsMod(double a, double b) { return std::fmod(a, b); }

// ---------- Maths (core/math.ts) ----------
inline Affine identity() { return {}; }
inline Affine multiply(const Affine& p, const Affine& l) {
  return {p.a * l.a + p.b * l.c, p.a * l.b + p.b * l.d, p.c * l.a + p.d * l.c, p.c * l.b + p.d * l.d,
          p.a * l.x + p.b * l.y + p.x, p.c * l.x + p.d * l.y + p.y};
}
inline Affine invert(const Affine& m) {
  double det = m.a * m.d - m.b * m.c;
  if (det == 0) det = 1e-9;
  const double ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
  return {ia, ib, ic, id, -(ia * m.x + ib * m.y), -(ic * m.x + id * m.y)};
}
inline void applyAffine(const Affine& m, double x, double y, double& ox, double& oy) {
  ox = m.a * x + m.b * y + m.x;
  oy = m.c * x + m.d * y + m.y;
}
/** Math.hypot (V8 scales by the largest magnitude and sums with compensation; the plain form matches for 2 args). */
inline double jsHypot(double a, double b) { return std::hypot(a, b); }
inline double wrapDeg(double d) {
  d = std::fmod(d, 360.0);
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }
inline double lerpAngle(double a, double b, double t) { return a + wrapDeg(b - a) * t; }
inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
inline double worldRotation(const Affine& m) { return std::atan2(m.c, m.a) * RAD; }
inline double worldScaleX(const Affine& m) { return jsHypot(m.a, m.c); }
inline double worldScaleY(const Affine& m) { return jsHypot(m.b, m.d); }
inline RGBA lerpColor(const RGBA& a, const RGBA& b, double t) {
  return {lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)};
}
inline RGBA mulColor(const RGBA& a, const RGBA& b) { return {a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]}; }
/** JS `x || y` for numbers (0 and NaN are falsy). */
inline double orNum(double x, double y) { return (x == 0 || std::isnan(x)) ? y : x; }
inline double jsSign(double v) { return v > 0 ? 1 : v < 0 ? -1 : v; }

Affine localMatrix(const LocalTransform& t);
Affine boneWorld(const Affine* parent, const LocalTransform& local, Inherit inherit);
LocalTransform localFromWorld(const Affine& parentWorld, const Affine& childWorld, Inherit inherit, const LocalTransform& keep);
double evalCurve(const Curve& c, double t);
bool pointInPolygon(double px, double py, const std::vector<float>& poly);

// ---------- Geometry ----------
/** mapbox earcut 3.2.4 (no holes), exact port. */
std::vector<uint32_t> earcut(const std::vector<double>& data);
std::vector<double> shapeOutline(const Attachment& s, int segments = 32);

// ---------- Path splines (core/path.ts) ----------
struct PathSample { double x, y, angle; };
class Spline {
 public:
  Spline(const std::vector<float>& vertices, bool closed);
  double length = 0;
  int segments = 0;
  PathSample sample(double distance) const;

 private:
  bool closed;
  int knots;
  std::vector<double> ctrl, table;
  double v2 = 0, v3 = 0;
  PathSample point(int s, double t) const;
};

// ---------- Templates (core/template.ts) ----------
std::string formatNumber(double value, const std::string& pattern);
std::string formatValue(const Value& v, const std::string* pattern);
std::string formatTemplate(const std::string& tpl, const std::function<Value(const std::string&)>& lookup);
double bindingT(double v, double inMin, double inMax);

// ---------- Particles ----------
uint32_t hashString(const std::string& utf8);
RGBA gradientColor(const std::vector<ColorStop>& stops, double t);

constexpr double PARTICLE_STEP = 1.0 / 60;
constexpr int MAX_PARTICLE_STEPS = 30;

struct ParticleGeometry {
  int count = 0;
  std::vector<float> vertices, uvs, colors;
  std::vector<uint16_t> indices;
};

class ParticleEmitter {
 public:
  ParticleEmitter(const Attachment* data, uint32_t salt);
  const Attachment* data;
  struct P { double x, y, vx, vy, age, life, size0, size1, rot0, rot1, spin; };
  std::vector<P> particles;
  double cycle = 0;
  long long steps = 0;
  double pending = 0;
  size_t alive() const { return particles.size(); }
  void restart();
  void step(double h, const Affine& m, const EmitterValues* values);
  ParticleGeometry geometry(double frac, const Affine& m, const RGBA& tint) const;

 private:
  double acc = 0;
  bool wasEmitting = false;
  uint32_t rngState;
  double lastX = NAN, lastY = NAN;
  double next();
  double range(const Range& r);
  double between(double a, double b) { return a + (b - a) * next(); }
  void advance(double h, const Affine& m, bool emitting, double rate);
  void spawn(const Affine& m, double preAge, double ox, double oy);
};

/** UTF-8 → UTF-16 code units (FNV hash input, JS string semantics). */
std::u16string toUtf16(const std::string& s);

}  // namespace openbone
