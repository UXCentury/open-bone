## 0.4.13

- No changes to the Flutter plugin; released with OpenBone 0.4.13 (MCP: tools with bezier curves or particle ranges load in clients that check tool schemas strictly, such as the Claude API), so every package keeps the same version.

## 0.4.12

- Draws pixel art without smoothing when the document sets `textureFilter: "nearest"`, and applies the atlas's own filter and wrap settings. Released with OpenBone 0.4.12 (pixel art option and a pixel grid in the editor).

## 0.4.11

- Plays transform constraint property mappings and volume-preserving stretch (IK and physics `volume`), through the shared C++ runtime. Released with OpenBone 0.4.11 (transform property mapping and volume-preserving stretch in the format, constraint baking, a Problems panel and editor fixes).

## 0.4.10

- No changes to the Flutter plugin; released with OpenBone 0.4.10 (desktop app: projects opened through MCP are listed in Open recent), so every package keeps the same version.

## 0.4.9

- No changes to the Flutter plugin; released with OpenBone 0.4.9 (desktop app: a project's art stays after connecting to MCP; a new slot game example), so every package keeps the same version.

## 0.4.8

- No changes to the Flutter plugin; released with OpenBone 0.4.8 (desktop app: binary exports save again), so every package keeps the same version.

## 0.4.7

- No changes to the Flutter plugin; released with OpenBone 0.4.7 (desktop app: Open recent, art after a restart), so every package keeps the same version.

## 0.4.6

- No changes to the Flutter plugin; released with OpenBone 0.4.6 (editor: live view of MCP agent edits), so every package keeps the same version.

## 0.4.5

- No changes to the Flutter plugin; released with OpenBone 0.4.5 (editor and desktop app fixes), so every package keeps the same version.

## 0.4.4

- No changes to the Flutter plugin; released with OpenBone 0.4.4 (editor fixes), so every package keeps the same version.

## 0.4.3

- No changes to the Flutter plugin; released with OpenBone 0.4.3 (editor and desktop app fixes), so every package keeps the same version.

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
