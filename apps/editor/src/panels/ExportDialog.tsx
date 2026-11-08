import { type ExportOptions, type ExportResult, animationDuration, exportDocument, serialize, serializeBinary, validate } from "@openbone/core";
import { Player } from "@openbone/player";
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { type PackOutcome, packForExport } from "../atlas.ts";
import { ENGINES, type EngineTarget, FLUTTER_NOTES, type SheetExportOptions, exportSpritePack, exportWebViewPack } from "../export-engines.ts";
import { MEDIA, type MediaFormat, type MediaOptions, exportMedia, frameTimes } from "../export-media.ts";
import { imageAsDataUrl, resolveImageUrl } from "../images.ts";
import { isDesktop, savedToast, saveFile, saveTextFile } from "../storage.ts";
import { animationId, doc, fileName, setExportOpen, toast } from "../state.ts";
import { audioAsDataUrl } from "../audio.ts";
import { exportWebPack, playerSizeKb } from "../export-web.ts";

type Named = { id: string; name: string };
type DataFormat = "project" | "json" | "binary";
type EngineFormat = EngineTarget;
type Format = DataFormat | MediaFormat | EngineFormat;

const GROUPS: { title: string; items: { id: Format; label: string; hint: string }[] }[] = [
  {
    title: "OpenBone",
    items: [{ id: "project", label: "Project", hint: ".obone: the whole project, to open and edit again later" }],
  },
  {
    title: "Data",
    items: [
      { id: "json", label: "JSON", hint: ".json: runtime data with only the parts you choose" },
      { id: "binary", label: "Binary", hint: ".obonb: compact runtime data" },
    ],
  },
  {
    title: "Image",
    items: [
      { id: "png", label: "PNG", hint: "One frame, or a ZIP of frames" },
      { id: "jpeg", label: "JPEG", hint: "One frame, or a ZIP of frames" },
      { id: "gif", label: "GIF", hint: "Animated, 256 colours" },
      { id: "apng", label: "APNG", hint: "Animated PNG, full colour + alpha" },
      { id: "psd", label: "PSD", hint: "Photoshop, frames as layers" },
    ],
  },
  {
    title: "Video",
    items: [
      { id: "avi", label: "AVI", hint: "Motion-JPEG, uncompressed sound" },
      { id: "mp4", label: "MP4", hint: "H.264 with sound, plays everywhere" },
      { id: "mov", label: "MOV", hint: "QuickTime, Motion-JPEG, uncompressed sound" },
    ],
  },
  {
    title: "Web",
    items: [{ id: "web", label: "Website", hint: "ZIP: <openbone-player> library + animation + demo page, or one self-contained HTML file" }],
  },
  {
    title: "Engines",
    items: [
      { id: "unity", label: "Unity", hint: "ZIP: sprite sheet, JSON with pivots, importer script that builds Animation clips" },
      { id: "godot", label: "Godot 4", hint: "ZIP: sprite sheet, SpriteFrames .tres, AnimatedSprite2D scene" },
      { id: "flutter", label: "Flutter", hint: "ZIP: sprite sheet + Dart widget, or an interactive webview_flutter package" },
      { id: "android", label: "Android", hint: "ZIP: interactive Kotlin WebView package" },
      { id: "ios", label: "iOS", hint: "ZIP: interactive Swift WKWebView package (UIKit + SwiftUI)" },
      { id: "generic", label: "Sprite sheet", hint: "ZIP: sprite sheet + TexturePacker JSON for PixiJS, Phaser, Cocos and others" },
    ],
  },
];
const isData = (f: Format): f is DataFormat => f === "project" || f === "json" || f === "binary";
const isEngine = (f: Format): f is EngineFormat => f in ENGINES;
const isProject = (f: Format) => f === "project";
const DATA_EXT: Record<DataFormat, string> = { project: "obone", json: "json", binary: "obonb" };

/** A checklist of named items with All / None shortcuts. */
function Picker(p: { title: string; items: Named[]; selected: Set<string>; onChange: (s: Set<string>) => void; hint?: string }) {
  const toggle = (id: string, on: boolean) => {
    const s = new Set(p.selected);
    on ? s.add(id) : s.delete(id);
    p.onChange(s);
  };
  return (
    <fieldset class="export-group">
      <legend>
        {p.title} <span class="muted">{p.selected.size}/{p.items.length}</span>
        <span class="spacer" />
        <button class="link" onClick={() => p.onChange(new Set(p.items.map((i) => i.id)))} disabled={p.selected.size === p.items.length}>
          All
        </button>
        <button class="link" onClick={() => p.onChange(new Set())} disabled={!p.selected.size}>
          None
        </button>
      </legend>
      <Show when={p.items.length} fallback={<div class="muted">None in this project.</div>}>
        <div class="export-list">
          <For each={p.items}>
            {(it) => (
              <label class="check">
                <input type="checkbox" checked={p.selected.has(it.id)} onChange={(e) => toggle(it.id, e.currentTarget.checked)} /> {it.name}
              </label>
            )}
          </For>
        </div>
      </Show>
      <Show when={p.hint}>
        <div class="muted small">{p.hint}</div>
      </Show>
    </fieldset>
  );
}

function Row(p: { label: string; children: JSX.Element; title?: string }) {
  return (
    <label class="field" title={p.title}>
      <span>{p.label}</span>
      {p.children}
    </label>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

const SETTINGS_KEY = "openbone.export.v1";
interface SavedSettings {
  format?: Format;
  data?: { pretty?: boolean; nonessential?: boolean; cleanUp?: boolean; precision?: "float32" | "float64"; prune?: boolean; embed?: boolean; pack?: boolean; padding?: number; maxSize?: number; pot?: boolean; rotate?: boolean; atlasScale?: number | "auto" };
  media?: Partial<Omit<MediaOptions, "animation" | "skin">> & { transparent?: boolean; animation?: string | null; skin?: string | null };
  picks?: { animations?: string[]; stateMachines?: string[]; scripts?: string[]; skins?: string[] };
  openAfter?: boolean;
  engine?: {
    clips?: string[];
    loop?: boolean;
    trim?: boolean;
    padding?: number;
    maxSize?: number;
    pot?: boolean;
    godotRoot?: string;
    flutterMode?: "sheet" | "webview";
    stateMachine?: string | null;
    pack?: boolean;
    binary?: boolean;
    transparent?: boolean;
    androidPackage?: string;
    /** WebP quality (0..1) for embedded images, or null to keep them as they are. */
    webp?: number | null;
  };
  web?: { format?: "iife" | "esm"; minify?: boolean; scripts?: boolean; singleFile?: boolean; demo?: boolean };
}
const readSaved = (): SavedSettings => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/**
 * Export (like Spine's dialog): data (JSON, binary), images (PNG, JPEG, GIF, APNG, PSD) and video (AVI, MOV).
 * Data exports choose their contents; image and video exports render an animation. A live preview shows the
 * result, settings can be saved to a file and loaded again, and the open project is never changed.
 */
export function ExportDialog() {
  const source = doc();
  const saved = readSaved();
  const all = (list: Named[]) => new Set(list.map((x) => x.id));
  const byNames = (list: Named[], names?: string[]) => (names ? new Set(list.filter((x) => names.includes(x.name)).map((x) => x.id)) : all(list));
  const extraSkins = source.skeleton.skins.slice(1);

  const [format, setFormat] = createSignal<Format>(saved.format ?? "project");
  // ---- data options ----
  // Animations marked "don't export" (helpers, work in progress) start unticked.
  const [anims, setAnims] = createSignal(all(source.animations.filter((a) => a.export !== false)));
  const [sms, setSms] = createSignal(all(source.stateMachines));
  const [scripts, setScripts] = createSignal(all(source.scripts));
  const [skins, setSkins] = createSignal(all(extraSkins));
  const sd = saved.data ?? {};
  const [prune, setPrune] = createSignal(sd.prune ?? true);
  const needsEmbed = source.images.some((i) => !i.src.startsWith("data:")) || !!source.audio?.assets.some((a) => !a.src.startsWith("data:"));
  const [embed, setEmbed] = createSignal(sd.embed ?? needsEmbed);
  const [pretty, setPretty] = createSignal(sd.pretty ?? true);
  const [nonessential, setNonessential] = createSignal(sd.nonessential ?? true);
  const [cleanUp, setCleanUp] = createSignal(sd.cleanUp ?? false);
  const [precision, setPrecision] = createSignal<"float32" | "float64">(sd.precision ?? "float32");
  const [pack, setPack] = createSignal(sd.pack ?? false);
  const [padding, setPadding] = createSignal(sd.padding ?? 2);
  const [maxSize, setMaxSize] = createSignal(sd.maxSize ?? 2048);
  const [pot, setPot] = createSignal(sd.pot ?? true);
  const [rotate, setRotate] = createSignal(sd.rotate ?? false);
  const [atlasScale, setAtlasScale] = createSignal<number | "auto">(sd.atlasScale ?? 1);
  const [packed, setPacked] = createSignal<PackOutcome | null>(null);
  const [packError, setPackError] = createSignal("");
  // ---- media options ----
  const sm = saved.media ?? {};
  const findId = (list: Named[], name?: string | null) => (name ? (list.find((x) => x.name === name)?.id ?? null) : null);
  const [mAnim, setMAnim] = createSignal<string | null>(findId(source.animations, sm.animation) ?? animationId() ?? source.animations[0]?.id ?? null);
  const [mSkin, setMSkin] = createSignal<string | null>(findId(source.skeleton.skins, sm.skin));
  const [fps, setFps] = createSignal(sm.fps ?? source.fps ?? 30);
  const [scale, setScale] = createSignal(sm.scale ?? 1);
  const [area, setArea] = createSignal<"artboard" | "content">(sm.area ?? "artboard");
  const [mPadding, setMPadding] = createSignal(sm.padding ?? 10);
  const [transparent, setTransparent] = createSignal(sm.transparent ?? false);
  const [bgColor, setBgColor] = createSignal(sm.background ?? source.background ?? "#ffffff");
  const [sequence, setSequence] = createSignal(sm.sequence ?? false);
  const [mTime, setMTime] = createSignal(0);
  const [quality, setQuality] = createSignal(sm.quality ?? 0.9);
  const [loops, setLoops] = createSignal(sm.loops ?? 0);
  const [withSound, setWithSound] = createSignal(sm.audio ?? true);
  // ---- engine options ----
  const se = saved.engine ?? {};
  const [eAnims, setEAnims] = createSignal(byNames(source.animations, se.clips));
  const [eLoop, setELoop] = createSignal(se.loop ?? true);
  const [eTrim, setETrim] = createSignal(se.trim ?? true);
  const [ePadding, setEPadding] = createSignal(se.padding ?? 2);
  const [eMaxSize, setEMaxSize] = createSignal(se.maxSize ?? 2048);
  const [ePot, setEPot] = createSignal(se.pot ?? false);
  const [godotRoot, setGodotRoot] = createSignal(se.godotRoot ?? "");
  const [flutterMode, setFlutterMode] = createSignal<"sheet" | "webview">(se.flutterMode ?? "webview");
  const [wvSm, setWvSm] = createSignal<string | null>(source.stateMachines.find((m) => m.name === se.stateMachine)?.name ?? source.stateMachines[0]?.name ?? null);
  const [wvPack, setWvPack] = createSignal(se.pack ?? true);
  const [wvBinary, setWvBinary] = createSignal(se.binary ?? true);
  const [wvTransparent, setWvTransparent] = createSignal(se.transparent ?? true);
  const [wvWebp, setWvWebp] = createSignal<number | null>(se.webp === undefined ? 0.85 : se.webp);
  const [androidPackage, setAndroidPackage] = createSignal(se.androidPackage ?? "com.openbone");
  // ---- web options ----
  const sw = saved.web ?? {};
  const [webFmt, setWebFmt] = createSignal<"iife" | "esm">(sw.format ?? "iife");
  const [webMin, setWebMin] = createSignal(sw.minify ?? true);
  const [webScripts, setWebScripts] = createSignal(sw.scripts ?? source.scripts.length > 0);
  const [webSingle, setWebSingle] = createSignal(sw.singleFile ?? false);
  const [webDemo, setWebDemo] = createSignal(sw.demo ?? true);
  /** The engine being exported, if any. */
  const engine = () => (isEngine(format()) ? (format() as EngineFormat) : null);
  const sheetMode = () => !!engine() && (ENGINES[engine()!].sheet && (engine() !== "flutter" || flutterMode() === "sheet"));
  const webMode = () => !!engine() && !sheetMode();
  const sheetAnims = () => source.animations.filter((a) => eAnims().has(a.id));
  const sheetOptions = (): SheetExportOptions => ({
    animations: sheetAnims().map((a) => a.id),
    skin: mSkin(),
    fps: fps(),
    scale: scale(),
    loop: eLoop(),
    trim: eTrim(),
    padding: ePadding(),
    maxSize: eMaxSize(),
    powerOfTwo: ePot(),
    area: area(),
    contentPadding: mPadding(),
    godotRoot: godotRoot().trim() || undefined,
  });
  const sheetFrames = createMemo(() =>
    sheetMode() ? sheetAnims().reduce((n, a) => n + frameTimes(source, { animation: a.id, fps: fps(), sequence: true, time: 0 }, "png").length, 0) : 0,
  );
  const engineNote = () => {
    const e = engine();
    if (!e) return "";
    return e === "flutter" ? FLUTTER_NOTES[flutterMode()] : ENGINES[e].note;
  };
  // ---- general ----
  const [name, setName] = createSignal(fileName().replace(/\.obone$/i, "") + "-export");
  const [openAfter, setOpenAfter] = createSignal(saved.openAfter ?? false);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  if (saved.picks) {
    setAnims(byNames(source.animations, saved.picks.animations));
    setSms(byNames(source.stateMachines, saved.picks.stateMachines));
    setScripts(byNames(source.scripts, saved.picks.scripts));
    setSkins(byNames(extraSkins, saved.picks.skins));
  }

  const media = () => (isData(format()) || isEngine(format()) ? null : MEDIA[format() as MediaFormat]);
  const mediaOptions = (): MediaOptions => ({
    animation: mAnim(),
    skin: mSkin(),
    fps: fps(),
    scale: scale(),
    area: area(),
    padding: mPadding(),
    background: media()?.alpha && transparent() ? null : bgColor(),
    sequence: sequence(),
    time: mTime(),
    quality: quality(),
    loops: loops(),
    audio: withSound(),
  });

  // ---- data export pipeline ----
  // A project export is the whole document, nothing stripped (only images optionally embedded).
  const options = (): ExportOptions =>
    isProject(format())
      ? { pruneUnused: false, nonessential: true, cleanUpAnimations: false }
      : {
          animations: [...anims()],
          stateMachines: [...sms()],
          scripts: [...scripts()],
          skins: [...skins()],
          pruneUnused: prune(),
          nonessential: nonessential(),
          cleanUpAnimations: cleanUp(),
        };
  const result = createMemo<ExportResult>(() => exportDocument(source, options()));
  const packSettings = () => ({ padding: padding(), maxSize: maxSize(), powerOfTwo: pot(), rotate: rotate(), scale: atlasScale() });
  let packSeq = 0;
  createEffect(
    on([result, pack, padding, maxSize, pot, rotate, atlasScale, format], () => {
      const seq = ++packSeq;
      setPacked(null);
      setPackError("");
      if (!pack() || !isData(format()) || isProject(format())) return;
      packForExport(result().doc, packSettings()).then(
        (r) => seq === packSeq && setPacked(r),
        (e) => seq === packSeq && setPackError((e as Error).message),
      );
    }),
  );
  /** The document a data export writes: packed when the atlas option is on and ready. */
  const usePack = () => pack() && !isProject(format());
  const outDoc = () => (usePack() && packed() ? packed()!.doc : result().doc);
  const issues = createMemo(() => (isData(format()) ? validate(outDoc()).filter((i) => i.level === "error") : []));
  const dataSize = createMemo(() => {
    if (!isData(format())) return 0;
    return format() === "binary" ? serializeBinary(outDoc(), { precision: precision() }).length : (pretty() ? serialize(outDoc()) : JSON.stringify(outDoc())).length;
  });
  const frameCount = createMemo(() => (media() ? frameTimes(source, mediaOptions(), format() as MediaFormat).length : 0));
  const mediaAnim = () => source.animations.find((a) => a.id === mAnim()) ?? null;
  /** Sounds the picked animation plays (audio keys and event keys with a sound). */
  const soundCount = () => {
    const anim = mediaAnim();
    if (!anim) return 0;
    const withAudio = new Set(source.events.filter((e) => e.audio).map((e) => e.id));
    return (anim.audio?.length ?? 0) + anim.events.filter((k) => withAudio.has(k.event)).length;
  };

  const presets = {
    everything: () => {
      setAnims(all(source.animations));
      setSms(all(source.stateMachines));
      setScripts(all(source.scripts));
      setSkins(all(extraSkins));
    },
    animations: () => {
      setAnims(all(source.animations));
      setSms(new Set<string>());
      setScripts(new Set<string>());
    },
    rig: () => {
      setAnims(new Set<string>());
      setSms(new Set<string>());
      setScripts(new Set<string>());
    },
  };

  // ---------- preview ----------
  type Target = { kind: "sm" | "anim"; name: string } | null;
  const targets = createMemo(() => [
    ...result().doc.stateMachines.map((s) => ({ kind: "sm" as const, name: s.name, label: `State machine · ${s.name}` })),
    ...result().doc.animations.map((a) => ({ kind: "anim" as const, name: a.name, label: `Animation · ${a.name}` })),
  ]);
  const [target, setTarget] = createSignal<Target>(null);
  const currentTarget = (): Target => {
    if (media()) return mediaAnim() ? { kind: "anim", name: mediaAnim()!.name } : null;
    if (sheetMode()) return sheetAnims()[0] ? { kind: "anim", name: sheetAnims()[0].name } : null;
    if (webMode()) return wvSm() ? { kind: "sm", name: wvSm()! } : source.animations[0] ? { kind: "anim", name: source.animations[0].name } : null;
    const t = target();
    const list = targets();
    return t && list.some((x) => x.kind === t.kind && x.name === t.name) ? t : (list[0] ?? null);
  };
  const [stage, setStage] = createSignal(0);
  const [status, setStatus] = createSignal("");
  let host!: HTMLDivElement;
  let player: Player | null = null;
  let timer = 0;

  const disposePlayer = () => {
    if (!player) return;
    const canvas = host.querySelector("canvas");
    player.dispose();
    player = null;
    (canvas?.getContext("webgl2") as WebGL2RenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas?.remove();
  };

  const rebuild = () => {
    disposePlayer();
    const d = structuredClone(media() || engine() ? source : outDoc());
    // Preview loads images from where the editor has them; the exported file keeps its own srcs.
    for (const img of d.images) if (img.src) img.src = resolveImageUrl(img);
    for (const page of d.atlas?.pages ?? []) page.src = resolveImageUrl(page);
    const t = currentTarget();
    const canvas = document.createElement("canvas");
    canvas.className = "export-canvas";
    host.append(canvas);
    const bg = media() ? (media()!.alpha && transparent() ? null : bgColor()) : sheetMode() ? null : webMode() ? (wvTransparent() ? null : bgColor()) : undefined;
    setStatus(
      media() || sheetMode()
        ? t
          ? sheetMode() && sheetAnims().length > 1
            ? `Preview of ${t.name} (first of ${sheetAnims().length} clips)`
            : "Preview of the animation that will be rendered"
          : sheetMode()
            ? "Choose at least one animation"
            : "Setup pose"
        : t?.kind === "sm"
          ? "Interactive: hover and click the preview"
          : t
            ? "Looping animation"
            : "Setup pose (nothing animated is exported)",
    );
    const skinName = (media() || sheetMode()) && mSkin() ? source.skeleton.skins.find((k) => k.id === mSkin())?.name : undefined;
    player = new Player({
      canvas,
      src: d,
      ...(t?.kind === "sm" ? { stateMachine: t.name } : t ? { animation: t.name } : {}),
      ...(skinName ? { skin: skinName } : {}),
      ...(bg !== undefined ? { background: bg } : {}),
      fit: "contain",
      audio: false,
      onStateChange: (e) => !media() && !sheetMode() && setStatus(`State: ${e.to}`),
    });
    player.ready.catch((e) => setStatus(`Preview failed: ${(e as Error).message}`));
  };

  onMount(() => {
    rebuild();
    createEffect(
      on([outDoc, currentTarget, stage, format, mSkin, transparent, bgColor, flutterMode, wvTransparent], () => {
        clearTimeout(timer);
        timer = window.setTimeout(rebuild, 150);
      }, { defer: true }),
    );
  });
  onCleanup(() => {
    clearTimeout(timer);
    disposePlayer();
  });

  // ---------- settings save / load ----------
  const namesOf = (list: Named[], ids: Set<string>) => list.filter((x) => ids.has(x.id)).map((x) => x.name);
  const currentSettings = (): SavedSettings => ({
    format: format(),
    data: { pretty: pretty(), nonessential: nonessential(), cleanUp: cleanUp(), precision: precision(), prune: prune(), embed: embed(), pack: pack(), padding: padding(), maxSize: maxSize(), pot: pot(), rotate: rotate(), atlasScale: atlasScale() },
    media: {
      animation: mediaAnim()?.name ?? null,
      skin: source.skeleton.skins.find((k) => k.id === mSkin())?.name ?? null,
      fps: fps(),
      scale: scale(),
      area: area(),
      padding: mPadding(),
      transparent: transparent(),
      background: bgColor(),
      sequence: sequence(),
      quality: quality(),
      loops: loops(),
      audio: withSound(),
    },
    picks: { animations: namesOf(source.animations, anims()), stateMachines: namesOf(source.stateMachines, sms()), scripts: namesOf(source.scripts, scripts()), skins: namesOf(extraSkins, skins()) },
    openAfter: openAfter(),
    engine: {
      clips: namesOf(source.animations, eAnims()),
      loop: eLoop(),
      trim: eTrim(),
      padding: ePadding(),
      maxSize: eMaxSize(),
      pot: ePot(),
      godotRoot: godotRoot(),
      flutterMode: flutterMode(),
      stateMachine: wvSm(),
      pack: wvPack(),
      binary: wvBinary(),
      transparent: wvTransparent(),
      androidPackage: androidPackage(),
      webp: wvWebp(),
    },
    web: { format: webFmt(), minify: webMin(), scripts: webScripts(), singleFile: webSingle(), demo: webDemo() },
  });
  const remember = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
    } catch {
      /* storage unavailable */
    }
  };
  const applySettings = (s: SavedSettings) => {
    if (s.format && GROUPS.some((g) => g.items.some((i) => i.id === s.format))) setFormat(s.format);
    const d = s.data ?? {};
    if (d.pretty !== undefined) setPretty(d.pretty);
    if (d.nonessential !== undefined) setNonessential(d.nonessential);
    if (d.cleanUp !== undefined) setCleanUp(d.cleanUp);
    if (d.precision) setPrecision(d.precision);
    if (d.prune !== undefined) setPrune(d.prune);
    if (d.embed !== undefined) setEmbed(d.embed);
    if (d.pack !== undefined) setPack(d.pack);
    if (d.padding !== undefined) setPadding(d.padding);
    if (d.maxSize !== undefined) setMaxSize(d.maxSize);
    if (d.pot !== undefined) setPot(d.pot);
    if (d.rotate !== undefined) setRotate(d.rotate);
    if (d.atlasScale !== undefined) setAtlasScale(d.atlasScale);
    const m = s.media ?? {};
    if (m.animation !== undefined) setMAnim(findId(source.animations, m.animation) ?? mAnim());
    if (m.skin !== undefined) setMSkin(findId(source.skeleton.skins, m.skin));
    if (m.fps) setFps(m.fps);
    if (m.scale) setScale(m.scale);
    if (m.area) setArea(m.area);
    if (m.padding !== undefined) setMPadding(m.padding);
    if (m.transparent !== undefined) setTransparent(m.transparent);
    if (m.background) setBgColor(m.background);
    if (m.sequence !== undefined) setSequence(m.sequence);
    if (m.quality !== undefined) setQuality(m.quality);
    if (m.loops !== undefined) setLoops(m.loops);
    if (m.audio !== undefined) setWithSound(m.audio);
    if (s.picks) {
      setAnims(byNames(source.animations, s.picks.animations));
      setSms(byNames(source.stateMachines, s.picks.stateMachines));
      setScripts(byNames(source.scripts, s.picks.scripts));
      setSkins(byNames(extraSkins, s.picks.skins));
    }
    if (s.openAfter !== undefined) setOpenAfter(s.openAfter);
    const e = s.engine;
    if (e) {
      if (e.clips) setEAnims(byNames(source.animations, e.clips));
      if (e.loop !== undefined) setELoop(e.loop);
      if (e.trim !== undefined) setETrim(e.trim);
      if (e.padding !== undefined) setEPadding(e.padding);
      if (e.maxSize) setEMaxSize(e.maxSize);
      if (e.pot !== undefined) setEPot(e.pot);
      if (e.godotRoot !== undefined) setGodotRoot(e.godotRoot);
      if (e.flutterMode) setFlutterMode(e.flutterMode);
      if (e.stateMachine !== undefined && (e.stateMachine === null || source.stateMachines.some((m) => m.name === e.stateMachine))) setWvSm(e.stateMachine);
      if (e.pack !== undefined) setWvPack(e.pack);
      if (e.binary !== undefined) setWvBinary(e.binary);
      if (e.transparent !== undefined) setWvTransparent(e.transparent);
      if (e.webp !== undefined) setWvWebp(e.webp);
      if (e.androidPackage) setAndroidPackage(e.androidPackage);
    }
    const w = s.web;
    if (w) {
      if (w.format) setWebFmt(w.format);
      if (w.minify !== undefined) setWebMin(w.minify);
      if (w.scripts !== undefined) setWebScripts(w.scripts);
      if (w.singleFile !== undefined) setWebSingle(w.singleFile);
      if (w.demo !== undefined) setWebDemo(w.demo);
    }
  };
  let settingsInput!: HTMLInputElement;
  const saveSettings = async () => {
    const savedName = await saveTextFile(`${name().trim() || "export"}.export.json`, JSON.stringify(currentSettings(), null, 2), "json", "Export settings");
    if (savedName) toast(`Saved export settings to ${savedName}`);
  };
  const loadSettings = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      applySettings(JSON.parse(await f.text()) as SavedSettings);
      toast(`Loaded export settings from ${f.name}`);
    } catch {
      toast(`${f.name} is not an export settings file`, "error");
    }
    settingsInput.value = "";
  };

  // ---------- export ----------
  const openResult = (data: Uint8Array, mime: string) => {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const canOpenAfter = () =>
    !isDesktop() &&
    (((format() === "png" || format() === "jpeg" || format() === "gif" || format() === "apng") && !(sequence() && frameCount() > 1)) || (format() === "web" && webSingle()));

  const doExport = async () => {
    if (issues().length) return toast("Fix the problems listed before exporting", "error");
    setBusy(true);
    setProgress("");
    remember();
    const base = name().trim() || "export";
    try {
      if (isData(format())) {
        const d = usePack() ? (packed() ?? (await packForExport(result().doc, packSettings()))).doc : structuredClone(result().doc);
        if (embed() && !usePack()) for (const img of d.images) img.src = await imageAsDataUrl(img);
        // Audio assets are shared (immutable) objects: replace them rather than editing in place.
        if ((embed() || usePack()) && d.audio) d.audio.assets = await Promise.all(d.audio.assets.map(async (a) => ({ ...a, src: await audioAsDataUrl(a) })));
        const data = format() === "binary" ? serializeBinary(d, { precision: precision() }) : pretty() ? serialize(d) : JSON.stringify(d);
        const savedName =
          typeof data !== "string"
            ? await saveFile(`${base}.obonb`, data, { ext: "obonb", description: "OpenBone binary", mime: "application/octet-stream" })
            : format() === "json"
              ? await saveTextFile(`${base}.json`, data, "json", "OpenBone JSON data")
              : await saveTextFile(`${base}.obone`, data);
        if (savedName) {
          savedToast(`Exported ${savedName} (${fmtBytes(data.length)})`, savedName);
          setExportOpen(false);
        }
        return;
      }
      const onProgress = (stage: string, p: number) => setProgress(`${stage}… ${Math.round(p * 100)}%`);
      const e = engine();
      if (e === "web") {
        const title = fileName().replace(/\.obone$/i, "") || base;
        const f = await exportWebPack(
          source,
          { format: webFmt(), minify: webMin(), scripts: webScripts(), singleFile: webSingle(), demoControls: webDemo(), stateMachine: wvSm(), pack: wvPack(), binary: wvBinary(), webpQuality: wvWebp(), background: wvTransparent() ? null : bgColor() },
          base,
          title,
          onProgress,
        );
        setProgress("Saving…");
        const savedName = await saveFile(f.name, f.data, { ext: f.ext, description: f.description, mime: f.mime });
        if (savedName) {
          savedToast(`Exported ${savedName} (${fmtBytes(f.data.length)})`, savedName);
          if (openAfter() && canOpenAfter()) openResult(f.data, f.mime);
          setExportOpen(false);
        }
        return;
      }
      if (e) {
        const data = sheetMode()
          ? (await exportSpritePack(e === "unity" || e === "godot" || e === "flutter" ? e : "generic", source, sheetOptions(), base, onProgress)).data
          : await exportWebViewPack(e as "flutter" | "android" | "ios", source, { stateMachine: wvSm(), pack: wvPack(), binary: wvBinary(), webpQuality: wvWebp(), background: wvTransparent() ? null : bgColor(), androidPackage: androidPackage().trim() || "com.openbone" }, base, fileName().replace(/\.obone$/i, "") || base, onProgress);
        setProgress("Saving…");
        const label = `${formatLabel()} ${sheetMode() ? "sprite sheet" : "WebView"} package (ZIP)`;
        const savedName = await saveFile(`${base}.zip`, data, { ext: "zip", description: label, mime: "application/zip" });
        if (savedName) {
          savedToast(`Exported ${savedName} (${fmtBytes(data.length)})`, savedName);
          setExportOpen(false);
        }
        return;
      }
      const f = await exportMedia(source, mediaOptions(), format() as MediaFormat, base, onProgress);
      setProgress("Saving…");
      const savedName = await saveFile(f.name, f.data, { ext: f.ext, description: f.description, mime: f.mime });
      if (savedName) {
        savedToast(`Exported ${savedName} (${fmtBytes(f.data.length)})`, savedName);
        for (const w of f.warnings ?? []) toast(w, "info");
        if (openAfter() && canOpenAfter()) openResult(f.data, f.mime);
        setExportOpen(false);
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const close = () => !busy() && setExportOpen(false);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", key, true));
  onCleanup(() => window.removeEventListener("keydown", key, true));

  const s = () => result().stats;
  /** Extension the export will be saved with (sequences of PNG/JPEG frames become a ZIP). */
  const outExt = () => {
    const f = format();
    if (isData(f)) return DATA_EXT[f];
    if (f === "web") return webSingle() ? "html" : "zip";
    if (isEngine(f)) return "zip";
    const m = MEDIA[f];
    return !m.animated && f !== "psd" && sequence() && frameCount() > 1 ? "zip" : m.ext;
  };
  const formatLabel = () => GROUPS.flatMap((g) => g.items).find((i) => i.id === format())!.label;
  const outSize = () => {
    const sc = scale();
    return area() === "artboard" ? `${Math.round(source.width * sc)}×${Math.round(source.height * sc)}` : "fit to content";
  };

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header class="modal-head">
          <h2 id="export-title">Export</h2>
          <span class="muted">Your open project is not changed.</span>
          <span class="spacer" />
          <button class="icon-btn" title="Close (Esc)" onClick={close}>
            ✕
          </button>
        </header>
        <div class="export-body">
          <nav class="export-formats" aria-label="Export format">
            <For each={GROUPS}>
              {(g) => (
                <div class="format-group">
                  <div class="format-title">{g.title}</div>
                  <For each={g.items}>
                    {(it) => (
                      <button class="format-item" classList={{ active: format() === it.id }} aria-pressed={format() === it.id} title={it.hint} onClick={() => setFormat(it.id)}>
                        {it.label}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </nav>
          <div class="export-options">
            <h3 class="export-heading">Export {formatLabel()}</h3>
            <Show when={isProject(format())}>
              <div class="hint">
                The whole project: rig, skins, animations, state machines, scripts and editor data. Open it later with <b>Open</b> to keep working.
              </div>
              <fieldset class="export-group">
                <legend>Output</legend>
                <label class="check">
                  <input type="checkbox" checked={embed()} onChange={(e) => setEmbed(e.currentTarget.checked)} /> Embed images and audio in the file
                  <span class="muted small">{needsEmbed ? "(one self-contained file)" : "(already embedded)"}</span>
                </label>
                <label class="check">
                  <input type="checkbox" checked={pretty()} onChange={(e) => setPretty(e.currentTarget.checked)} /> Pretty print
                  <span class="muted small">(readable, diff-friendly)</span>
                </label>
              </fieldset>
            </Show>
            <Show when={isData(format()) && !isProject(format())}>
              <div class="quick-pick">
                <span class="muted small">Quick pick</span>
                <div class="seg-choice">
                  <button onClick={presets.everything} title="Everything in the project">
                    Everything
                  </button>
                  <button onClick={presets.animations} title="Rig and animations, no state machines or scripts">
                    Animations only
                  </button>
                  <button onClick={presets.rig} title="Rig and setup pose only">
                    Rig only
                  </button>
                </div>
              </div>
              <div class="hint">The rig (bones, slots, attachments, constraints) is always included.</div>
              <Picker title="Animations" items={source.animations} selected={anims()} onChange={setAnims} />
              <Picker title="State machines" items={source.stateMachines} selected={sms()} onChange={setSms} />
              <Show when={source.scripts.length}>
                <Picker title="Scripts" items={source.scripts} selected={scripts()} onChange={setScripts} />
              </Show>
              <Show when={extraSkins.length}>
                <Picker title="Extra skins" items={extraSkins} selected={skins()} onChange={setSkins} hint="The default skin is always included." />
              </Show>
              <fieldset class="export-group">
                <legend>Output</legend>
                <Show when={format() === "json"}>
                  <label class="check">
                    <input type="checkbox" checked={pretty()} onChange={(e) => setPretty(e.currentTarget.checked)} /> Pretty print
                    <span class="muted small">(readable; off = smaller)</span>
                  </label>
                </Show>
                <Show when={format() === "binary"}>
                  <Row label="Numbers" title="float32 matches Spine binary and is smaller; float64 is lossless">
                    <select value={precision()} onChange={(e) => setPrecision(e.currentTarget.value as "float32" | "float64")}>
                      <option value="float32" selected={precision() === "float32"}>float32 (smaller)</option>
                      <option value="float64" selected={precision() === "float64"}>float64 (lossless)</option>
                    </select>
                  </Row>
                </Show>
                <label class="check" title="Bone colours and state machine node positions, used only by the editor">
                  <input type="checkbox" checked={nonessential()} onChange={(e) => setNonessential(e.currentTarget.checked)} /> Nonessential data
                </label>
                <label class="check" title="Remove keys that change nothing and timelines that only repeat the setup pose">
                  <input type="checkbox" checked={cleanUp()} onChange={(e) => setCleanUp(e.currentTarget.checked)} /> Animation clean up
                  <Show when={cleanUp() && s().removedKeys}>
                    <span class="muted small">({plural(s().removedKeys, "key")} removed)</span>
                  </Show>
                </label>
                <label class="check">
                  <input type="checkbox" checked={prune()} onChange={(e) => setPrune(e.currentTarget.checked)} /> Leave out unused images and events
                </label>
                <label class="check" title={pack() ? "Atlas pages are always embedded" : undefined}>
                  <input type="checkbox" checked={embed() || pack()} disabled={pack()} onChange={(e) => setEmbed(e.currentTarget.checked)} /> Embed images and audio in the file
                  <span class="muted small">{needsEmbed ? "(one self-contained file)" : "(already embedded)"}</span>
                </label>
              </fieldset>
              <fieldset class="export-group">
                <legend>Texture atlas</legend>
                <label class="check" title="Draw every image from a few shared textures: faster WebGL playback (fewer draw calls)">
                  <input type="checkbox" checked={pack()} disabled={!result().doc.images.length} onChange={(e) => setPack(e.currentTarget.checked)} /> Pack
                  <span class="muted small">{result().doc.images.length ? "(fewer draw calls)" : "(no images to pack)"}</span>
                </label>
                <Show when={pack()}>
                  <div class="export-atlas">
                    <Row label="Padding">
                      <input type="number" min="0" max="16" value={padding()} onChange={(e) => setPadding(clamp(Math.round(+e.currentTarget.value), 0, 16, 2))} />
                      <span class="muted">px</span>
                    </Row>
                    <Row label="Max page">
                      <select value={String(maxSize())} onChange={(e) => setMaxSize(+e.currentTarget.value)}>
                        <For each={[512, 1024, 2048, 4096]}>{(n) => <option value={n} selected={n === maxSize()}>{n}×{n}</option>}</For>
                      </select>
                    </Row>
                    <label class="check">
                      <input type="checkbox" checked={pot()} onChange={(e) => setPot(e.currentTarget.checked)} /> Power-of-two page sizes
                    </label>
                    <label class="check" title="Turn images 90° when that packs them tighter (images used by particles stay upright)">
                      <input type="checkbox" checked={rotate()} onChange={(e) => setRotate(e.currentTarget.checked)} /> Rotate to fit tighter
                    </label>
                    <Row label="Scale">
                      <select
                        title="Store images smaller to save memory and download size. Auto shrinks only as much as needed to fit everything on one page."
                        value={String(atlasScale())}
                        onChange={(e) => setAtlasScale(e.currentTarget.value === "auto" ? "auto" : +e.currentTarget.value)}
                      >
                        <For each={[1, 0.75, 0.5, 0.25]}>{(n) => <option value={n} selected={atlasScale() === n}>{Math.round(n * 100)}%</option>}</For>
                        <option value="auto" selected={atlasScale() === "auto"}>Auto (fit one page)</option>
                      </select>
                    </Row>
                    <div class="muted small">
                      <Show when={packError()} fallback={packed() ? `${plural(result().doc.images.length, "image")} → ${plural(packed()!.pages.length, "page")}: ${packed()!.pages.map((p) => `${p.width}×${p.height}`).join(", ")}${packed()!.scale !== 1 ? ` at ${Math.round(packed()!.scale * 100)}%` : ""}` : "Packing…"}>
                        <span class="error">⛔ {packError()}</span>
                      </Show>
                    </div>
                    <Show when={packed()?.pages.length}>
                      <div class="atlas-pages">
                        <For each={packed()!.pages}>{(p) => <img src={p.src} alt={`Atlas page ${p.width}×${p.height}`} title={`${p.width}×${p.height}`} />}</For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </fieldset>
            </Show>

            <Show when={media()}>
              {(info) => (
                <>
                  <fieldset class="export-group">
                    <legend>Animation</legend>
                    <Row label="Animation">
                      <select value={mAnim() ?? ""} onChange={(e) => setMAnim(e.currentTarget.value || null)}>
                        <Show when={!info().animated}>
                          <option value="" selected={!mAnim()}>Setup pose</option>
                        </Show>
                        <For each={source.animations}>{(a) => <option value={a.id} selected={a.id === mAnim()}>{a.name}</option>}</For>
                      </select>
                    </Row>
                    <Show when={source.skeleton.skins.length > 1}>
                      <Row label="Skin">
                        <select value={mSkin() ?? ""} onChange={(e) => setMSkin(e.currentTarget.value || null)}>
                          <option value="" selected={!mSkin()}>Default</option>
                          <For each={extraSkins}>{(k) => <option value={k.id} selected={k.id === mSkin()}>{k.name}</option>}</For>
                        </select>
                      </Row>
                    </Show>
                    <Show when={!info().animated && mAnim()}>
                      <div class="seg-choice" role="radiogroup" aria-label="Frames">
                        <button role="radio" aria-checked={!sequence()} classList={{ active: !sequence() }} onClick={() => setSequence(false)}>
                          {format() === "psd" ? "One layer" : "One frame"}
                        </button>
                        <button role="radio" aria-checked={sequence()} classList={{ active: sequence() }} onClick={() => setSequence(true)}>
                          {format() === "psd" ? "Every frame as a layer" : "Every frame (ZIP)"}
                        </button>
                      </div>
                      <Show when={!sequence()}>
                        <Row label="At time">
                          <input type="number" min="0" step="0.05" max={mediaAnim() ? animationDuration(mediaAnim()!) : 0} value={mTime()} onChange={(e) => setMTime(clamp(+e.currentTarget.value, 0, 3600, 0))} />
                          <span class="muted">s</span>
                        </Row>
                      </Show>
                    </Show>
                    <Show when={info().animated || sequence()}>
                      <Row label="Frame rate">
                        <input type="number" min="1" max="120" value={fps()} onChange={(e) => setFps(clamp(Math.round(+e.currentTarget.value), 1, 120, 30))} />
                        <span class="muted">fps</span>
                      </Row>
                    </Show>
                    <Show when={format() === "gif" || format() === "apng"}>
                      <Row label="Repeat">
                        <select value={String(loops())} onChange={(e) => setLoops(+e.currentTarget.value)}>
                          <option value="0" selected={loops() === 0}>Loop forever</option>
                          <option value="1" selected={loops() === 1}>Play once</option>
                        </select>
                      </Row>
                    </Show>
                  </fieldset>
                  <fieldset class="export-group">
                    <legend>Image</legend>
                    <Row label="Scale">
                      <input type="number" min="5" max="800" step="5" value={Math.round(scale() * 100)} onChange={(e) => setScale(clamp(+e.currentTarget.value, 5, 800, 100) / 100)} />
                      <span class="muted">%</span>
                    </Row>
                    <div class="seg-choice" role="radiogroup" aria-label="Area">
                      <button role="radio" aria-checked={area() === "artboard"} classList={{ active: area() === "artboard" }} onClick={() => setArea("artboard")}>
                        Artboard
                      </button>
                      <button role="radio" aria-checked={area() === "content"} classList={{ active: area() === "content" }} onClick={() => setArea("content")}>
                        Fit to content
                      </button>
                    </div>
                    <Show when={area() === "content"}>
                      <Row label="Padding">
                        <input type="number" min="0" max="500" value={mPadding()} onChange={(e) => setMPadding(clamp(Math.round(+e.currentTarget.value), 0, 500, 10))} />
                        <span class="muted">px</span>
                      </Row>
                    </Show>
                    <Show when={info().alpha}>
                      <label class="check">
                        <input type="checkbox" checked={transparent()} onChange={(e) => setTransparent(e.currentTarget.checked)} /> Transparent background
                        <Show when={format() === "gif"}>
                          <span class="muted small">(GIF: on/off transparency)</span>
                        </Show>
                      </label>
                    </Show>
                    <Show when={!info().alpha || !transparent()}>
                      <Row label="Background">
                        <input type="color" value={bgColor().slice(0, 7)} onChange={(e) => setBgColor(e.currentTarget.value)} />
                        <span class="muted">{bgColor().slice(0, 7)}</span>
                      </Row>
                    </Show>
                    <Show when={format() === "jpeg" || info().video}>
                      <Row label="Quality">
                        <input type="range" min="0.3" max="1" step="0.05" value={quality()} onInput={(e) => setQuality(+e.currentTarget.value)} />
                        <span class="muted">{Math.round(quality() * 100)}%</span>
                      </Row>
                    </Show>
                    <Show when={info().video}>
                      <label class="check" title="The animation's audio keys and event sounds, mixed with the project's bus and master volumes">
                        <input type="checkbox" checked={withSound()} onChange={(e) => setWithSound(e.currentTarget.checked)} /> Include sound
                        <Show when={withSound() && !soundCount()}>
                          <span class="muted small">(this animation plays no sound)</span>
                        </Show>
                      </label>
                      <div class="muted small">
                        {format() === "mp4"
                          ? "H.264 video with AAC sound (Opus where the browser has no AAC encoder): plays in browsers, phones, QuickTime, VLC and video editors."
                          : "Motion-JPEG video with uncompressed sound: plays in VLC, QuickTime and Windows players, and imports into video editors."}
                      </div>
                    </Show>
                  </fieldset>
                </>
              )}
            </Show>

            <Show when={engine()}>
              {(e) => (
                <>
                  <Show when={e() === "flutter"}>
                    <div class="seg-choice" role="radiogroup" aria-label="Flutter package">
                      <button role="radio" aria-checked={flutterMode() === "webview"} classList={{ active: flutterMode() === "webview" }} onClick={() => setFlutterMode("webview")}>
                        Interactive (WebView)
                      </button>
                      <button role="radio" aria-checked={flutterMode() === "sheet"} classList={{ active: flutterMode() === "sheet" }} onClick={() => setFlutterMode("sheet")}>
                        Sprite sheet
                      </button>
                    </div>
                  </Show>
                  <div class="hint">
                    <b>What you get:</b> {engineNote()}
                    <Show when={sheetMode()}> Animations play as pre-rendered frames: no state machines, inputs or scripts.</Show>
                  </div>
                  <Show when={sheetMode()}>
                    <Picker title="Animations" items={source.animations} selected={eAnims()} onChange={setEAnims} hint="Each animation becomes one clip." />
                    <fieldset class="export-group">
                      <legend>Playback</legend>
                      <Show when={source.skeleton.skins.length > 1}>
                        <Row label="Skin">
                          <select value={mSkin() ?? ""} onChange={(ev) => setMSkin(ev.currentTarget.value || null)}>
                            <option value="" selected={!mSkin()}>Default</option>
                            <For each={extraSkins}>{(k) => <option value={k.id} selected={k.id === mSkin()}>{k.name}</option>}</For>
                          </select>
                        </Row>
                      </Show>
                      <Row label="Frame rate">
                        <input type="number" min="1" max="120" value={fps()} onChange={(ev) => setFps(clamp(Math.round(+ev.currentTarget.value), 1, 120, 30))} />
                        <span class="muted">fps</span>
                      </Row>
                      <label class="check">
                        <input type="checkbox" checked={eLoop()} onChange={(ev) => setELoop(ev.currentTarget.checked)} /> Loop clips
                      </label>
                    </fieldset>
                    <fieldset class="export-group">
                      <legend>Frames</legend>
                      <Row label="Scale">
                        <input type="number" min="5" max="800" step="5" value={Math.round(scale() * 100)} onChange={(ev) => setScale(clamp(+ev.currentTarget.value, 5, 800, 100) / 100)} />
                        <span class="muted">%</span>
                      </Row>
                      <div class="seg-choice" role="radiogroup" aria-label="Frame area">
                        <button role="radio" aria-checked={area() === "artboard"} classList={{ active: area() === "artboard" }} onClick={() => setArea("artboard")}>
                          Artboard
                        </button>
                        <button role="radio" aria-checked={area() === "content"} classList={{ active: area() === "content" }} onClick={() => setArea("content")}>
                          Fit to content
                        </button>
                      </div>
                      <Show when={area() === "content"}>
                        <Row label="Padding">
                          <input type="number" min="0" max="500" value={mPadding()} onChange={(ev) => setMPadding(clamp(Math.round(+ev.currentTarget.value), 0, 500, 10))} />
                          <span class="muted">px</span>
                        </Row>
                      </Show>
                      <label class="check" title="Cut transparent borders off each frame; offsets are kept so frames do not jitter">
                        <input type="checkbox" checked={eTrim()} onChange={(ev) => setETrim(ev.currentTarget.checked)} /> Trim transparent borders
                      </label>
                    </fieldset>
                    <fieldset class="export-group">
                      <legend>Sprite sheet</legend>
                      <div class="export-atlas">
                        <Row label="Padding">
                          <input type="number" min="0" max="16" value={ePadding()} onChange={(ev) => setEPadding(clamp(Math.round(+ev.currentTarget.value), 0, 16, 2))} />
                          <span class="muted">px</span>
                        </Row>
                        <Row label="Max sheet">
                          <select value={String(eMaxSize())} onChange={(ev) => setEMaxSize(+ev.currentTarget.value)}>
                            <For each={[512, 1024, 2048, 4096, 8192]}>{(n) => <option value={n} selected={n === eMaxSize()}>{n}×{n}</option>}</For>
                          </select>
                        </Row>
                        <label class="check">
                          <input type="checkbox" checked={ePot()} onChange={(ev) => setEPot(ev.currentTarget.checked)} /> Power-of-two sheet sizes
                        </label>
                        <div class="muted small">Frames that do not fit go on more sheets. Identical frames are stored once.</div>
                      </div>
                      <Show when={e() === "godot"}>
                        <Row label="Godot path" title="Folder the pack is copied to inside the Godot project; the .tres refers to the sheets there">
                          <input type="text" spellcheck={false} placeholder={`res://openbone/${name().trim() || "export"}/`} value={godotRoot()} onInput={(ev) => setGodotRoot(ev.currentTarget.value)} />
                        </Row>
                      </Show>
                    </fieldset>
                  </Show>
                  <Show when={webMode()}>
                    <fieldset class="export-group">
                      <legend>Interactivity</legend>
                      <Show when={source.stateMachines.length} fallback={<div class="muted">No state machine: the first animation loops. Animations and events still work through the bridge.</div>}>
                        <Row label="Start with">
                          <select value={wvSm() ?? ""} onChange={(ev) => setWvSm(ev.currentTarget.value || null)}>
                            <For each={source.stateMachines}>{(m) => <option value={m.name} selected={m.name === wvSm()}>State machine · {m.name}</option>}</For>
                          </select>
                        </Row>
                        <div class="muted small">
                          {(() => {
                            const sm = source.stateMachines.find((m) => m.name === wvSm());
                            return sm?.inputs.length ? `Inputs: ${sm.inputs.map((i) => `${i.name} (${i.type})`).join(", ")}` : "This state machine has no inputs.";
                          })()}
                        </div>
                      </Show>
                      <div class="muted small">Everything is included: all animations, state machines, scripts and skins.</div>
                    </fieldset>
                    <fieldset class="export-group">
                      <legend>Output</legend>
                      <Row label="Data">
                        <select value={wvBinary() ? "obonb" : "obone"} onChange={(ev) => setWvBinary(ev.currentTarget.value === "obonb")}>
                          <option value="obonb" selected={wvBinary()}>Binary .obonb (smaller)</option>
                          <option value="obone" selected={!wvBinary()}>JSON .obone</option>
                        </select>
                      </Row>
                      <label class="check" title="Draw every image from a few shared textures: faster WebGL playback">
                        <input type="checkbox" checked={wvPack()} onChange={(ev) => setWvPack(ev.currentTarget.checked)} /> Pack images into a texture atlas
                      </label>
                      <Row label="Images">
                        <select
                          title="Re-encode embedded images as WebP (alpha kept); each image keeps whichever encoding is smaller"
                          value={wvWebp() === null ? "" : String(wvWebp())}
                          onChange={(ev) => setWvWebp(ev.currentTarget.value ? Number(ev.currentTarget.value) : null)}
                        >
                          <option value="0.92" selected={wvWebp() === 0.92}>WebP, high quality</option>
                          <option value="0.85" selected={wvWebp() === 0.85}>WebP, balanced (recommended)</option>
                          <option value="0.7" selected={wvWebp() === 0.7}>WebP, smallest</option>
                          <option value="" selected={wvWebp() === null}>Original (lossless PNG)</option>
                        </select>
                      </Row>
                      <label class="check">
                        <input type="checkbox" checked={wvTransparent()} onChange={(ev) => setWvTransparent(ev.currentTarget.checked)} /> Transparent background
                        <span class="muted small">{e() === "web" ? "(the page shows through)" : "(the app's view shows through)"}</span>
                      </label>
                      <Show when={!wvTransparent()}>
                        <Row label="Background">
                          <input type="color" value={bgColor().slice(0, 7)} onChange={(ev) => setBgColor(ev.currentTarget.value)} />
                          <span class="muted">{bgColor().slice(0, 7)}</span>
                        </Row>
                      </Show>
                      <Show when={e() === "android"}>
                        <Row label="Package" title="Kotlin package of OpenBoneView">
                          <input type="text" spellcheck={false} value={androidPackage()} onInput={(ev) => setAndroidPackage(ev.currentTarget.value)} />
                        </Row>
                      </Show>
                      <Show when={e() !== "web"}>
                        <div class="muted small">Includes the OpenBone web player (≈ 0.8 MB, works offline) and a README with integration steps.</div>
                      </Show>
                    </fieldset>
                    <Show when={e() === "web"}>
                      <fieldset class="export-group">
                        <legend>Player</legend>
                        <div class="seg-choice" role="radiogroup" aria-label="Player build">
                          <button role="radio" aria-checked={webMin()} classList={{ active: webMin() }} onClick={() => setWebMin(true)} title="Smallest download, for production">
                            Minified
                          </button>
                          <button role="radio" aria-checked={!webMin()} classList={{ active: !webMin() }} onClick={() => setWebMin(false)} title="Readable code, for debugging or reading">
                            Not minified
                          </button>
                        </div>
                        <div class="seg-choice" role="radiogroup" aria-label="Player format">
                          <button role="radio" aria-checked={webFmt() === "iife"} classList={{ active: webFmt() === "iife" }} onClick={() => setWebFmt("iife")} title="<script src>: defines <openbone-player> and window.OpenBone">
                            Classic script
                          </button>
                          <button role="radio" aria-checked={webFmt() === "esm"} classList={{ active: webFmt() === "esm" }} onClick={() => setWebFmt("esm")} title="<script type=module> or import { Player } from …">
                            ES module
                          </button>
                        </div>
                        <label class="check" title="QuickJS sandbox that runs the document's scripts">
                          <input type="checkbox" checked={webScripts()} onChange={(ev) => setWebScripts(ev.currentTarget.checked)} /> Include script sandbox
                          <span class="muted small">
                            {webSingle()
                              ? source.scripts.length
                                ? `(this file has ${plural(source.scripts.length, "script")}; +0.7 MB inlined)`
                                : "(no scripts in this file; +0.7 MB inlined)"
                              : `(${source.scripts.length ? plural(source.scripts.length, "script") : "no scripts"}; separate files, loaded only when needed)`}
                          </span>
                        </label>
                        <Show when={source.scripts.length && !webScripts()}>
                          <div class="muted small">⚠ Without the sandbox this file's scripts are skipped; everything else plays.</div>
                        </Show>
                        <div class="muted small">
                          Player ≈ {playerSizeKb(webMin(), webScripts(), webSingle())} KB · {webFmt() === "esm" ? "openbone-player" + (webMin() ? ".min" : "") + ".mjs" : "openbone-player" + (webMin() ? ".min" : "") + ".js"}
                        </div>
                      </fieldset>
                      <fieldset class="export-group">
                        <legend>Page</legend>
                        <label class="check" title="One .html file with the player and the animation inside: opens by double-click, no server needed">
                          <input type="checkbox" checked={webSingle()} onChange={(ev) => setWebSingle(ev.currentTarget.checked)} /> Single HTML file
                          <span class="muted small">(no server needed)</span>
                        </label>
                        <label class="check" title="Buttons and fields for the state machine's inputs, plus an event log">
                          <input type="checkbox" checked={webDemo()} onChange={(ev) => setWebDemo(ev.currentTarget.checked)} /> Demo controls for inputs
                        </label>
                        <div class="muted small">{webSingle() ? "Saves one .html page." : "Saves a ZIP: index.html, the player, the animation file and a README with embed snippets."}</div>
                      </fieldset>
                    </Show>
                  </Show>
                </>
              )}
            </Show>

            <fieldset class="export-group">
              <legend>File</legend>
              <label class="field">
                <span>Name</span>
                <span class="input-suffix">
                  <input type="text" value={name()} spellcheck={false} aria-label="File name" onInput={(e) => setName(e.currentTarget.value)} />
                  <span class="suffix" title="File extension for this export mode">.{outExt()}</span>
                </span>
              </label>
            </fieldset>
          </div>
          <div class="export-preview">
            <div class="field">
              <span>Preview</span>
              <Show
                when={isData(format())}
                fallback={<span class="muted">{engine() ? (currentTarget()?.name ?? "Setup pose") : (mediaAnim()?.name ?? "Setup pose")}</span>}
              >
                <select
                  value={currentTarget() ? `${currentTarget()!.kind}:${currentTarget()!.name}` : ""}
                  onChange={(e) => {
                    const [kind, ...rest] = e.currentTarget.value.split(":");
                    setTarget(kind ? { kind: kind as "sm" | "anim", name: rest.join(":") } : null);
                  }}
                >
                  <Show when={!targets().length}>
                    <option value="">Setup pose</option>
                  </Show>
                  <For each={targets()}>
                    {(t) => (
                      <option value={`${t.kind}:${t.name}`} selected={currentTarget()?.kind === t.kind && currentTarget()?.name === t.name}>
                        {t.label}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
              <span class="spacer" />
              <button title="Restart the preview" onClick={() => setStage((n) => n + 1)}>
                ↺
              </button>
            </div>
            <div class="export-stage" ref={host} />
            <div class="muted small">{status()}</div>
            <Show
              when={isData(format())}
              fallback={
                <Show
                  when={!engine()}
                  fallback={
                    <div class="export-summary">
                      <Show
                        when={sheetMode()}
                        fallback={
                          <>
                            <span>{plural(source.animations.length, "animation")}</span>
                            <span>{plural(source.stateMachines.length, "state machine")}</span>
                            <span>{plural(source.scripts.length, "script")}</span>
                            <span>{format() === "web" ? `${webSingle() ? "HTML" : "ZIP"} · player ≈ ${playerSizeKb(webMin(), webScripts(), webSingle())} KB` : "ZIP"}</span>
                          </>
                        }
                      >
                        <span>{plural(sheetAnims().length, "clip")}</span>
                        <span>{plural(sheetFrames(), "frame")}</span>
                        <span>{outSize()} per frame{eTrim() ? " (before trim)" : ""}</span>
                        <span>{fps()} fps</span>
                      </Show>
                    </div>
                  }
                >
                <div class="export-summary">
                  <span>{plural(frameCount(), "frame")}</span>
                  <span>{outSize()}</span>
                  <Show when={frameCount() > 1}>
                    <span>{fps()} fps · {(frameCount() / fps()).toFixed(2)} s</span>
                  </Show>
                </div>
                </Show>
              }
            >
              <div class="export-summary">
                <span>{plural(s().bones, "bone")}</span>
                <span>{plural(s().slots, "slot")}</span>
                <span>{plural(s().animations, "animation")}</span>
                <span>{plural(s().stateMachines, "state machine")}</span>
                <span>{plural(s().scripts, "script")}</span>
                <span>{plural(s().images, "image")}</span>
                <span>{plural(s().events, "event")}</span>
                <span>
                  ≈ {fmtBytes(dataSize())}
                  {!usePack() && embed() && needsEmbed && result().doc.images.length ? " + embedded images" : ""}
                </span>
              </div>
            </Show>
            <Show when={issues().length}>
              <div class="export-issues error">
                <For each={issues()}>{(i) => <div>⛔ {i.path}: {i.message}</div>}</For>
              </div>
            </Show>
            <Show when={isData(format()) && result().warnings.length}>
              <details class="export-issues" open={result().warnings.length <= 3}>
                <summary>
                  ⚠ {result().warnings.length} reference{result().warnings.length === 1 ? "" : "s"} to left-out items will be removed
                </summary>
                <For each={result().warnings}>{(w) => <div>{w}</div>}</For>
              </details>
            </Show>
          </div>
        </div>
        <footer class="modal-foot">
          <button onClick={saveSettings} title="Save these export settings to a file">
            Save settings
          </button>
          <button onClick={() => settingsInput.click()} title="Load export settings from a file">
            Load settings
          </button>
          <input ref={settingsInput} type="file" accept=".json,application/json" hidden onChange={(e) => loadSettings(e.currentTarget.files)} />
          <span class="spacer" />
          <span class="muted small" aria-live="polite">
            {progress()}
          </span>
          <Show when={canOpenAfter()}>
            <label class="check">
              <input type="checkbox" checked={openAfter()} onChange={(e) => setOpenAfter(e.currentTarget.checked)} /> Open after export
            </label>
          </Show>
          <button onClick={close} disabled={busy()}>
            Cancel
          </button>
          <button class="primary" onClick={doExport} disabled={busy() || issues().length > 0 || (isData(format()) && usePack() && !!packError()) || (sheetMode() && !sheetAnims().length)}>
            {busy() ? "Exporting…" : `Export ${formatLabel()}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
