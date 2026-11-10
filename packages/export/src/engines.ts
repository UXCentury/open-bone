import { encodePng } from "./png.ts";
import type { SheetFrame, SpriteSheetSet } from "./spritesheet.ts";
import { createZip } from "./zip.ts";
import { FLAME_COMPONENT_DART, FLUTTER_SHEET_DART, NATIVE_FLUTTER_URL, UNITY_IMPORTER_CS } from "./engine-templates.ts";

/**
 * Engine packs: sprite sheets plus the metadata each engine reads (TexturePacker JSON, Godot SpriteFrames,
 * a Unity importer, Flutter/Flame code). The writers are pure string builders so their structure can be tested.
 */

export type SheetEngine = "unity" | "godot" | "flutter" | "generic";

const APP = { app: "OpenBone", url: "https://github.com/UXCentury/open-bone", version: "1.0" };

const tpFrame = (f: SheetFrame) => ({
  frame: { ...f.frame },
  rotated: false,
  trimmed: f.trimmed,
  spriteSourceSize: { ...f.spriteSourceSize },
  sourceSize: { ...f.sourceSize },
  pivot: { ...f.pivot },
});

const tpMeta = (set: SpriteSheetSet, sheet: number, image: string, scale: number, related: string[]) => ({
  ...APP,
  image,
  format: "RGBA8888",
  size: { w: set.pages[sheet].width, h: set.pages[sheet].height },
  scale: String(scale),
  ...(related.length ? { related_multi_packs: related } : {}),
});

/** Clip name -> frame names, as TexturePacker/Pixi/Phaser read `animations`. Only frames on `sheet` when given. */
const animationsOf = (set: SpriteSheetSet, sheet?: number) => {
  const onSheet = new Set(set.frames.filter((f) => sheet === undefined || f.sheet === sheet).map((f) => f.name));
  return Object.fromEntries(set.clips.map((c) => [c.name, c.frames.filter((n) => onSheet.has(n))]).filter(([, l]) => l.length));
};

/** Per-clip playback info that TexturePacker formats have no field for (fps, loop, origin). */
const clipsMeta = (set: SpriteSheetSet) => ({
  clips: set.clips.map((c) => ({ name: c.name, fps: c.fps, loop: c.loop, frames: c.frames.length })),
  origin: { ...set.origin },
  sourceSize: { ...set.sourceSize },
});

/** TexturePacker "JSON (Hash)" for one sheet: frames keyed by name. Read by PixiJS, Phaser (atlas), Cocos and many tools. */
export function texturePackerHash(set: SpriteSheetSet, sheet: number, images: string[], scale = 1) {
  const related = images.filter((_, i) => i !== sheet).map((n) => n.replace(/\.png$/, ".json"));
  return {
    frames: Object.fromEntries(set.frames.filter((f) => f.sheet === sheet).map((f) => [f.name, tpFrame(f)])),
    animations: animationsOf(set, sheet),
    meta: { ...tpMeta(set, sheet, images[sheet], scale, related), openbone: clipsMeta(set) },
  };
}

/** TexturePacker "JSON (Array)" for one sheet: frames as a list with `filename`. */
export function texturePackerArray(set: SpriteSheetSet, sheet: number, images: string[], scale = 1) {
  const related = images.filter((_, i) => i !== sheet).map((n) => n.replace(/\.png$/, ".array.json"));
  return {
    frames: set.frames.filter((f) => f.sheet === sheet).map((f) => ({ filename: f.name, ...tpFrame(f) })),
    animations: animationsOf(set, sheet),
    meta: { ...tpMeta(set, sheet, images[sheet], scale, related), openbone: clipsMeta(set) },
  };
}

/** Phaser 3 multi-atlas: every sheet in one file (`this.load.multiatlas`). */
export function phaserMultiAtlas(set: SpriteSheetSet, images: string[], scale = 1) {
  return {
    textures: set.pages.map((p, i) => ({
      image: images[i],
      format: "RGBA8888",
      size: { w: p.width, h: p.height },
      scale,
      frames: set.frames.filter((f) => f.sheet === i).map((f) => ({ filename: f.name, ...tpFrame(f) })),
    })),
    animations: animationsOf(set),
    meta: { ...APP, openbone: clipsMeta(set) },
  };
}

/**
 * Unity: a JsonUtility-friendly layout (arrays only) that the bundled editor script turns into sliced
 * sprites with custom pivots and one AnimationClip per clip. Rects are given in Unity's bottom-up pixels.
 */
export function unitySheetJson(set: SpriteSheetSet, images: string[], pixelsPerUnit = 100) {
  return {
    generator: "OpenBone",
    version: 1,
    pixelsPerUnit,
    sheets: set.pages.map((p, i) => ({ image: images[i], width: p.width, height: p.height })),
    frames: set.frames.map((f) => {
      const page = set.pages[f.sheet];
      const s = f.spriteSourceSize;
      // Pivot = skeleton origin, as a fraction of the trimmed rect (Unity: bottom-up, may lie outside 0..1).
      const px = (set.origin.x - s.x) / s.w;
      const py = 1 - (set.origin.y - s.y) / s.h;
      return {
        name: f.name,
        sheet: f.sheet,
        x: f.frame.x,
        y: page.height - f.frame.y - f.frame.h,
        width: f.frame.w,
        height: f.frame.h,
        pivotX: round4(px),
        pivotY: round4(py),
        alias: f.aliasOf ?? "",
      };
    }),
    clips: set.clips.map((c) => ({ name: c.name, fps: c.fps, loop: c.loop, frames: c.frames })),
  };
}

const gdString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const gdNum = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(round4(n)));

/**
 * Godot 4 `SpriteFrames` resource: one AtlasTexture per unique frame (margin restores trimmed borders, so every
 * frame keeps the full source size), one animation per clip with its fps and loop.
 * `texturePaths[i]` is the res:// path of sheet i.
 */
export function godotSpriteFrames(set: SpriteSheetSet, texturePaths: string[]): string {
  const out: string[] = [];
  const uniques = set.frames.filter((f) => !f.aliasOf);
  const subId = new Map<string, string>();
  uniques.forEach((f, i) => subId.set(f.name, `AtlasTexture_${i}`));
  out.push(`[gd_resource type="SpriteFrames" load_steps=${texturePaths.length + uniques.length + 1} format=3]`, "");
  texturePaths.forEach((p, i) => out.push(`[ext_resource type="Texture2D" path=${gdString(p)} id="${i + 1}_sheet"]`));
  out.push("");
  for (const f of uniques) {
    const s = f.spriteSourceSize;
    out.push(`[sub_resource type="AtlasTexture" id="${subId.get(f.name)}"]`);
    out.push(`atlas = ExtResource("${f.sheet + 1}_sheet")`);
    out.push(`region = Rect2(${f.frame.x}, ${f.frame.y}, ${f.frame.w}, ${f.frame.h})`);
    if (f.trimmed) out.push(`margin = Rect2(${s.x}, ${s.y}, ${f.sourceSize.w - s.w}, ${f.sourceSize.h - s.h})`);
    out.push("");
  }
  const byName = new Map(set.frames.map((f) => [f.name, f]));
  const anims = set.clips.map((c) => {
    const frames = c.frames.map((n) => {
      const f = byName.get(n)!;
      return `{\n"duration": 1.0,\n"texture": SubResource("${subId.get(f.aliasOf ?? f.name)}")\n}`;
    });
    return `{\n"frames": [${frames.join(", ")}],\n"loop": ${c.loop},\n"name": &${gdString(c.name)},\n"speed": ${gdNum(c.fps)}\n}`;
  });
  out.push("[resource]", `animations = [${anims.join(", ")}]`, "");
  return out.join("\n");
}

/** Godot 4 scene with an AnimatedSprite2D whose node position is the skeleton origin. */
export function godotScene(set: SpriteSheetSet, nodeName: string, framesPath: string): string {
  const first = set.clips[0]?.name ?? "default";
  return [
    `[gd_scene load_steps=2 format=3]`,
    "",
    `[ext_resource type="SpriteFrames" path=${gdString(framesPath)} id="1_frames"]`,
    "",
    `[node name=${gdString(nodeName)} type="AnimatedSprite2D"]`,
    `sprite_frames = ExtResource("1_frames")`,
    `animation = &${gdString(first)}`,
    `autoplay = ${gdString(first)}`,
    `centered = false`,
    `offset = Vector2(${gdNum(-set.origin.x)}, ${gdNum(-set.origin.y)})`,
    "",
  ].join("\n");
}

/** Safe file/identifier stem: letters, digits, dashes and underscores. */
export const safeName = (s: string) => s.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "animation";

export interface EnginePackOptions {
  /** Base name of the files (sanitised). */
  name: string;
  /** Output pixels per artboard pixel (recorded in metadata). */
  scale?: number;
  /** Godot: folder the pack is copied to inside the project. Default `res://openbone/<name>/`. */
  godotRoot?: string;
  /** Unity pixels per unit. Default 100. */
  pixelsPerUnit?: number;
}

export interface PackFile {
  name: string;
  data: Uint8Array;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const text = (s: string) => new TextEncoder().encode(s);

const clipTable = (set: SpriteSheetSet) =>
  set.clips.map((c) => `| ${c.name} | ${c.frames.length} | ${c.fps} | ${c.loop ? "yes" : "no"} |`).join("\n");

const header = (set: SpriteSheetSet, title: string, images: string[]) => `# ${title}

Exported from OpenBone. ${set.frames.length} frames in ${images.length} sheet${images.length === 1 ? "" : "s"} (${images.join(", ")}).
Every frame is ${set.sourceSize.w}×${set.sourceSize.h} px before trimming; the skeleton origin is at
(${round4(set.origin.x)}, ${round4(set.origin.y)}) px from the frame's top-left and is used as the pivot.

| Clip | Frames | FPS | Loop |
| --- | --- | --- | --- |
${clipTable(set)}
`;

/** The files of one engine pack (sheets, metadata, code, README). */
export async function enginePackFiles(engine: SheetEngine, set: SpriteSheetSet, o: EnginePackOptions): Promise<PackFile[]> {
  const base = safeName(o.name);
  const scale = o.scale ?? 1;
  const images = set.pages.map((_, i) => (set.pages.length === 1 ? `${base}.png` : `${base}-${i}.png`));
  const files: PackFile[] = [];
  const add = (name: string, data: string | Uint8Array) => files.push({ name, data: typeof data === "string" ? text(data) : data });
  for (let i = 0; i < set.pages.length; i++) add(images[i], await encodePng(set.pages[i].image));
  const hashName = (i: number) => images[i].replace(/\.png$/, ".json");
  const addHash = () => set.pages.forEach((_, i) => add(hashName(i), json(texturePackerHash(set, i, images, scale))));

  switch (engine) {
    case "unity": {
      addHash();
      add(`${base}.unity.json`, json(unitySheetJson(set, images, o.pixelsPerUnit ?? 100)));
      add("Editor/OpenBoneSpriteSheetImporter.cs", UNITY_IMPORTER_CS);
      add("README.md", unityReadme(set, base, images));
      break;
    }
    case "godot": {
      const root = (o.godotRoot ?? `res://openbone/${base}/`).replace(/\/?$/, "/");
      add(`${base}.tres`, godotSpriteFrames(set, images.map((n) => root + n)));
      add(`${base}.tscn`, godotScene(set, base, `${root}${base}.tres`));
      addHash();
      add("README.md", godotReadme(set, base, images, root));
      break;
    }
    case "flutter": {
      addHash();
      add("lib/openbone_sprite_sheet.dart", FLUTTER_SHEET_DART);
      add("lib/openbone_flame.dart", FLAME_COMPONENT_DART);
      add("README.md", flutterReadme(set, base, images));
      break;
    }
    case "generic": {
      addHash();
      set.pages.forEach((_, i) => add(images[i].replace(/\.png$/, ".array.json"), json(texturePackerArray(set, i, images, scale))));
      add(`${base}.multiatlas.json`, json(phaserMultiAtlas(set, images, scale)));
      add("README.md", genericReadme(set, base, images));
      break;
    }
  }
  return files;
}

/** A whole engine pack as a ZIP, everything inside a `<name>/` folder. */
export async function enginePackZip(engine: SheetEngine, set: SpriteSheetSet, o: EnginePackOptions): Promise<Uint8Array> {
  const base = safeName(o.name);
  const files = await enginePackFiles(engine, set, o);
  return createZip(files.map((f) => ({ name: `${base}/${f.name}`, data: f.data })));
}

function unityReadme(set: SpriteSheetSet, base: string, images: string[]) {
  return `${header(set, `${base}: Unity sprite sheet`, images)}
## Files

- \`${images.join("`, `")}\`: the sprite sheet texture${images.length === 1 ? "" : "s"}.
- \`${base}.unity.json\`: frame rects (bottom-up, as Unity uses), pivots and clips, for the importer script.
- \`${images.map((n) => n.replace(/\.png$/, ".json")).join("`, `")}\`: TexturePacker JSON (Hash), for other tools.
- \`Editor/OpenBoneSpriteSheetImporter.cs\`: a small editor script that slices the sheet and builds the clips.

## Import (recommended: the importer script)

1. Copy this whole folder into your project's \`Assets/\` (keep \`Editor/\` inside it, or move the script to any \`Editor\` folder).
2. Wait for Unity to compile, select \`${base}.unity.json\` in the Project window and choose
   **Assets → OpenBone → Import Sprite Sheet** (also in the right-click menu).
3. The script sets the texture to *Sprite (2D and UI)*, *Multiple*, no compression, and slices one sprite per frame
   with its pivot at the skeleton origin. It then creates one \`.anim\` clip per animation (frame rate and loop set)
   next to the JSON.
4. Drag the first sprite into the scene (that makes a \`SpriteRenderer\`), add an \`Animator\`, and drag a clip onto the
   object: Unity creates an Animator Controller with that clip.

## Import by hand (no script)

1. Select the PNG, set **Texture Type** to *Sprite (2D and UI)* and **Sprite Mode** to *Multiple*, Apply.
2. Open the **Sprite Editor** and slice each frame using the rects in \`${base}.unity.json\` (\`x\`, \`y\`, \`width\`,
   \`height\` are already bottom-up). Set **Pivot** to *Custom* with \`pivotX\`, \`pivotY\`.
3. Select a clip's sprites in order and drag them into the scene; Unity makes an Animation clip. Set its
   **Samples** (frame rate) from the table above.

## Notes

- Frames that are pixel-identical are stored once (\`alias\` in the JSON); the importer reuses the sprite.
- Not tested inside Unity in this export: the script targets Unity 2021.3+ (\`TextureImporter.spritesheet\`; Unity 6 still
  supports it but marks it obsolete in favour of the 2D Sprite package's data provider API).
- Need state machines, inputs or scripts? Use the OpenBone **Android/iOS/Flutter WebView** packages, or keep the
  logic in an Animator Controller.
`;
}

function godotReadme(set: SpriteSheetSet, base: string, images: string[], root: string) {
  return `${header(set, `${base}: Godot 4 sprite frames`, images)}
## Files

- \`${images.join("`, `")}\`: the sprite sheet texture${images.length === 1 ? "" : "s"}.
- \`${base}.tres\`: a \`SpriteFrames\` resource. One \`AtlasTexture\` per frame (its \`margin\` restores trimmed borders),
  one animation per clip with its speed (fps) and loop.
- \`${base}.tscn\`: an example scene with an \`AnimatedSprite2D\` using it; its position is the skeleton origin.
- \`*.json\`: TexturePacker JSON (Hash), for other tools.

## Import

1. Copy this folder so the files end up at **\`${root}\`** (the resource refers to the sheets there).
   To use another folder, re-export with a different Godot path, or search and replace \`${root}\` in the \`.tres\`/\`.tscn\`.
2. Godot imports the PNGs automatically. For pixel art, set the texture filter to *Nearest* on the node or in
   Project Settings.
3. Open or instance \`${base}.tscn\`, or add an \`AnimatedSprite2D\` and set **Sprite Frames** to \`${base}.tres\`.
4. Play from code:

\`\`\`gdscript
$${base}.play("${set.clips[0]?.name ?? "default"}")
\`\`\`

Not opened in Godot in this export; the files follow the Godot 4 text resource format (\`format=3\`).
`;
}

function flutterReadme(set: SpriteSheetSet, base: string, images: string[]) {
  const clip = set.clips[0]?.name ?? "default";
  return `${header(set, `${base}: Flutter sprite sheet`, images)}
## Files

- \`${images.join("`, `")}\` + \`${images.map((n) => n.replace(/\.png$/, ".json")).join("`, `")}\`: sheets and TexturePacker JSON (Hash).
- \`lib/openbone_sprite_sheet.dart\`: no dependencies. Loads the JSON + sheets and plays a clip with a \`CustomPainter\`
  (trim offsets and pivot handled).
- \`lib/openbone_flame.dart\`: optional, for the [flame](https://pub.dev/packages/flame) game engine.

## Plain Flutter

1. Copy the PNG and JSON files to \`assets/openbone/${base}/\` and list the folder in \`pubspec.yaml\`:

\`\`\`yaml
flutter:
  assets:
    - assets/openbone/${base}/
\`\`\`

2. Copy \`lib/openbone_sprite_sheet.dart\` into your \`lib/\` and use it:

\`\`\`dart
import 'openbone_sprite_sheet.dart';

FutureBuilder<OpenBoneSpriteSheet>(
  future: OpenBoneSpriteSheet.load('assets/openbone/${base}/${base}.json'),
  builder: (context, snap) => snap.hasData
      ? OpenBoneSpriteAnimation(sheet: snap.data!, clip: '${clip}', width: 200, height: 200)
      : const SizedBox.shrink(),
);
\`\`\`

## Flame

Add \`flame\` to \`pubspec.yaml\`, copy both Dart files, put the assets under \`assets/images/\` (Flame's image root),
then:

\`\`\`dart
final sheet = await OpenBoneSpriteSheet.load('assets/images/${base}.json');
final sprite = OpenBoneSpriteComponent(sheet, clip: '${clip}', position: Vector2(200, 300)); // position = skeleton origin
add(sprite);
sprite.play('${set.clips[1]?.name ?? clip}'); // switch clips any time
\`\`\`

\`OpenBoneSpriteComponent\` draws each frame at its trim offset, so trimmed frames do not jitter. Flame's own
\`SpriteAnimation.spriteList\` also works if you export with **Trim** off.

Not compiled in this export (no Flutter toolchain was available); the code targets Dart 3 / Flutter 3.x and flame 1.x.

Need bones, meshes, state machines, inputs or scripts instead of baked frames? Export the runtime file (\`.obone\` /
\`.obonb\`) and play it with the native [\`openbone\` Flutter plugin](${NATIVE_FLUTTER_URL}) (\`OpenBoneWidget\`), or
use the Flutter WebView package.
`;
}

function genericReadme(set: SpriteSheetSet, base: string, images: string[]) {
  const clip = set.clips[0]?.name ?? "default";
  return `${header(set, `${base}: sprite sheet`, images)}
## Files

- \`${images.join("`, `")}\`: sprite sheet texture${images.length === 1 ? "" : "s"}.
- \`*.json\`: TexturePacker **JSON (Hash)** per sheet, with \`animations\` (clip → frame names).
- \`*.array.json\`: TexturePacker **JSON (Array)** per sheet.
- \`${base}.multiatlas.json\`: Phaser 3 multi-atlas (all sheets in one file).

Fps, loop and the origin are in \`meta.openbone\` (TexturePacker formats have no field for them).
Frames are trimmed: draw each at \`spriteSourceSize.x/y\` inside a \`sourceSize\` box, or let the engine do it (all below do).

## PixiJS (v7/v8)

\`\`\`js
const sheet = await PIXI.Assets.load('${images[0].replace(/\.png$/, ".json")}');
const sprite = new PIXI.AnimatedSprite(sheet.animations['${clip}']);
sprite.anchor.set(${round4(set.origin.x / set.sourceSize.w)}, ${round4(set.origin.y / set.sourceSize.h)}); // skeleton origin
sprite.animationSpeed = ${set.clips[0]?.fps ?? 30} / 60;
sprite.play();
\`\`\`

## Phaser 3

\`\`\`js
this.load.multiatlas('${base}', '${base}.multiatlas.json');
// in create():
this.anims.create({ key: '${clip}', frames: this.anims.generateFrameNames('${base}', { prefix: '${clip}_', start: 1, end: ${set.clips[0]?.frames.length ?? 1}, zeroPad: 4 }), frameRate: ${set.clips[0]?.fps ?? 30}, repeat: ${set.clips[0]?.loop === false ? 0 : -1} });
this.add.sprite(400, 300, '${base}').play('${clip}');
\`\`\`

## Cocos Creator

Cocos reads TexturePacker plists, not JSON; most other tools (Defold, LibGDX via TexturePacker, Construct, GameMaker
plug-ins) read JSON (Hash). Import the PNG and slice by the rects in the JSON if your tool needs it.
`;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
