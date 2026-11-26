# Changelog

## 0.4.13

- No changes to the Unity package; released with OpenBone 0.4.13 (MCP: tools with bezier curves or particle ranges load in clients that check tool schemas strictly, such as the Claude API), so every package keeps the same version.

## 0.4.12

- Draws pixel art without smoothing when the document sets `textureFilter: "nearest"`, and applies the atlas's own filter and wrap settings. Released with OpenBone 0.4.12 (pixel art option and a pixel grid in the editor).

## 0.4.11

- Plays transform constraint property mappings and volume-preserving stretch (IK and physics `volume`). Released with OpenBone 0.4.11 (transform property mapping and volume-preserving stretch in the format, constraint baking, a Problems panel and editor fixes).

## 0.4.10

- No changes to the Unity package; released with OpenBone 0.4.10 (desktop app: projects opened through MCP are listed in Open recent), so every package keeps the same version.

## 0.4.9

- No changes to the Unity package; released with OpenBone 0.4.9 (desktop app: a project's art stays after connecting to MCP; a new slot game example), so every package keeps the same version.

## 0.4.8

- No changes to the Unity package; released with OpenBone 0.4.8 (desktop app: binary exports save again), so every package keeps the same version.

## 0.4.7

- No changes to the Unity package; released with OpenBone 0.4.7 (desktop app: Open recent, art after a restart), so every package keeps the same version.

## 0.4.6

- No changes to the Unity package; released with OpenBone 0.4.6 (editor: live view of MCP agent edits), so every package keeps the same version.

## 0.4.5

- No changes to the Unity package; released with OpenBone 0.4.5 (editor and desktop app fixes), so every package keeps the same version.

## 0.4.4

- No changes to the Unity package; released with OpenBone 0.4.4 (editor fixes), so every package keeps the same version.

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
