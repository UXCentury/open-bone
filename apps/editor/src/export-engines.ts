import { type OpenBoneDocument, exportDocument, serialize, serializeBinary } from "@openbone/core";
import { type SheetClipInput, type SheetEngine, type SpriteSheetSet, buildSpriteSheets, enginePackZip, safeName, webViewPackZip } from "@openbone/export";
import { Skeleton, applyAnimation } from "@openbone/runtime";
import { packForExport } from "./atlas.ts";
import { frameTimes, renderFrames } from "./export-media.ts";
import { imageAsDataUrl } from "./images.ts";

/**
 * Engine and platform exports: sprite-sheet packs (Unity, Godot, Flutter, generic) rendered from animations, and
 * interactive WebView packages (Flutter, Android, iOS) that embed the web player.
 */

export type EngineTarget = "unity" | "godot" | "flutter" | "generic" | "android" | "ios";
export type WebViewTarget = "flutter" | "android" | "ios";

export const ENGINES: Record<EngineTarget, { label: string; sheet: boolean; webview: boolean; note: string }> = {
  unity: { label: "Unity", sheet: true, webview: false, note: "Sprite sheet PNG + TexturePacker JSON with pivots + an editor script that slices it and builds one Animation clip per animation." },
  godot: { label: "Godot 4", sheet: true, webview: false, note: "Sprite sheet PNG + a ready SpriteFrames .tres (fps, loop, trimmed AtlasTextures) + an AnimatedSprite2D .tscn." },
  flutter: { label: "Flutter", sheet: true, webview: true, note: "" },
  generic: { label: "Sprite sheet", sheet: true, webview: false, note: "Sprite sheet PNG + TexturePacker JSON (hash and array) + Phaser multi-atlas, for PixiJS, Phaser, Cocos and others." },
  android: { label: "Android", sheet: false, webview: true, note: "Kotlin OpenBoneView (WebView) + the web player and your animation as assets. State machines, inputs, scripts and touch keep working." },
  ios: { label: "iOS", sheet: false, webview: true, note: "Swift OpenBoneView (WKWebView) with a SwiftUI wrapper + the web player and your animation. State machines, inputs, scripts and touch keep working." },
};
export const FLUTTER_NOTES = {
  sheet: "Sprite sheet PNG + JSON + a dependency-free Dart player widget (CustomPainter) and a Flame component.",
  webview: "webview_flutter widget + controller (inputs, triggers, message stream) + the web player and your animation as assets. State machines, inputs, scripts and touch keep working.",
};

export interface SheetExportOptions {
  /** Animation ids, one clip each. */
  animations: string[];
  skin: string | null;
  fps: number;
  scale: number;
  loop: boolean;
  trim: boolean;
  padding: number;
  maxSize: number;
  powerOfTwo: boolean;
  /** "artboard": every frame is the artboard; "content": the union of everything drawn by the chosen animations. */
  area: "artboard" | "content";
  contentPadding: number;
  godotRoot?: string;
}

/**
 * A copy of `doc` whose artboard is the union of the skeleton bounds over every frame of the chosen animations
 * (plus padding), so all clips share one frame size and origin.
 */
export function contentArtboard(doc: OpenBoneDocument, o: Pick<SheetExportOptions, "animations" | "skin" | "fps" | "contentPadding">): OpenBoneDocument {
  const sk = new Skeleton(doc);
  if (o.skin) sk.setSkin(o.skin);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of o.animations) {
    const anim = doc.animations.find((a) => a.id === id);
    if (!anim) continue;
    for (const t of frameTimes(doc, { animation: id, fps: o.fps, sequence: true, time: 0 }, "png")) {
      sk.setToSetupPose();
      applyAnimation(sk, anim, t);
      sk.updateWorldTransform();
      const b = sk.bounds();
      if (!Number.isFinite(b.minX)) continue;
      minX = Math.min(minX, b.minX);
      maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY);
      maxY = Math.max(maxY, b.maxY);
    }
  }
  if (!Number.isFinite(minX)) return doc;
  const p = o.contentPadding;
  // Artboard is y-down with skeleton (0,0) at originX/originY; skeleton space is y-up.
  return { ...doc, width: Math.ceil(maxX - minX + 2 * p), height: Math.ceil(maxY - minY + 2 * p), originX: -minX + p, originY: maxY + p };
}

/** Render every chosen animation and pack the frames into sprite sheets. `onProgress` gets 0..1. */
export async function renderSpriteSheets(doc: OpenBoneDocument, o: SheetExportOptions, onProgress?: (stage: string, p: number) => void): Promise<SpriteSheetSet> {
  if (!o.animations.length) throw new Error("Choose at least one animation");
  const d = o.area === "content" ? contentArtboard(doc, o) : doc;
  const clips: SheetClipInput[] = [];
  for (let i = 0; i < o.animations.length; i++) {
    const anim = d.animations.find((a) => a.id === o.animations[i]);
    if (!anim) continue;
    const r = await renderFrames(
      d,
      { animation: anim.id, skin: o.skin, fps: o.fps, scale: o.scale, area: "artboard", padding: 0, background: null, sequence: true, time: 0, quality: 1, loops: 0 },
      "png",
      (p) => onProgress?.(`Rendering ${anim.name}`, (i + p) / o.animations.length),
    );
    clips.push({ name: safeName(anim.name), fps: o.fps, loop: o.loop, frames: r.frames });
  }
  onProgress?.("Packing", 1);
  await new Promise((res) => setTimeout(res));
  return buildSpriteSheets(clips, {
    trim: o.trim,
    padding: o.padding,
    maxSize: o.maxSize,
    powerOfTwo: o.powerOfTwo,
    origin: { x: d.originX * o.scale, y: d.originY * o.scale },
  });
}

export async function exportSpritePack(engine: SheetEngine, doc: OpenBoneDocument, o: SheetExportOptions, baseName: string, onProgress?: (stage: string, p: number) => void) {
  const set = await renderSpriteSheets(doc, o, onProgress);
  onProgress?.("Writing ZIP", 1);
  const data = await enginePackZip(engine, set, { name: baseName, scale: o.scale, godotRoot: o.godotRoot });
  return { data, set };
}

export interface WebViewExportOptions {
  /** State machine to start (name), or null for the first one / first animation. */
  stateMachine: string | null;
  /** Pack images into an atlas (fewer draw calls); otherwise images are embedded one by one. */
  pack: boolean;
  binary: boolean;
  background: string | null;
  androidPackage: string;
}

/** The player bundle source: built by the Vite plugin in apps/editor/vite.config.ts, loaded on first use. */
export async function playerBundle(): Promise<string> {
  return (await import("virtual:openbone-player-bundle")).default;
}

/** The runtime document for a WebView package: everything interactive kept, images embedded or packed. */
export async function webViewDocument(source: OpenBoneDocument, o: Pick<WebViewExportOptions, "pack" | "binary">): Promise<{ bytes: Uint8Array; doc: OpenBoneDocument }> {
  const { doc } = exportDocument(source, { pruneUnused: true, nonessential: false, cleanUpAnimations: false });
  let d: OpenBoneDocument;
  if (o.pack && doc.images.length) d = (await packForExport(doc, { padding: 2, maxSize: 2048, powerOfTwo: false })).doc;
  else {
    d = structuredClone(doc);
    for (const img of d.images) if (img.src) img.src = await imageAsDataUrl(img);
    for (const page of d.atlas?.pages ?? []) page.src = await imageAsDataUrl(page);
  }
  const bytes = o.binary ? serializeBinary(d, { precision: "float32" }) : new TextEncoder().encode(serialize(d));
  return { bytes, doc: d };
}

export async function exportWebViewPack(platform: WebViewTarget, source: OpenBoneDocument, o: WebViewExportOptions, baseName: string, title: string, onProgress?: (stage: string, p: number) => void) {
  onProgress?.("Preparing animation", 0);
  const { bytes, doc } = await webViewDocument(source, o);
  onProgress?.("Loading player bundle", 0.5);
  const bundle = await playerBundle();
  const sm = (o.stateMachine ? doc.stateMachines.find((s) => s.name === o.stateMachine) : null) ?? doc.stateMachines[0];
  onProgress?.("Writing ZIP", 1);
  return webViewPackZip(platform, {
    name: baseName,
    title,
    doc: bytes,
    docExt: o.binary ? "obonb" : "obone",
    bundle,
    stateMachine: sm?.name,
    background: o.background,
    inputs: sm?.inputs.map((i) => ({ name: i.name, type: i.type })) ?? [],
    androidPackage: o.androidPackage,
  });
}
