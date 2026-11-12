## 0.4.2

- Document fonts: fonts a document carries (embedded or beside it) are loaded with `FontLoader` and used for their
  families before installed fonts, at the weight closest to each text's; `OpenBoneDocument.fonts` lists them.
- Text passes the document's whole font list (`fontFamily` + `fontFamilyFallback`), not only its first family.
- The C++ runtime underneath: `ob_font_asset`, `ob_document_font_count` and `ob_document_font` in the C API.

## 0.4.1

- No changes to the Flutter plugin; released with OpenBone 0.4.1 (web player fixes), so every package keeps the same version.

## 0.4.0

- Mute a sound bus from your app: `OpenBoneInstance.setBusMuted("music", muted: true)` (or `null` to toggle, and
  `isBusMuted`), the same as a mute button inside the artboard.
- Bool inputs can own a bus's mute (`mutes` in the file): setting such an input, e.g. `setInput("musicOff", true)`,
  mutes that bus. The Windswept example's music and sound-effect inputs work this way.
- The C++ runtime underneath: `ob_instance_set_bus_muted` and `ob_instance_bus_muted` in the C API.

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
