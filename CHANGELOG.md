# Changelog

## 0.4.3

- No changes to the Unity package; released with OpenBone 0.4.3 (editor and desktop app fixes), so every package keeps the same version.

## 0.4.2

- Document fonts: fonts embedded in a document (or beside it) are imported as Font assets (`<document>.fonts/`) and used
  for their families before installed fonts, at the weight closest to each text's. They are written during the same
  import, so batch-mode builds get them too.
- Text uses each document's own font list as dynamic OS fonts, instead of Unity's built-in font.

## 0.1.0 (unreleased)

- First version: `.obone` / `.obonb` importer, OpenBone Animation, OpenBone State Machine and OpenBone Audio components,
  mesh generator with blend modes, stencil clipping, two-colour tint and premultiplied atlas pages, Jint script host.
  Compile-checked against a Unity API stub; not yet run in the Unity Editor.
