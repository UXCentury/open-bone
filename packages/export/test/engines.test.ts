import { describe, expect, it } from "vitest";
import {
  type Frame,
  type SheetClipInput,
  buildSpriteSheets,
  enginePackFiles,
  godotScene,
  godotSpriteFrames,
  phaserMultiAtlas,
  texturePackerArray,
  texturePackerHash,
  trimBounds,
  unitySheetJson,
  webViewHtml,
  webViewPackFiles,
} from "../src/index.ts";

const W = 40;
const H = 30;

/** A transparent W x H frame with an opaque w x h block at x, y (colour varies with `c`). */
function block(x: number, y: number, w: number, h: number, c = 255): Frame {
  const data = new Uint8Array(W * H * 4);
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      const o = (j * W + i) * 4;
      data.set([c, 0, 0, 255], o);
    }
  return { width: W, height: H, data };
}

const clips = (): SheetClipInput[] => [
  { name: "walk", fps: 24, loop: true, frames: [block(2, 3, 10, 8), block(12, 3, 10, 8, 200), block(2, 3, 10, 8)] },
  { name: "jump", fps: 12, loop: false, frames: [block(5, 5, 4, 20, 100), block(0, 0, 0, 0)] },
];

describe("trimBounds", () => {
  it("finds the opaque rect", () => {
    expect(trimBounds(block(2, 3, 10, 8))).toEqual({ x: 2, y: 3, w: 10, h: 8 });
    expect(trimBounds(block(0, 0, W, H))).toEqual({ x: 0, y: 0, w: W, h: H });
  });
  it("trims an empty frame to 1x1", () => {
    expect(trimBounds(block(0, 0, 0, 0))).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("respects the alpha threshold", () => {
    const f = block(4, 4, 2, 2);
    f.data[3] = 10; // faint pixel at 0,0
    expect(trimBounds(f)).toEqual({ x: 0, y: 0, w: 6, h: 6 });
    expect(trimBounds(f, 16)).toEqual({ x: 4, y: 4, w: 2, h: 2 });
  });
});

describe("buildSpriteSheets", () => {
  const set = buildSpriteSheets(clips(), { padding: 2, origin: { x: 20, y: 25 } });

  it("names frames per clip and keeps clip order, fps and loop", () => {
    expect(set.clips).toEqual([
      { name: "walk", fps: 24, loop: true, frames: ["walk_0001", "walk_0002", "walk_0003"] },
      { name: "jump", fps: 12, loop: false, frames: ["jump_0001", "jump_0002"] },
    ]);
    expect(set.frames).toHaveLength(5);
  });

  it("records trim offsets and the source size", () => {
    const f = set.frames.find((x) => x.name === "walk_0002")!;
    expect(f.trimmed).toBe(true);
    expect(f.spriteSourceSize).toEqual({ x: 12, y: 3, w: 10, h: 8 });
    expect(f.sourceSize).toEqual({ w: W, h: H });
    expect(f.frame.w).toBe(10);
    expect(f.frame.h).toBe(8);
    expect(f.pivot).toEqual({ x: 0.5, y: 0.8333 });
  });

  it("stores identical frames once", () => {
    const a = set.frames.find((x) => x.name === "walk_0001")!;
    const c = set.frames.find((x) => x.name === "walk_0003")!;
    expect(c.aliasOf).toBe("walk_0001");
    expect(c.frame).toEqual(a.frame);
    expect(set.frames.filter((f) => !f.aliasOf)).toHaveLength(4);
  });

  it("composites the trimmed pixels at the packed position, with padding and no overlaps", () => {
    const page = set.pages[0];
    for (const f of set.frames.filter((x) => !x.aliasOf)) {
      expect(f.frame.x).toBeGreaterThanOrEqual(2);
      expect(f.frame.y).toBeGreaterThanOrEqual(2);
      expect(f.frame.x + f.frame.w).toBeLessThanOrEqual(page.width - 2);
      expect(f.frame.y + f.frame.h).toBeLessThanOrEqual(page.height - 2);
      if (f.name === "jump_0002") continue; // empty frame: a 1x1 transparent pixel
      // Top-left pixel of the trimmed rect is opaque.
      const o = (f.frame.y * page.width + f.frame.x) * 4;
      expect(page.image.data[o + 3]).toBe(255);
    }
    const rects = set.frames.filter((x) => !x.aliasOf).map((x) => x.frame);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const apart = a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x || a.y + a.h + 2 <= b.y || b.y + b.h + 2 <= a.y;
        expect(apart).toBe(true);
      }
  });

  it("keeps full frames when trimming is off", () => {
    const s = buildSpriteSheets(clips(), { trim: false, dedupe: false, padding: 0 });
    expect(s.frames.every((f) => !f.trimmed && f.frame.w === W && f.frame.h === H)).toBe(true);
    expect(s.frames.every((f) => !f.aliasOf)).toBe(true);
  });

  it("splits over several sheets when they do not fit, and honours power-of-two", () => {
    const many: SheetClipInput[] = [{ name: "a", fps: 10, loop: true, frames: Array.from({ length: 6 }, (_, i) => block(0, 0, W, H, 10 + i)) }];
    const s = buildSpriteSheets(many, { padding: 0, maxSize: 64, powerOfTwo: true });
    expect(s.pages.length).toBeGreaterThan(1);
    for (const p of s.pages) {
      expect(Math.log2(p.width) % 1).toBe(0);
      expect(Math.log2(p.height) % 1).toBe(0);
    }
    expect(new Set(s.frames.map((f) => f.sheet)).size).toBe(s.pages.length);
  });

  it("rejects mismatched frame sizes and duplicate clip names", () => {
    expect(() => buildSpriteSheets([{ name: "x", fps: 1, loop: true, frames: [block(0, 0, 1, 1), { width: 2, height: 2, data: new Uint8Array(16) }] }])).toThrow(/expected/);
    expect(() => buildSpriteSheets([...clips(), clips()[0]])).toThrow(/Two clips/);
  });
});

describe("metadata writers", () => {
  const set = buildSpriteSheets(clips(), { padding: 2, origin: { x: 20, y: 25 } });
  const images = ["hero.png"];

  it("TexturePacker hash: frames keyed by name with pivot, animations and meta", () => {
    const j = JSON.parse(JSON.stringify(texturePackerHash(set, 0, images, 0.5)));
    expect(Object.keys(j.frames)).toEqual(["walk_0001", "walk_0002", "walk_0003", "jump_0001", "jump_0002"]);
    const f = j.frames.walk_0002;
    expect(Object.keys(f).sort()).toEqual(["frame", "pivot", "rotated", "sourceSize", "spriteSourceSize", "trimmed"]);
    expect(f.rotated).toBe(false);
    expect(j.animations).toEqual({ walk: ["walk_0001", "walk_0002", "walk_0003"], jump: ["jump_0001", "jump_0002"] });
    expect(j.meta).toMatchObject({ app: "OpenBone", image: "hero.png", format: "RGBA8888", size: { w: set.pages[0].width, h: set.pages[0].height }, scale: "0.5" });
    expect(j.meta.openbone.clips).toEqual([
      { name: "walk", fps: 24, loop: true, frames: 3 },
      { name: "jump", fps: 12, loop: false, frames: 2 },
    ]);
    expect(j.meta.related_multi_packs).toBeUndefined();
  });

  it("TexturePacker array and Phaser multi-atlas", () => {
    const a = texturePackerArray(set, 0, images);
    expect(a.frames.map((f) => f.filename)).toEqual(["walk_0001", "walk_0002", "walk_0003", "jump_0001", "jump_0002"]);
    const m = phaserMultiAtlas(set, images);
    expect(m.textures).toHaveLength(1);
    expect(m.textures[0].frames).toHaveLength(5);
    expect(m.textures[0].image).toBe("hero.png");
  });

  it("multi-sheet hash files point at each other", () => {
    const many: SheetClipInput[] = [{ name: "a", fps: 10, loop: true, frames: Array.from({ length: 6 }, (_, i) => block(0, 0, W, H, 10 + i)) }];
    const s = buildSpriteSheets(many, { padding: 0, maxSize: 64 });
    const imgs = s.pages.map((_, i) => `a-${i}.png`);
    const j0 = texturePackerHash(s, 0, imgs);
    expect(j0.meta.related_multi_packs).toEqual(imgs.slice(1).map((n) => n.replace(".png", ".json")));
    const total = s.pages.reduce((n, _, i) => n + Object.keys(texturePackerHash(s, i, imgs).frames).length, 0);
    expect(total).toBe(6);
  });

  it("Unity JSON: bottom-up rects and pivots relative to the trimmed rect", () => {
    const u = unitySheetJson(set, images, 64);
    expect(u.pixelsPerUnit).toBe(64);
    const f = u.frames.find((x) => x.name === "walk_0002")!;
    const src = set.frames.find((x) => x.name === "walk_0002")!;
    expect(f.y).toBe(set.pages[0].height - src.frame.y - src.frame.h);
    // origin (20, 25) inside trimmed rect (12, 3, 10, 8): x = 0.8, y (bottom-up) = 1 - 22/8
    expect(f.pivotX).toBeCloseTo(0.8);
    expect(f.pivotY).toBeCloseTo(1 - 22 / 8);
    expect(u.frames.find((x) => x.name === "walk_0003")!.alias).toBe("walk_0001");
    expect(u.clips[1]).toEqual({ name: "jump", fps: 12, loop: false, frames: ["jump_0001", "jump_0002"] });
  });

  it("Godot SpriteFrames .tres: resources, margins and animations", () => {
    const tres = godotSpriteFrames(set, ["res://openbone/hero/hero.png"]);
    const lines = tres.split("\n");
    expect(lines[0]).toBe('[gd_resource type="SpriteFrames" load_steps=6 format=3]');
    expect(tres).toContain('[ext_resource type="Texture2D" path="res://openbone/hero/hero.png" id="1_sheet"]');
    const subs = [...tres.matchAll(/\[sub_resource type="AtlasTexture" id="([^"]+)"\]/g)].map((m) => m[1]);
    expect(subs).toHaveLength(4); // 5 frames, one alias
    // Every SubResource reference exists, every sub has an atlas + region.
    for (const ref of tres.matchAll(/SubResource\("([^"]+)"\)/g)) expect(subs).toContain(ref[1]);
    expect(tres.match(/atlas = ExtResource\("1_sheet"\)/g)).toHaveLength(4);
    expect(tres.match(/region = Rect2\(\d+, \d+, \d+, \d+\)/g)).toHaveLength(4);
    const f = set.frames.find((x) => x.name === "walk_0002")!;
    expect(tres).toContain(`region = Rect2(${f.frame.x}, ${f.frame.y}, 10, 8)`);
    expect(tres).toContain(`margin = Rect2(12, 3, ${W - 10}, ${H - 8})`);
    // The animations array: balanced, one entry per clip with name, speed and loop.
    const res = tres.slice(tres.indexOf("[resource]"));
    expect(res.split("[").length).toBe(res.split("]").length);
    expect(res.split("{").length).toBe(res.split("}").length);
    expect(res).toContain('"name": &"walk"');
    expect(res).toContain('"speed": 24.0');
    expect(res).toContain('"loop": false');
    expect(res.match(/"duration": 1\.0/g)).toHaveLength(5);
    // Godot's array/dictionary syntax is JSON-like once &"..." StringNames and SubResource() calls are quoted.
    const asJson = res
      .replace("[resource]\nanimations = ", "")
      .replace(/&"/g, '"')
      .replace(/SubResource\("([^"]+)"\)/g, '"$1"');
    const anims = JSON.parse(asJson);
    expect(anims.map((a: { name: string }) => a.name)).toEqual(["walk", "jump"]);
    expect(anims[0].frames[2].texture).toBe(anims[0].frames[0].texture);
  });

  it("Godot scene puts the origin at the node position", () => {
    const tscn = godotScene(set, "hero", "res://openbone/hero/hero.tres");
    expect(tscn).toContain('[node name="hero" type="AnimatedSprite2D"]');
    expect(tscn).toContain('sprite_frames = ExtResource("1_frames")');
    expect(tscn).toContain('autoplay = "walk"');
    expect(tscn).toContain("centered = false");
    expect(tscn).toContain("offset = Vector2(-20.0, -25.0)");
  });
});

describe("engine packs", () => {
  const set = buildSpriteSheets(clips(), { padding: 2 });
  const names = async (e: Parameters<typeof enginePackFiles>[0]) => (await enginePackFiles(e, set, { name: "My Hero!" })).map((f) => f.name);

  it("lists the files each engine needs", async () => {
    expect(await names("unity")).toEqual(["My_Hero.png", "My_Hero.json", "My_Hero.unity.json", "Editor/OpenBoneSpriteSheetImporter.cs", "README.md"]);
    expect(await names("godot")).toEqual(["My_Hero.png", "My_Hero.tres", "My_Hero.tscn", "My_Hero.json", "README.md"]);
    expect(await names("flutter")).toEqual(["My_Hero.png", "My_Hero.json", "lib/openbone_sprite_sheet.dart", "lib/openbone_flame.dart", "README.md"]);
    expect(await names("generic")).toEqual(["My_Hero.png", "My_Hero.json", "My_Hero.array.json", "My_Hero.multiatlas.json", "README.md"]);
  });

  it("writes valid PNG sheets and parseable JSON", async () => {
    const files = await enginePackFiles("generic", set, { name: "hero" });
    const png = files.find((f) => f.name === "hero.png")!.data;
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const f of files.filter((x) => x.name.endsWith(".json"))) expect(() => JSON.parse(new TextDecoder().decode(f.data))).not.toThrow();
  });

  it("Godot pack uses the chosen res:// root", async () => {
    const files = await enginePackFiles("godot", set, { name: "hero", godotRoot: "res://art/hero" });
    const tres = new TextDecoder().decode(files.find((f) => f.name === "hero.tres")!.data);
    expect(tres).toContain('path="res://art/hero/hero.png"');
  });
});

describe("WebView packages", () => {
  const doc = new TextEncoder().encode('{"format":"openbone"}');
  const opts = { name: "hero", title: "Hero <1>", doc, docExt: "obone" as const, bundle: "/*bundle*/", stateMachine: 'main "sm"', inputs: [{ name: "jump", type: "trigger" as const }] };

  it("HTML embeds the document as base64 and loads the bundle as a classic script", () => {
    const html = webViewHtml(opts);
    expect(html).toContain('<script src="openbone-player.js"></script>');
    expect(html).toContain('data-state-machine="main &quot;sm&quot;"');
    expect(html).toContain('data-background="none"');
    expect(html).toContain("<title>Hero &lt;1></title>");
    const b64 = html.match(/id="openbone-data">\n([\s\S]*?)<\/script>/)![1].replace(/\s+/g, "");
    expect(Buffer.from(b64, "base64").toString()).toBe('{"format":"openbone"}');
  });

  it("each platform ships the web files plus its native code", () => {
    const list = (p: "flutter" | "android" | "ios") => webViewPackFiles(p, opts).map((f) => f.name);
    expect(list("flutter")).toEqual([
      "assets/openbone/hero/index.html",
      "assets/openbone/hero/openbone-player.js",
      "assets/openbone/hero/hero.obone",
      "assets/openbone/hero/preview.html",
      "lib/openbone_view.dart",
      "example/main.dart",
      "README.md",
    ]);
    expect(list("android")).toContain("app/src/main/java/com/openbone/OpenBoneView.kt");
    expect(list("android")).toContain("app/src/main/assets/openbone/hero/index.html");
    expect(list("ios")).toEqual(expect.arrayContaining(["OpenBone/hero/index.html", "Sources/OpenBoneView.swift", "Sources/OpenBoneExample.swift"]));
    const kt = new TextDecoder().decode(webViewPackFiles("android", { ...opts, androidPackage: "app.demo" }).find((f) => f.name.endsWith("OpenBoneView.kt"))!.data);
    expect(kt).toContain("package app.demo");
    expect(kt).toContain('addJavascriptInterface(HostBridge(), "OpenBoneHost")');
    const readme = new TextDecoder().decode(webViewPackFiles("ios", opts).find((f) => f.name === "README.md")!.data);
    expect(readme).toContain('controller.fire("jump")');
    const flutter = new TextDecoder().decode(webViewPackFiles("flutter", opts).find((f) => f.name === "README.md")!.data);
    expect(flutter).toContain("runtimes/dart");
    expect(flutter).toContain("OpenBoneWidget.asset('assets/hero.obone'");
  });
});
