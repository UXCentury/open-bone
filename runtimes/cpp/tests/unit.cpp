// Small unit checks for the JS-semantics helpers the reference depends on.
// SPDX-License-Identifier: MIT
#include <cstdio>
#include <string>

#include "internal.hpp"

using namespace openbone;

static int failures = 0;
static void expect(const std::string& got, const std::string& want, const char* what) {
  if (got != want) {
    std::printf("FAIL %s: got \"%s\", want \"%s\"\n", what, got.c_str(), want.c_str());
    failures++;
  }
}

int main() {
  expect(jsNumberToString(0.1), "0.1", "String(0.1)");
  expect(jsNumberToString(1e21), "1e+21", "String(1e21)");
  expect(jsNumberToString(123456789012345680000.0), "123456789012345680000", "String(1.2e20)");
  expect(jsNumberToString(1.5e-7), "1.5e-7", "String(1.5e-7)");
  expect(jsNumberToString(0.000001), "0.000001", "String(1e-6)");
  expect(jsNumberToString(-42), "-42", "String(-42)");
  expect(jsToFixed(2.5, 0), "3", "(2.5).toFixed(0)");
  expect(jsToFixed(1.005, 2), "1.00", "(1.005).toFixed(2)");
  expect(jsToFixed(0.125, 2), "0.13", "(0.125).toFixed(2)");
  expect(jsToFixed(-0.0001, 2), "-0.00", "(-0.0001).toFixed(2)");
  expect(jsToFixed(1234.5678, 1), "1234.6", "(1234.5678).toFixed(1)");
  expect(jsToFixed(0.006, 2), "0.01", "(0.006).toFixed(2)");
  expect(jsNumberToString(jsRoundPrecision(double(0.42f), 7)), "0.42", "Number(f32(0.42).toPrecision(7))");
  expect(formatNumber(12345.678, "#,##0"), "12,346", "#,##0");
  expect(formatNumber(2.349, "0.00x"), "2.35x", "0.00x");
  expect(formatNumber(2.3, "0.0#"), "2.3", "0.0#");
  expect(formatNumber(0.5, "#.##"), ".5", "#.##");
  expect(formatNumber(0.256, "0%"), "26%", "0%");
  expect(formatNumber(5, "+0"), "+5", "+0");
  expect(formatNumber(1234.5, "$#,##0.00"), "$1,234.50", "$#,##0.00");
  expect(formatTemplate("Score {score:#,##0} {{x}} {missing}", [](const std::string& n) { return n == "score" ? Value::number(1234567) : Value(); }),
         "Score 1,234,567 {x} {missing}", "template");
  expect(formatTemplate("{a}", [](const std::string&) { return Value::number(0.1 + 0.2); }), "0.3", "plain number");
  // earcut 3.2.4 output for this quad (checked against the npm package)
  auto tri = earcut({10, 0, 0, 50, 60, 60, 70, 10});
  std::string s;
  for (auto i : tri) s += std::to_string(i) + ",";
  expect(s, "1,0,3,1,3,2,", "earcut");
  std::printf(failures ? "%d failures\n" : "unit OK\n", failures);
  return failures ? 1 : 0;
}
