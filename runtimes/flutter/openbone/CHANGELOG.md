## 0.3.0

- Mute buttons: the `setMute` listener action reaches Flutter as an `OpenBoneAudioType.mix` command (`bus`, `muted`);
  the built-in flutter_soloud player applies it to playing and later sounds.
- The C++ runtime underneath: the new audio `mix` command (`OB_AUDIO_MIX`, with a `muted` field) in the C API.
- Example app: the Windswept scene (state machine, buttons, lip-synced voice, music and ambience), on desktop and
  Android.

## 0.2.0

* First release on pub.dev. The package bundles the OpenBone C++ runtime (`cpp/`) with nlohmann/json and QuickJS
  (quickjs-ng 0.10.1), so document scripts work on every platform without a download.
* Flutter FFI plugin over the OpenBone C++ runtime's C API: `OpenBoneDocument`, `OpenBoneInstance`, `OpenBoneWidget`,
  `OpenBoneController`, sound through flutter_soloud; passes all 82 conformance cases. See the repository
  [CHANGELOG](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md).
