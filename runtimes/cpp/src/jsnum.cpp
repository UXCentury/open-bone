// JavaScript number <-> string semantics the reference depends on (String(n), toFixed, toPrecision, Number(s)).
// SPDX-License-Identifier: MIT
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "internal.hpp"

namespace openbone {

namespace {

/** Exact decimal digits of |v| (no leading zeros) and the exponent `e` such that |v| = 0.d1d2d3… × 10^e. */
void exactDigits(double v, std::string& digits, int& e) {
  static thread_local char buf[1200];
  // %.1100e prints the exact binary value (every double has at most ~767 significant decimal digits).
  std::snprintf(buf, sizeof buf, "%.1100e", std::fabs(v));
  const char* p = buf;
  digits.clear();
  while (*p && *p != 'e') {
    if (*p >= '0' && *p <= '9') digits.push_back(*p);
    p++;
  }
  int exp10 = std::atoi(p + 1);
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  e = exp10 + 1;
  if (digits == "0") e = 0;
}

/** Keep `keep` leading digits of `digits` (exponent e), rounding half up (exact ties go up, as JS does). */
void roundDigits(std::string& digits, int& e, int keep) {
  if (keep < 0) {
    digits = "0";
    e = 0;
    return;
  }
  if ((int)digits.size() <= keep) return;
  const bool up = digits[keep] >= '5';
  digits.resize(keep);
  if (up) {
    int i = keep - 1;
    while (i >= 0 && digits[i] == '9') digits[i--] = '0';
    if (i < 0) {
      digits.insert(digits.begin(), '1');
      e++;
    } else
      digits[i]++;
  }
  if (digits.empty()) {
    digits = "0";
  }
}

}  // namespace

std::string jsNumberToString(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (v == 0) return "0";
  char buf[64];
#if defined(__APPLE__)
  // Apple's libc++ only has floating-point std::to_chars from macOS 13.3 / iOS 16.3. Same result: the fewest
  // significant digits that read back as exactly v (printf rounds correctly, so that is also the nearest).
  for (int precision = 0; precision <= 16; precision++) {
    std::snprintf(buf, sizeof buf, "%.*e", precision, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
#else
  auto r = std::to_chars(buf, buf + sizeof buf, v, std::chars_format::scientific);
  *r.ptr = 0;
#endif
  // buf: [-]d[.ddd]e±XX
  std::string s(buf);
  bool neg = s[0] == '-';
  if (neg) s.erase(0, 1);
  size_t ep = s.find('e');
  std::string mant = s.substr(0, ep);
  int exp = std::atoi(s.c_str() + ep + 1);
  std::string digits;
  for (char ch : mant)
    if (ch != '.') digits.push_back(ch);
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  const int k = (int)digits.size();
  const int n = exp + 1;
  std::string out;
  if (k <= n && n <= 21) {
    out = digits + std::string(n - k, '0');
  } else if (0 < n && n <= 21) {
    out = digits.substr(0, n) + "." + digits.substr(n);
  } else if (-6 < n && n <= 0) {
    out = "0." + std::string(-n, '0') + digits;
  } else {
    const int e = n - 1;
    out = digits.substr(0, 1);
    if (k > 1) out += "." + digits.substr(1);
    out += e >= 0 ? "e+" : "e-";
    out += std::to_string(e >= 0 ? e : -e);
  }
  return neg ? "-" + out : out;
}

std::string jsToFixed(double v, int f) {
  if (std::isnan(v)) return "NaN";
  if (std::fabs(v) >= 1e21 || std::isinf(v)) return jsNumberToString(v);
  std::string digits;
  int e;
  exactDigits(v, digits, e);
  // Keep the digits up to f places after the point: e integer digits + f.
  roundDigits(digits, e, e + f);
  // Build the fixed string from digits × 10^(e - len).
  std::string intPart, fracPart;
  if (digits == "0") {
    intPart = "0";
    fracPart = std::string(f, '0');
  } else {
    const int len = (int)digits.size();
    // Position of the decimal point inside digits is e.
    if (e <= 0) {
      intPart = "0";
      fracPart = std::string(-e, '0') + digits;
    } else if (e >= len) {
      intPart = digits + std::string(e - len, '0');
    } else {
      intPart = digits.substr(0, e);
      fracPart = digits.substr(e);
    }
    if ((int)fracPart.size() < f) fracPart += std::string(f - fracPart.size(), '0');
    else fracPart.resize(f);
  }
  std::string out = intPart;
  if (f > 0) out += "." + fracPart;
  if (v < 0) out = "-" + out;
  return out;
}

double jsRoundPrecision(double v, int p) {
  if (!std::isfinite(v) || v == 0) return v;
  std::string digits;
  int e;
  exactDigits(v, digits, e);
  roundDigits(digits, e, p);
  std::string s = (v < 0 ? "-0." : "0.") + digits + "e" + std::to_string(e);
  return std::strtod(s.c_str(), nullptr);
}

double jsStringToNumber(const std::string& in) {
  // Trim JS whitespace (ASCII subset + NBSP/BOM as UTF-8 are rare; handle ASCII).
  size_t a = 0, b = in.size();
  auto ws = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; };
  while (a < b && ws(in[a])) a++;
  while (b > a && ws(in[b - 1])) b--;
  std::string s = in.substr(a, b - a);
  if (s.empty()) return 0;
  if (s == "Infinity" || s == "+Infinity") return INFINITY;
  if (s == "-Infinity") return -INFINITY;
  if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X' || s[1] == 'o' || s[1] == 'O' || s[1] == 'b' || s[1] == 'B')) {
    const int base = (s[1] == 'x' || s[1] == 'X') ? 16 : (s[1] == 'o' || s[1] == 'O') ? 8 : 2;
    double n = 0;
    for (size_t i = 2; i < s.size(); i++) {
      int d;
      char c = s[i];
      if (c >= '0' && c <= '9') d = c - '0';
      else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
      else return NAN;
      if (d >= base) return NAN;
      n = n * base + d;
    }
    return n;
  }
  // StrDecimalLiteral: [+-] (digits [. digits?] | . digits) [e [+-] digits]
  size_t i = 0;
  if (s[i] == '+' || s[i] == '-') i++;
  size_t digitsBefore = 0, digitsAfter = 0;
  while (i < s.size() && isdigit((unsigned char)s[i])) i++, digitsBefore++;
  if (i < s.size() && s[i] == '.') {
    i++;
    while (i < s.size() && isdigit((unsigned char)s[i])) i++, digitsAfter++;
  }
  if (!digitsBefore && !digitsAfter) return NAN;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    i++;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
    size_t ed = 0;
    while (i < s.size() && isdigit((unsigned char)s[i])) i++, ed++;
    if (!ed) return NAN;
  }
  if (i != s.size()) return NAN;
  return std::strtod(s.c_str(), nullptr);
}

// ---------- Value ----------

bool Value::strictEquals(const Value& o) const {
  if (type != o.type) return false;
  switch (type) {
    case Type::Undefined:
    case Type::Null: return true;
    case Type::Bool: return b == o.b;
    case Type::Number: return n == o.n;
    case Type::String: return s == o.s;
  }
  return false;
}

double Value::toNumber() const {
  switch (type) {
    case Type::Undefined: return NAN;
    case Type::Null: return 0;
    case Type::Bool: return b ? 1 : 0;
    case Type::Number: return n;
    case Type::String: return jsStringToNumber(s);
  }
  return NAN;
}

bool Value::truthy() const {
  switch (type) {
    case Type::Undefined:
    case Type::Null: return false;
    case Type::Bool: return b;
    case Type::Number: return n != 0 && !std::isnan(n);
    case Type::String: return !s.empty();
  }
  return false;
}

std::string Value::toString() const {
  switch (type) {
    case Type::Undefined: return "undefined";
    case Type::Null: return "null";
    case Type::Bool: return b ? "true" : "false";
    case Type::Number: return jsNumberToString(n);
    case Type::String: return s;
  }
  return "";
}

std::u16string toUtf16(const std::string& s) {
  std::u16string out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = s[i];
    uint32_t cp;
    int n;
    if (c < 0x80) cp = c, n = 1;
    else if ((c >> 5) == 6) cp = c & 0x1f, n = 2;
    else if ((c >> 4) == 14) cp = c & 0x0f, n = 3;
    else cp = c & 0x07, n = 4;
    for (int k = 1; k < n && i + k < s.size(); k++) cp = (cp << 6) | (s[i + k] & 0x3f);
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(char16_t(0xd800 + (cp >> 10)));
      out.push_back(char16_t(0xdc00 + (cp & 0x3ff)));
    } else
      out.push_back(char16_t(cp));
  }
  return out;
}

}  // namespace openbone
