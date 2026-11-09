// core/math.ts, core/template.ts, core/particles.ts helpers.
// SPDX-License-Identifier: MIT
#include <algorithm>
#include <cmath>

#include "internal.hpp"

namespace openbone {

Affine localMatrix(const LocalTransform& t) {
  const double rx = (t.rotation + t.shearX) * DEG;
  const double ry = (t.rotation + 90 + t.shearY) * DEG;
  return {std::cos(rx) * t.scaleX, std::cos(ry) * t.scaleY, std::sin(rx) * t.scaleX, std::sin(ry) * t.scaleY, t.x, t.y};
}

Affine boneWorld(const Affine* parent, const LocalTransform& local, Inherit inherit) {
  Affine l = localMatrix(local);
  if (!parent) return l;
  const Affine& p = *parent;
  double wx, wy;
  applyAffine(p, local.x, local.y, wx, wy);
  switch (inherit) {
    case Inherit::Normal: return multiply(p, l);
    case Inherit::OnlyTranslation: l.x = wx; l.y = wy; return l;
    case Inherit::NoRotation: {
      const double sx = jsHypot(p.a, p.c), sy = jsHypot(p.b, p.d);
      return {l.a * sx, l.b * sy, l.c * sx, l.d * sy, wx, wy};
    }
    case Inherit::NoScale: {
      const double sx = orNum(jsHypot(p.a, p.c), 1), sy = orNum(jsHypot(p.b, p.d), 1);
      Affine n{p.a / sx, p.b / sy, p.c / sx, p.d / sy, 0, 0};
      Affine m = multiply(n, l);
      m.x = wx;
      m.y = wy;
      return m;
    }
  }
  return l;
}

LocalTransform localFromWorld(const Affine& parentWorld, const Affine& childWorld, Inherit inherit, const LocalTransform& keep) {
  const Affine inv = invert(parentWorld);
  double x, y;
  applyAffine(inv, childWorld.x, childWorld.y, x, y);
  if (inherit != Inherit::Normal) {
    LocalTransform out = keep;
    out.x = x;
    out.y = y;
    return out;
  }
  const Affine m = multiply(inv, childWorld);
  const double rotation = std::atan2(m.c, m.a) * RAD - keep.shearX;
  const double scaleX = jsHypot(m.a, m.c);
  const double scaleY = jsHypot(m.b, m.d);
  const double shearY = wrapDeg(std::atan2(m.d, m.b) * RAD - 90 - rotation);
  return {x, y, wrapDeg(rotation), scaleX, scaleY, keep.shearX, shearY};
}

double evalCurve(const Curve& c, double t) {
  if (c.kind == Curve::Kind::Linear) return t;
  if (c.kind == Curve::Kind::Stepped) return 0;
  const double x1 = c.x1, y1 = c.y1, x2 = c.x2, y2 = c.y2;
  auto bx = [&](double s) { return 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s; };
  auto by = [&](double s) { return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s; };
  double lo = 0, hi = 1, s = t;
  for (int i = 0; i < 24; i++) {
    const double x = bx(s) - t;
    if (std::fabs(x) < 1e-6) break;
    if (x > 0) hi = s;
    else lo = s;
    s = (lo + hi) / 2;
  }
  return by(s);
}

bool pointInPolygon(double px, double py, const std::vector<float>& poly) {
  bool inside = false;
  const size_t n = poly.size() / 2;
  if (!n) return false;
  for (size_t i = 0, j = n - 1; i < n; j = i++) {
    const double xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

namespace {
int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
/** parseInt(h.slice(i, i+2), 16) / 255 (NaN when no leading hex digit). */
double channel(const std::string& h, size_t i) {
  if (i >= h.size()) return NAN;
  int d0 = hexDigit(h[i]);
  if (d0 < 0) return NAN;
  int v = d0;
  if (i + 1 < h.size()) {
    int d1 = hexDigit(h[i + 1]);
    if (d1 >= 0) v = v * 16 + d1;
  }
  return v / 255.0;
}
}  // namespace

RGBA parseHex(const std::string& hex) {
  std::string h = hex;
  size_t p = h.find('#');
  if (p != std::string::npos) h.erase(p, 1);
  if (h.size() == 3 || h.size() == 4) {
    std::string d;
    for (char c : h) d += std::string(2, c);
    h = d;
  }
  return {channel(h, 0), channel(h, 2), channel(h, 4), h.size() >= 8 ? channel(h, 6) : 1.0};
}

double particleDotAlpha(double r) {
  const double base = r >= 1 ? 0 : r <= 0.35 ? 1 : 1 - (r - 0.35) / 0.65;
  return std::pow(base, 1.6);
}

uint32_t hashString(const std::string& utf8) {
  uint32_t h = 0x811c9dc5u;
  for (char16_t u : toUtf16(utf8)) h = (h ^ uint32_t(u)) * 0x01000193u;
  return h;
}

RGBA gradientColor(const std::vector<ColorStop>& stops, double t) {
  if (stops.empty()) return {1, 1, 1, 1};
  bool unsorted = false;
  for (size_t i = 1; i < stops.size(); i++)
    if (stops[i].t < stops[i - 1].t) unsorted = true;
  std::vector<ColorStop> sortedCopy;
  const std::vector<ColorStop>* sorted = &stops;
  if (stops.size() > 1 && unsorted) {
    sortedCopy = stops;
    std::stable_sort(sortedCopy.begin(), sortedCopy.end(), [](const ColorStop& a, const ColorStop& b) { return a.t < b.t; });
    sorted = &sortedCopy;
  }
  const auto& s = *sorted;
  if (t <= s[0].t) return parseHex(s[0].color);
  const auto& last = s.back();
  if (t >= last.t) return parseHex(last.color);
  for (size_t i = 1; i < s.size(); i++) {
    const auto& b = s[i];
    if (t <= b.t) {
      const auto& a = s[i - 1];
      return lerpColor(parseHex(a.color), parseHex(b.color), (t - a.t) / orNum(b.t - a.t, 1));
    }
  }
  return parseHex(last.color);
}

// ---------- Templates ----------

namespace {
std::string plain(const Value& v) {
  if (v.type == Value::Type::Number)
    return std::isfinite(v.n) ? jsNumberToString(jsStringToNumber(jsToFixed(v.n, 6))) : jsNumberToString(v.n);
  return v.toString();
}
bool isPatChar(char c) { return c == '#' || c == '0' || c == ','; }
}  // namespace

std::string formatNumber(double value, const std::string& pattern) {
  // /^([^#0]*?)(\+?)([#0,]+)(?:\.([0#]+))?(%?)(.*)$/s
  size_t p = 0;
  bool found = false;
  bool plusSign = false;
  for (; p <= pattern.size(); p++) {
    if (p < pattern.size() && pattern[p] == '+' && p + 1 < pattern.size() && isPatChar(pattern[p + 1])) {
      plusSign = true;
      found = true;
      break;
    }
    if (p < pattern.size() && isPatChar(pattern[p])) {
      found = true;
      break;
    }
    if (p < pattern.size() && (pattern[p] == '#' || pattern[p] == '0')) break;
  }
  if (!found) return plain(Value::number(value)) + pattern;
  const std::string prefix = pattern.substr(0, p);
  size_t i = p + (plusSign ? 1 : 0);
  size_t i0 = i;
  while (i < pattern.size() && isPatChar(pattern[i])) i++;
  const std::string intPat = pattern.substr(i0, i - i0);
  std::string frac;
  if (i + 1 < pattern.size() && pattern[i] == '.' && (pattern[i + 1] == '0' || pattern[i + 1] == '#')) {
    size_t j = i + 1;
    while (j < pattern.size() && (pattern[j] == '0' || pattern[j] == '#')) j++;
    frac = pattern.substr(i + 1, j - i - 1);
    i = j;
  }
  bool pct = false;
  if (i < pattern.size() && pattern[i] == '%') {
    pct = true;
    i++;
  }
  const std::string suffix = pattern.substr(i);
  double v = pct ? value * 100 : value;
  if (!std::isfinite(v)) return prefix + jsNumberToString(v) + (pct ? "%" : "") + suffix;
  int minFrac = 0;
  while (minFrac < (int)frac.size() && frac[minFrac] == '0') minFrac++;
  const int maxFrac = (int)frac.size();
  const bool neg = v < 0;
  v = std::fabs(v);
  std::string s = jsToFixed(v, maxFrac);
  if (maxFrac > minFrac) {
    size_t end = s.size();
    const size_t keep = s.size() - (maxFrac - minFrac);
    while (end > keep && s[end - 1] == '0') end--;
    s = s.substr(0, end);
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  std::string ip, fp;
  bool hasFp = false;
  size_t dot = s.find('.');
  if (dot == std::string::npos) ip = s;
  else {
    ip = s.substr(0, dot);
    fp = s.substr(dot + 1);
    hasFp = true;
  }
  int minInt = 0;
  for (char c : intPat)
    if (c == '0') minInt++;
  if ((int)ip.size() < minInt) ip = std::string(minInt - ip.size(), '0') + ip;
  else if (minInt == 0 && ip == "0" && hasFp && !fp.empty()) ip = "";
  if (intPat.find(',') != std::string::npos) {
    std::string g;
    const int n = (int)ip.size();
    for (int k = 0; k < n; k++) {
      if (k > 0 && (n - k) % 3 == 0) g.push_back(',');
      g.push_back(ip[k]);
    }
    ip = g;
  }
  bool zero = true;
  for (char c : ip + fp)
    if (c >= '1' && c <= '9') zero = false;
  const std::string sign = neg && !zero ? "-" : (plusSign && !neg) ? "+" : "";
  return prefix + sign + ip + (hasFp && !fp.empty() ? "." + fp : "") + (pct ? "%" : "") + suffix;
}

std::string formatValue(const Value& v, const std::string* pattern) {
  if (v.type == Value::Type::Number && pattern && !pattern->empty()) return formatNumber(v.n, *pattern);
  return plain(v);
}

std::string formatTemplate(const std::string& tpl, const std::function<Value(const std::string&)>& lookup) {
  if (tpl.find('{') == std::string::npos && tpl.find('}') == std::string::npos) return tpl;
  std::string out;
  size_t i = 0;
  auto trim = [](const std::string& s) {
    // JS String.prototype.trim (ASCII whitespace).
    size_t a = 0, b = s.size();
    auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; };
    while (a < b && ws(s[a])) a++;
    while (b > a && ws(s[b - 1])) b--;
    return s.substr(a, b - a);
  };
  while (i < tpl.size()) {
    if (tpl.compare(i, 2, "{{") == 0) {
      out += '{';
      i += 2;
      continue;
    }
    if (tpl.compare(i, 2, "}}") == 0) {
      out += '}';
      i += 2;
      continue;
    }
    if (tpl[i] == '{') {
      size_t j = i + 1;
      while (j < tpl.size() && tpl[j] != '{' && tpl[j] != '}' && tpl[j] != ':') j++;
      if (j > i + 1 && j < tpl.size()) {
        const std::string name = tpl.substr(i + 1, j - i - 1);
        bool matched = false;
        std::string pattern;
        bool hasPattern = false;
        size_t endPos = 0;
        if (tpl[j] == '}') {
          matched = true;
          endPos = j + 1;
        } else if (tpl[j] == ':') {
          size_t k = j + 1;
          while (k < tpl.size() && tpl[k] != '{' && tpl[k] != '}') k++;
          if (k < tpl.size() && tpl[k] == '}') {
            matched = true;
            hasPattern = true;
            pattern = tpl.substr(j + 1, k - j - 1);
            endPos = k + 1;
          }
        }
        if (matched) {
          Value v = lookup(trim(name));
          if (v.isUndefined()) out += tpl.substr(i, endPos - i);
          else out += formatValue(v, hasPattern ? &pattern : nullptr);
          i = endPos;
          continue;
        }
      }
    }
    out += tpl[i];
    i++;
  }
  return out;
}

double bindingT(double v, double inMin, double inMax) {
  if (inMax == inMin) return v >= inMax ? 1 : 0;
  const double t = (v - inMin) / (inMax - inMin);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

}  // namespace openbone
