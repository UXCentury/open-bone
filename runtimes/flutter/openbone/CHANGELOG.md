## 0.2.0

* First release on pub.dev. The package bundles the OpenBone C++ runtime (`cpp/`) with nlohmann/json and QuickJS
  (quickjs-ng 0.10.1), so document scripts work on every platform without a download.
* Flutter FFI plugin over the OpenBone C++ runtime's C API: `OpenBoneDocument`, `OpenBoneInstance`, `OpenBoneWidget`,
  `OpenBoneController`, sound through flutter_soloud; passes all 82 conformance cases. See the repository
  [CHANGELOG](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md).
