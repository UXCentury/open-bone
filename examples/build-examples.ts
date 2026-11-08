/**
 * Builds the example projects in this folder using the same ops the editor and MCP server use.
 * Run: pnpm tsx examples/build-examples.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { DocumentStore, createDocument, lipSync, serialize, validate } from "@openbone/core";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- side-view characters (knight, walker): painted parts on a shared rig ----------
// Parts come from one ElevenLabs parts sheet per character (see assets/eleven/LICENSE.md), cut apart and stored with
// limbs upright (the joint nearest the body at the top). Joint positions are given as fractions of each image.

type Pt = readonly [number, number];
interface Part {
  image: string;
  w: number;
  h: number;
}
const part = (A: Op, name: string, w: number, h: number): Part => {
  A("addImage", { name, src: `assets/eleven/${name}.png`, width: w, height: h });
  return { image: name, w, h };
};

/**
 * Place a part so that its image point `anchor` (fractions, y down) sits at bone-local `at`, the image turned by
 * `r` degrees (90 on a bone pointing down keeps the image upright, -90 on a bone pointing up).
 */
function pin(A: Op, slot: string, bone: string, p: Part, anchor: Pt, at: Pt, r: number, k: number, o: { color?: string; scale?: number; name?: string } = {}) {
  const s = k * (o.scale ?? 1);
  const vx = (0.5 - anchor[0]) * p.w * s;
  const vy = (anchor[1] - 0.5) * p.h * s;
  const c = Math.cos((r * Math.PI) / 180);
  const sn = Math.sin((r * Math.PI) / 180);
  A("addSlot", { bone, name: slot, ...(o.color ? { color: o.color } : {}) });
  A("addRegion", {
    slot,
    ...(o.name ? { name: o.name } : {}),
    image: p.image,
    x: Math.round((at[0] + vx * c - vy * sn) * 100) / 100,
    y: Math.round((at[1] + vx * sn + vy * c) * 100) / 100,
    rotation: r,
    width: Math.round(p.w * s * 100) / 100,
    height: Math.round(p.h * s * 100) / 100,
  });
}
/** Distance between two image points of a part, in drawn pixels (for bone lengths). */
const span = (p: Part, a: Pt, b: Pt, k: number) => Math.hypot((b[0] - a[0]) * p.w, (b[1] - a[1]) * p.h) * k;

interface SideRigSpec {
  k: number;
  torso: { part: Part; hip: Pt; neck: Pt; shoulder: Pt };
  head: { part: Part; neck: Pt };
  upper: { part: Part; top: Pt; bottom: Pt };
  fore: { part: Part; top: Pt; wrist: Pt };
  hand?: { part: Part; top: Pt; grip: Pt };
  thigh: { part: Part; top: Pt; bottom: Pt };
  shin: { part: Part; top: Pt; bottom: Pt };
  foot: { part: Part; ankle: Pt };
  /** Cape or scarf: a mesh hanging from the neck on three bones (image stored with its attached edge on the left). */
  drape?: { part: Part; length: number; width: number; at: Pt; rotation: number };
  /** Feet apart at rest (each foot target ±stance/2 from the hip) and how bent the knees are at rest (0..1). */
  stance: number;
  bend: number;
  /** Scale of the leg parts relative to the body (parts sheets often draw legs too long for the torso). */
  legScale?: number;
  /** Scale of the arm parts relative to the body. */
  armScale?: number;
  /** Extra slots drawn on the back hand and front forearm (sword, shield). */
  backProp?: (hand: string) => void;
  frontProp?: (forearm: string) => void;
  backTint: string;
}

/**
 * Side view (facing right) character rig: hip → torso → head, two arms, two IK legs whose feet (on the foot targets)
 * stay flat on the ground, and an optional cape. Draw order: drape, back arm, back leg, torso, front leg, head,
 * front arm. Returns the measurements the animations need.
 */
function sideRig(A: Op, r: SideRigSpec) {
  const { k } = r;
  const T = r.torso;
  // Torso-local point of a torso image point (torso bone points up from the hip; local y = towards the back).
  const tl = (P: Pt): Pt => [(T.hip[1] - P[1]) * T.part.h * k, -(P[0] - T.hip[0]) * T.part.w * k];
  const neck = tl(T.neck);
  const shoulder = tl(T.shoulder);
  const ak = k * (r.armScale ?? 1);
  const upperLen = span(r.upper.part, r.upper.top, r.upper.bottom, ak);
  const foreLen = span(r.fore.part, r.fore.top, r.fore.wrist, ak);
  const lk = k * (r.legScale ?? 1);
  const thighLen = span(r.thigh.part, r.thigh.top, r.thigh.bottom, lk);
  const shinLen = span(r.shin.part, r.shin.top, r.shin.bottom, lk);
  const ankleH = (1 - r.foot.ankle[1]) * r.foot.part.h * lk * 0.92;
  // Knees slightly bent at rest: the hip sits a little lower than the straight leg.
  const legReach = (thighLen + shinLen) * (1 - r.bend * 0.08);
  const hipY = Math.round(ankleH + Math.sqrt(Math.max(0, legReach ** 2 - (r.stance / 2) ** 2)));

  A("addBone", { name: "hip", y: hipY, length: 20, color: "#ff9f43" });
  A("addBone", { name: "torso", parent: "hip", rotation: 90, length: Math.round(neck[0]) });
  A("addBone", { name: "head", parent: "torso", x: neck[0], y: neck[1], length: 50 });
  for (const side of ["back", "front"] as const) {
    A("addBone", { name: `${side}-arm`, parent: "torso", x: shoulder[0], y: shoulder[1], rotation: 180, length: Math.round(upperLen) });
    A("addBone", { name: `${side}-forearm`, parent: `${side}-arm`, x: upperLen, length: Math.round(foreLen) });
    A("addBone", { name: `${side}-hand`, parent: `${side}-forearm`, x: foreLen, length: 24 });
    A("addBone", { name: `${side}-thigh`, parent: "hip", rotation: -90, length: Math.round(thighLen) });
    A("addBone", { name: `${side}-shin`, parent: `${side}-thigh`, x: thighLen, length: Math.round(shinLen) });
    A("addBone", { name: `${side}-foot`, x: side === "front" ? r.stance / 2 : -r.stance / 2, y: ankleH, length: 0, color: "#ff5d5d" });
  }
  if (r.drape) {
    const d = r.drape;
    const seg = d.length / 3;
    A("addBone", { name: "drape1", parent: "torso", x: d.at[0], y: d.at[1], rotation: d.rotation, length: seg });
    A("addBone", { name: "drape2", parent: "drape1", x: seg, length: seg });
    A("addBone", { name: "drape3", parent: "drape2", x: seg, length: seg });
    A("addSlot", { bone: "drape1", name: "drape" });
    A("addMesh", { slot: "drape", name: "drape", image: d.part.image, x: d.length / 2, width: d.length, height: d.width, cols: 6, rows: 2 });
    A("autoWeights", { slot: "drape", attachment: "drape", bones: ["drape1", "drape2", "drape3"], maxInfluences: 2 });
  }
  const arm = (side: "back" | "front", color?: string) => {
    pin(A, `${side}-upper`, `${side}-arm`, r.upper.part, r.upper.top, [0, 0], 90, ak, { color });
    pin(A, `${side}-fore`, `${side}-forearm`, r.fore.part, r.fore.top, [0, 0], 90, ak, { color });
    if (r.hand) pin(A, `${side}-fist`, `${side}-hand`, r.hand.part, r.hand.top, [0, 0], 90, ak, { color });
  };
  // Thigh, then the boot, then the shin on top: the knee guard or trouser leg covers the thigh's end and the boot's
  // top, like real clothing.
  const leg = (side: "back" | "front", color?: string) => {
    pin(A, `${side}-thigh`, `${side}-thigh`, r.thigh.part, r.thigh.top, [0, 0], 90, lk, { color });
    pin(A, `${side}-boot`, `${side}-foot`, r.foot.part, r.foot.ankle, [0, 0], 0, lk, { color });
    pin(A, `${side}-shin`, `${side}-shin`, r.shin.part, r.shin.top, [0, 0], 90, lk, { color });
  };
  // Back limbs a shade darker: they are further from the light and the viewer.
  r.backProp?.("back-hand");
  arm("back", r.backTint);
  leg("back", r.backTint);
  pin(A, "torso", "torso", T.part, T.hip, [0, 0], -90, k);
  leg("front");
  pin(A, "head", "head", r.head.part, r.head.neck, [0, 0], -90, k);
  arm("front");
  r.frontProp?.("front-forearm");
  for (const side of ["back", "front"]) A("addIkConstraint", { name: `${side}-leg`, bones: [`${side}-thigh`, `${side}-shin`], target: `${side}-foot`, bendPositive: false });
  return { hipY, ankleH, upperLen, foreLen, thighLen, shinLen };
}

type Keys = [number, number][];
/**
 * Walk cycle on the foot targets (1 s): each foot is planted for half the cycle, sliding back from +reach to -reach
 * (so the ground must scroll at 4·reach px/s), then lifts, rolls the boot and swings forward. The two feet are half a
 * cycle apart. Returns the ground speed.
 */
function walkFeet(K: (target: string, id: string, property: string, keys: Keys, curve?: string) => void, ankleH: number, reach: number, lift: number) {
  for (const [side, phase] of [["front", 0], ["back", 0.5]] as const) {
    const at = (t: number) => Math.round(((t + phase) % 1) * 1000) / 1000;
    // Keys within one cycle (phase-shifted), sorted and closed so t = 0 and t = 1 match.
    const loop = (pts: Keys): Keys => {
      const s = pts.map(([t, v]) => [at(t), v] as [number, number]).sort((a, b) => a[0] - b[0]);
      if (s[0][0] > 0) {
        const last = s[s.length - 1];
        const first = s[0];
        const span = 1 - last[0] + first[0];
        s.unshift([0, last[1] + ((first[1] - last[1]) * (1 - last[0])) / span]);
      }
      s.push([1, s[0][1]]);
      return s.filter((k, i) => i === 0 || k[0] !== s[i - 1][0]);
    };
    K("bone", `${side}-foot`, "x", loop([[0, reach], [0.5, -reach], [0.62, -reach * 0.8], [0.8, reach * 0.35], [0.94, reach * 0.95]]), "linear");
    K("bone", `${side}-foot`, "y", loop([[0, ankleH], [0.5, ankleH], [0.6, ankleH + lift * 0.7], [0.74, ankleH + lift], [0.9, ankleH + lift * 0.25], [0.999, ankleH]]), "easeInOut");
    // Heel strike (toe up), flat, toe-off (heel up), then swing.
    K("bone", `${side}-foot`, "rotation", loop([[0, 8], [0.08, 0], [0.42, 0], [0.55, -18], [0.75, -6], [0.94, 10]]), "easeInOut");
  }
  return reach * 4;
}

// ---------- knight: side view with sword and shield ----------
function knight() {
  const s = new DocumentStore(createDocument("Knight", { background: "#9fd0f5" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 900, height: 600, originX: 400, originY: 530 });
  const P = (n: string, w: number, h: number) => part(A, `knight-${n}`, w, h);
  const torso = P("torso", 196, 281);
  const helmet = P("helmet", 260, 280);
  const upper = P("arm-upper", 117, 198);
  const fore = P("forearm", 79, 180);
  const fist = P("fist", 83, 116);
  const thigh = P("thigh", 106, 218);
  const shin = P("shin", 111, 282);
  const boot = P("boot", 143, 123);
  const sword = P("sword", 116, 370);
  const shield = P("shield", 263, 265);
  const cape = P("cape", 343, 175);
  A("addImage", { name: "knight-bg-far", src: "assets/eleven/knight-bg-far.jpg", width: 2000, height: 429 });
  const mid = { image: "knight-bg-mid", w: 2000, h: 260 };
  A("addImage", { name: mid.image, src: `assets/eleven/${mid.image}.png`, width: mid.w, height: mid.h });
  const ground = { image: "knight-bg-ground", w: 2000, h: 158 };
  A("addImage", { name: ground.image, src: `assets/eleven/${ground.image}.png`, width: ground.w, height: ground.h });

  // Parallax: far castle, hills and wall, then the road the knight walks on (scrolls at the feet's speed).
  // Each layer is its art plus a mirrored copy (seamless when it wraps), drawn 2300 wide.
  const reach = 46;
  const GW = 2300;
  const scroll = addScrollLayers(A, "knight", "walk", [
    { name: "bg-far", image: "knight-bg-far", x: 700, y: 290, w: GW, h: (GW * 429) / 2000, speed: 14 },
    { name: "bg-mid", image: mid.image, x: 700, y: 100, w: GW, h: (GW * mid.h) / mid.w, speed: 55 },
    { name: "bg-ground", image: ground.image, x: 700, y: -21, w: GW, h: (GW * ground.h) / ground.w, speed: reach * 4 },
  ]);

  const k = 0.5;
  const m = sideRig(A, {
    k,
    torso: { part: torso, hip: [0.52, 0.8], neck: [0.5, 0.06], shoulder: [0.42, 0.24] },
    head: { part: helmet, neck: [0.62, 0.93] },
    upper: { part: upper, top: [0.5, 0.14], bottom: [0.5, 0.9] },
    fore: { part: fore, top: [0.5, 0.08], wrist: [0.5, 0.9] },
    hand: { part: fist, top: [0.5, 0.14], grip: [0.5, 0.62] },
    thigh: { part: thigh, top: [0.5, 0.12], bottom: [0.5, 0.8] },
    shin: { part: shin, top: [0.44, 0.2], bottom: [0.45, 0.86] },
    foot: { part: boot, ankle: [0.3, 0.28] },
    drape: { part: cape, length: 150, width: 84, at: [100, 30], rotation: 166 },
    stance: 30,
    bend: 0.6,
    legScale: 0.82,
    armScale: 0.86,
    backTint: "#c2c6d0",
    // Sword in the back hand (pointing forward and down at rest); shield on the front forearm.
    backProp: (hand) => pin(A, "sword", hand, sword, [0.5, 0.84], [14, 0], -40, k, { scale: 0.9 }),
    frontProp: (forearm) => pin(A, "shield", forearm, shield, [0.5, 0.5], [40, -6], 90, k, { scale: 0.62 }),
  });
  A("addBoundingBox", { slot: "torso", name: "body-hit", x: 40, width: 150, height: 110 });
  A("addBoundingBox", { slot: "head", name: "head-hit", x: 40, width: 90, height: 90 });
  // Click the road to start or stop walking.
  A("addSlot", { bone: "root", name: "road-hit" });
  A("addBoundingBox", { slot: "road-hit", name: "road", y: -35, width: 900, height: 70 });

  const anim = (name: string, duration: number) => A("createAnimation", { name, duration });
  let cur = "";
  const K = (target: string, id: string, property: string, keys: Keys, curve = "easeInOut") =>
    A("setKeys", { animation: cur, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  const hip = m.hipY;

  // ---- idle: breathing, weight shifting, cape drifting ----
  anim((cur = "idle"), 2.4);
  K("bone", "hip", "y", [[0, hip], [1.2, hip - 3], [2.4, hip]]);
  K("bone", "torso", "rotation", [[0, 88], [1.2, 89.5], [2.4, 88]]);
  K("bone", "head", "rotation", [[0, 0], [1.2, -2], [2.4, 0]]);
  K("bone", "back-arm", "rotation", [[0, 186], [1.2, 189], [2.4, 186]]);
  K("bone", "back-forearm", "rotation", [[0, 20], [1.2, 24], [2.4, 20]]);
  K("bone", "front-arm", "rotation", [[0, 196], [1.2, 192], [2.4, 196]]);
  K("bone", "front-forearm", "rotation", [[0, 40], [1.2, 44], [2.4, 40]]);
  K("bone", "drape2", "rotation", [[0, 0], [1.2, 4], [2.4, 0]]);
  K("bone", "drape3", "rotation", [[0, 0], [1.2, 7], [2.4, 0]]);

  // ---- walk: planted feet slide at the road's speed; hips bob, arms counter-swing, cape streams back ----
  anim((cur = "walk"), 1);
  const groundSpeed = walkFeet(K, m.ankleH, reach, 24);
  void groundSpeed;
  K("bone", "hip", "y", [[0, hip - 5], [0.25, hip + 3], [0.5, hip - 5], [0.75, hip + 3], [1, hip - 5]]);
  K("bone", "torso", "rotation", [[0, 84], [0.25, 85.5], [0.5, 84], [0.75, 85.5], [1, 84]]);
  K("bone", "head", "rotation", [[0, 4], [0.25, 2], [0.5, 4], [0.75, 2], [1, 4]]);
  K("bone", "back-arm", "rotation", [[0, 200], [0.5, 168], [1, 200]]);
  K("bone", "back-forearm", "rotation", [[0, 16], [0.5, 30], [1, 16]]);
  K("bone", "front-arm", "rotation", [[0, 178], [0.5, 206], [1, 178]]);
  K("bone", "front-forearm", "rotation", [[0, 44], [0.5, 34], [1, 44]]);
  K("bone", "drape1", "rotation", [[0, 152], [0.5, 146], [1, 152]]);
  K("bone", "drape2", "rotation", [[0, 6], [0.25, -2], [0.5, 8], [0.75, -2], [1, 6]]);
  K("bone", "drape3", "rotation", [[0, 10], [0.25, -4], [0.5, 12], [0.75, -4], [1, 10]]);

  // ---- attack: wind up behind the head, strike forward and down, recover ----
  anim((cur = "attack"), 0.95);
  K("bone", "back-arm", "rotation", [[0, 186], [0.26, 40], [0.36, 40], [0.46, 262], [0.6, 250], [0.95, 186]], "easeInOut");
  K("bone", "back-forearm", "rotation", [[0, 20], [0.26, -50], [0.36, -55], [0.46, 0], [0.6, 6], [0.95, 20]]);
  K("bone", "back-hand", "rotation", [[0, 0], [0.26, -30], [0.46, 20], [0.95, 0]]);
  K("bone", "torso", "rotation", [[0, 88], [0.26, 98], [0.36, 99], [0.46, 76], [0.6, 78], [0.95, 88]]);
  K("bone", "hip", "x", [[0, 0], [0.26, -8], [0.46, 14], [0.7, 10], [0.95, 0]]);
  K("bone", "hip", "y", [[0, hip], [0.26, hip - 2], [0.46, hip - 10], [0.7, hip - 8], [0.95, hip]]);
  K("bone", "front-arm", "rotation", [[0, 196], [0.26, 230], [0.46, 160], [0.95, 196]]);
  K("bone", "head", "rotation", [[0, 0], [0.26, 6], [0.46, -6], [0.95, 0]]);
  K("bone", "drape2", "rotation", [[0, 0], [0.3, -10], [0.5, 14], [0.95, 0]]);
  K("bone", "drape3", "rotation", [[0, 0], [0.35, -14], [0.55, 18], [0.95, 0]]);

  // ---- salute: sword raised high, "Hail, traveller!" ----
  anim((cur = "salute"), 1.8);
  // Arm raised forward, forearm up, sword held upright in front of the helmet.
  K("bone", "back-arm", "rotation", [[0, 186], [0.35, 292], [1.35, 292], [1.8, 186]]);
  K("bone", "back-forearm", "rotation", [[0, 20], [0.35, 56], [1.35, 56], [1.8, 20]]);
  K("bone", "back-hand", "rotation", [[0, 0], [0.35, 4], [1.35, 4], [1.8, 0]]);
  K("bone", "torso", "rotation", [[0, 88], [0.35, 92], [1.35, 92], [1.8, 88]]);
  K("bone", "head", "rotation", [[0, 0], [0.35, 8], [0.7, 4], [1.35, 8], [1.8, 0]]);
  K("bone", "hip", "y", [[0, hip], [0.35, hip + 4], [1.35, hip + 4], [1.8, hip]]);
  K("bone", "drape3", "rotation", [[0, 0], [0.4, -8], [0.9, 6], [1.8, 0]]);

  // ---- state machine: walk toggles (click the road), click the knight to attack, click his helmet to salute ----
  A("createStateMachine", { name: "knight" });
  A("addInput", { stateMachine: "knight", name: "walk", type: "bool" });
  A("addInput", { stateMachine: "knight", name: "attack", type: "trigger" });
  A("addInput", { stateMachine: "knight", name: "salute", type: "trigger" });
  A("addState", { stateMachine: "knight", name: "idle", animation: "idle", x: 120, y: 140 });
  A("addState", { stateMachine: "knight", name: "walk", animation: "walk", x: 380, y: 40 });
  A("addState", { stateMachine: "knight", name: "attack", animation: "attack", loop: false, x: 380, y: 160 });
  A("addState", { stateMachine: "knight", name: "salute", animation: "salute", loop: false, x: 380, y: 280 });
  const T = (from: string, to: string, conditions: unknown[], o: Record<string, unknown> = {}) =>
    A("addTransition", { stateMachine: "knight", from, to, conditions, duration: 0.2, ...o });
  T("idle", "walk", [{ input: "walk", value: true }]);
  T("walk", "idle", [{ input: "walk", value: false }]);
  T("@any", "attack", [{ input: "attack" }], { duration: 0.08 });
  T("@any", "salute", [{ input: "salute" }], { duration: 0.15 });
  for (const st of ["attack", "salute"]) {
    T(st, "walk", [{ input: "walk", value: true }], { exitTime: 1 });
    T(st, "idle", [{ input: "walk", value: false }], { exitTime: 1 });
  }
  A("addListener", { stateMachine: "knight", slot: "torso", event: "click", actions: [{ type: "fireTrigger", input: "attack" }] });
  A("addListener", { stateMachine: "knight", slot: "head", event: "click", actions: [{ type: "fireTrigger", input: "salute" }] });
  A("addListener", { stateMachine: "knight", slot: "road-hit", event: "click", actions: [{ type: "toggleInput", input: "walk" }] });
  scroll();

  // Sounds: armoured steps as each foot lands, the sword's swing and clang, and the greeting.
  sfx(A, "step", "knight-step", { volume: 0.55 });
  sfx(A, "swoosh", "knight-swoosh", { volume: 0.8 });
  sfx(A, "clang", "knight-clang", { volume: 0.7 });
  sfx(A, "hail", "knight-hail");
  A("addAudioKey", { animation: "walk", sound: "step", time: 0.02 });
  A("addAudioKey", { animation: "walk", sound: "step", time: 0.52 });
  A("addAudioKey", { animation: "attack", sound: "swoosh", time: 0.34 });
  A("addAudioKey", { animation: "attack", sound: "clang", time: 0.47 });
  A("addAudioKey", { animation: "salute", sound: "hail", time: 0.3 });
  return s.doc;
}

// ---------- walker: side view adventurer, IK legs, scrolling parallax, a proper jump ----------
function walker() {
  const s = new DocumentStore(createDocument("Walker", { background: "#a8d8ff" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 900, height: 560, originX: 400, originY: 480 });
  const P = (n: string, w: number, h: number) => part(A, `walker-${n}`, w, h);
  const torso = P("torso", 194, 277);
  const head = P("head", 279, 257);
  const upper = P("arm-upper", 102, 227);
  const fore = P("forearm", 95, 290);
  const thigh = P("thigh", 121, 289);
  const shin = P("shin", 87, 254);
  const shoe = P("shoe", 186, 111);
  const scarf = P("scarf", 332, 109);
  A("addImage", { name: "walker-bg-far", src: "assets/eleven/walker-bg-far.jpg", width: 2000, height: 429 });
  const mid = { image: "walker-bg-mid", w: 2000, h: 329 };
  A("addImage", { name: mid.image, src: `assets/eleven/${mid.image}.png`, width: mid.w, height: mid.h });
  const ground = { image: "walker-bg-ground", w: 2000, h: 158 };
  A("addImage", { name: ground.image, src: `assets/eleven/${ground.image}.png`, width: ground.w, height: ground.h });

  const reach = 36;
  const GW = 2300;
  const scroll = addScrollLayers(A, "character", "speed", [
    { name: "bg-far", image: "walker-bg-far", x: 700, y: 240, w: GW, h: (GW * 429) / 2000, speed: 12 },
    { name: "bg-mid", image: mid.image, x: 700, y: 147, w: GW, h: (GW * mid.h) / mid.w, speed: 50 },
    { name: "bg-ground", image: ground.image, x: 700, y: -6, w: GW, h: (GW * ground.h) / ground.w, speed: reach * 4 },
  ]);

  const k = 0.4;
  const m = sideRig(A, {
    k,
    torso: { part: torso, hip: [0.56, 0.9], neck: [0.62, 0.1], shoulder: [0.58, 0.3] },
    head: { part: head, neck: [0.5, 0.9] },
    upper: { part: upper, top: [0.5, 0.1], bottom: [0.5, 0.88] },
    fore: { part: fore, top: [0.47, 0.07], wrist: [0.5, 0.72] },
    thigh: { part: thigh, top: [0.5, 0.1], bottom: [0.5, 0.84] },
    shin: { part: shin, top: [0.5, 0.12], bottom: [0.5, 0.88] },
    foot: { part: shoe, ankle: [0.27, 0.3] },
    drape: { part: scarf, length: 120, width: 38, at: [100, 14], rotation: 160 },
    stance: 26,
    bend: 0.5,
    legScale: 0.7,
    armScale: 0.74,
    backTint: "#c8ccd6",
  });
  A("addBoundingBox", { slot: "torso", name: "body-hit", x: 50, width: 130, height: 100 });
  A("addSlot", { bone: "root", name: "path-hit" });
  A("addBoundingBox", { slot: "path-hit", name: "path", y: -30, width: 900, height: 60 });

  let cur = "";
  const K = (target: string, id: string, property: string, keys: Keys, curve = "easeInOut") =>
    A("setKeys", { animation: cur, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  const hip = m.hipY;
  const a0 = m.ankleH;

  // ---- idle: breathing, a little bounce, head looking around ----
  A("createAnimation", { name: (cur = "idle"), duration: 2 });
  K("bone", "hip", "y", [[0, hip], [1, hip - 3], [2, hip]]);
  K("bone", "torso", "rotation", [[0, 88], [1, 90], [2, 88]]);
  K("bone", "head", "rotation", [[0, 0], [0.8, -4], [1.4, 3], [2, 0]]);
  K("bone", "back-arm", "rotation", [[0, 184], [1, 188], [2, 184]]);
  K("bone", "front-arm", "rotation", [[0, 192], [1, 188], [2, 192]]);
  K("bone", "back-forearm", "rotation", [[0, 14], [1, 18], [2, 14]]);
  K("bone", "front-forearm", "rotation", [[0, 18], [1, 14], [2, 18]]);
  K("bone", "drape2", "rotation", [[0, 0], [1, 5], [2, 0]]);
  K("bone", "drape3", "rotation", [[0, 0], [1, 8], [2, 0]]);

  // ---- walk (1 s): IK feet planted at the path's speed, bouncy hips, swinging arms, scarf streaming ----
  A("createAnimation", { name: (cur = "walk"), duration: 1 });
  walkFeet(K, a0, reach, 30);
  K("bone", "hip", "y", [[0, hip - 6], [0.25, hip + 4], [0.5, hip - 6], [0.75, hip + 4], [1, hip - 6]]);
  K("bone", "torso", "rotation", [[0, 82], [0.25, 84], [0.5, 82], [0.75, 84], [1, 82]]);
  K("bone", "head", "rotation", [[0, 6], [0.25, 4], [0.5, 6], [0.75, 4], [1, 6]]);
  K("bone", "back-arm", "rotation", [[0, 214], [0.5, 156], [1, 214]]);
  K("bone", "front-arm", "rotation", [[0, 156], [0.5, 214], [1, 156]]);
  K("bone", "back-forearm", "rotation", [[0, 30], [0.5, 10], [1, 30]]);
  K("bone", "front-forearm", "rotation", [[0, 10], [0.5, 30], [1, 10]]);
  K("bone", "drape1", "rotation", [[0, 145], [0.5, 138], [1, 145]]);
  K("bone", "drape2", "rotation", [[0, 6], [0.25, -4], [0.5, 8], [0.75, -4], [1, 6]]);
  K("bone", "drape3", "rotation", [[0, 12], [0.25, -6], [0.5, 14], [0.75, -6], [1, 12]]);
  A("addEventKey", { animation: "walk", event: "footstep", time: 0.02, string: "front" });
  A("addEventKey", { animation: "walk", event: "footstep", time: 0.52, string: "back" });

  // ---- jump (1.1 s): anticipation crouch, explosive take-off, tucked legs at the apex, squash on landing ----
  A("createAnimation", { name: (cur = "jump"), duration: 1.1 });
  const air = 88;
  K("bone", "hip", "y", [[0, hip], [0.14, hip - 30], [0.24, hip + 16], [0.5, hip + air], [0.72, hip + 30], [0.8, hip - 28], [0.94, hip + 4], [1.1, hip]], "easeInOut");
  K("bone", "torso", "rotation", [[0, 88], [0.14, 72], [0.24, 92], [0.5, 84], [0.76, 86], [0.82, 74], [1.1, 88]]);
  K("bone", "head", "rotation", [[0, 0], [0.14, 10], [0.24, -10], [0.5, -4], [0.82, 10], [1.1, 0]]);
  // Feet: planted through the crouch, pulled up under the body in the air, reaching down for the landing.
  for (const [side, x] of [["front", 13], ["back", -13]] as const) {
    K("bone", `${side}-foot`, "x", [[0, x], [0.2, x], [0.5, x + (side === "front" ? 14 : -4)], [0.74, x], [1.1, x]]);
    // Knees tucked high at the apex: the feet come up further than the hips rise.
    K("bone", `${side}-foot`, "y", [[0, a0], [0.2, a0], [0.3, a0 + 52], [0.5, a0 + air + 46], [0.68, a0 + 40], [0.78, a0], [1.1, a0]]);
    K("bone", `${side}-foot`, "rotation", [[0, 0], [0.2, -16], [0.32, -24], [0.5, -10], [0.72, 12], [0.78, 0], [1.1, 0]]);
  }
  // Arms swing back in the crouch, up and forward for lift, out for balance on landing.
  for (const [side, d] of [["back", 0], ["front", 10]] as const) {
    K("bone", `${side}-arm`, "rotation", [[0, 186 + d], [0.14, 120 + d], [0.26, 320 + d], [0.5, 300 + d], [0.78, 240 + d], [0.9, 210 + d], [1.1, 186 + d]]);
    K("bone", `${side}-forearm`, "rotation", [[0, 16], [0.14, 30], [0.26, 10], [0.5, 30], [0.8, 20], [1.1, 16]]);
  }
  K("bone", "drape1", "rotation", [[0, 160], [0.26, 130], [0.5, 185], [0.72, 210], [0.82, 145], [1.1, 160]]);
  K("bone", "drape3", "rotation", [[0, 0], [0.3, -14], [0.6, 18], [0.85, -10], [1.1, 0]]);
  A("addEventKey", { animation: "jump", event: "land", time: 0.78 });

  // ---- state machine: click the path to walk or stop (a script eases "speed" for the blend), click him to jump ----
  A("createStateMachine", { name: "character" });
  A("addInput", { stateMachine: "character", name: "walk", type: "bool" });
  A("addInput", { stateMachine: "character", name: "speed", type: "number", default: 0 });
  A("addInput", { stateMachine: "character", name: "jump", type: "trigger" });
  A("addState", { stateMachine: "character", name: "locomotion", type: "blend1d", blendInput: "speed", blend: [{ animation: "idle", value: 0 }, { animation: "walk", value: 1 }], x: 160, y: 120 });
  A("addState", { stateMachine: "character", animation: "jump", loop: false, x: 420, y: 120 });
  A("addTransition", { stateMachine: "character", from: "@any", to: "jump", conditions: [{ input: "jump" }], duration: 0.06 });
  A("addTransition", { stateMachine: "character", from: "jump", to: "locomotion", exitTime: 1, duration: 0.15 });
  A("addListener", { stateMachine: "character", slot: "torso", event: "click", actions: [{ type: "fireTrigger", input: "jump" }] });
  A("addListener", { stateMachine: "character", slot: "path-hit", event: "click", actions: [{ type: "toggleInput", input: "walk" }] });
  A("addScript", {
    name: "ease-speed",
    code: `// Ease the blend's "speed" towards the "walk" switch, so idle and walk cross-fade smoothly.
function onUpdate(dt) {
  const target = ob.input("walk") ? 1 : 0;
  const v = Number(ob.input("speed")) || 0;
  ob.setInput("speed", v + (target - v) * Math.min(1, dt * 4));
}`,
  });
  A("attachScript", { stateMachine: "character", script: "ease-speed" });
  scroll();
  sfx(A, "step", "walker-step", { volume: 0.55 });
  sfx(A, "jump", "walker-jump", { volume: 0.7 });
  sfx(A, "land", "walker-land", { volume: 0.8 });
  A("setEventSound", { event: "footstep", sound: "step" });
  A("setEventSound", { event: "land", sound: "land" });
  A("addAudioKey", { animation: "jump", sound: "jump", time: 0.18 });
  return s.doc;
}

// ---------- sounds (generated with ElevenLabs, see assets/eleven/LICENSE.md) ----------
type Op = (op: string, args: Record<string, unknown>) => unknown;
/** Add a sound from assets/eleven/<file>.wav (its length read from the file), with optional sound settings. */
function sfx(A: Op, name: string, file: string, o: { loop?: boolean; bus?: string; volume?: number; fadeIn?: number; fadeOut?: number } = {}) {
  const w = readWav(path.join(here, `assets/eleven/${file}.wav`));
  A("addAudio", { name, src: `assets/eleven/${file}.wav`, duration: Math.round((w.samples.length / w.rate) * 1000) / 1000, loop: o.loop ?? false, ...(o.bus ? { bus: o.bus } : {}) });
  const { volume, fadeIn, fadeOut } = o;
  if (volume !== undefined || fadeIn !== undefined || fadeOut !== undefined)
    A("updateSound", { sound: name, ...(volume !== undefined ? { volume } : {}), ...(fadeIn !== undefined ? { fadeIn } : {}), ...(fadeOut !== undefined ? { fadeOut } : {}) });
}

/**
 * Scrolling parallax for walk cycles: each layer (two copies side by side on one bone) slides left at its own speed
 * times the value of a state-machine input (eased), wrapping every tile width. The ground layer should move at the
 * feet's speed so they don't skate; far layers move slower.
 */
function addScrollLayers(
  A: Op,
  stateMachine: string,
  input: string,
  layers: ReadonlyArray<{ name: string; image: string; x: number; y: number; w: number; h: number; speed: number; parent?: string }>,
) {
  for (const l of layers) {
    A("addBone", { name: l.name, ...(l.parent ? { parent: l.parent } : {}), x: l.x, y: l.y, length: 0, color: "#7fb7ff" });
    for (const [k, dx] of [["a", 0], ["b", l.w]] as const) {
      A("addSlot", { bone: l.name, name: `${l.name}-${k}` });
      A("addRegion", { slot: `${l.name}-${k}`, image: l.image, x: dx, width: l.w, height: l.h });
    }
  }
  return () => {
    A("addScript", {
      name: "scroll",
      code: `// Parallax scrolling: layers slide at their own speed while "${input}" is on, wrapping every tile width.
const layers = ${JSON.stringify(layers.map((l) => ({ bone: l.name, x: l.x, y: l.y, w: l.w, speed: l.speed })))};
const off = layers.map(() => 0);
let v = 0;
function onUpdate(dt) {
  const target = Number(ob.input("${input}")) || 0;
  v += (target - v) * Math.min(1, dt * 5);
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    off[i] = (off[i] - l.speed * v * dt) % l.w;
    ob.setBone(l.bone, { x: l.x + off[i], y: l.y });
  }
}`,
    });
    A("attachScript", { stateMachine, script: "scroll" });
  };
}

/** Button audio: a click on the press event and a soft shimmer when the pointer enters. */
export function addButtonAudio(A: Op) {
  sfx(A, "click", "button-click", { bus: "ui", volume: 0.8 });
  sfx(A, "hover", "button-hover", { bus: "ui", volume: 0.45 });
  A("setEventSound", { event: "clicked", sound: "click" });
  // On the pointer entering (not on the hover state, which is re-entered after every press).
  A("addListener", { stateMachine: "ui", name: "hover sound", slot: "hit", event: "enter", actions: [{ type: "playSound", sound: "hover" }] });
}

// ---------- button ----------
function button() {
  const s = new DocumentStore(createDocument("Button", { background: "#0f172a" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 400, height: 200, originX: 200, originY: 100 });
  A("addBone", { name: "btn", length: 0 });
  A("addBone", { name: "shine", parent: "btn", x: -140, length: 0 });
  // Painted button art (see assets/canva/LICENSE.md); its own drop shadow is part of the image.
  A("addImage", { name: "button-play", src: "assets/canva/button-play.png", width: 262, height: 109 });
  A("addSlot", { bone: "btn", name: "bg" });
  A("addRegion", { slot: "bg", image: "button-play", width: 236, height: 98 });
  // Glass sweep: the shine slides across on hover, clipped to the button's rounded outline.
  A("addSlot", { bone: "btn", name: "glass-mask" });
  A("addSlot", { bone: "shine", name: "shine", color: "#ffffff00" });
  A("addClipping", { slot: "glass-mask", name: "mask", y: 3, width: 222, height: 80, radius: 38, end: "shine" });
  A("addShape", { slot: "shine", shape: "polygon", points: [-10, 45, 20, 45, 0, -45, -30, -45], fill: "#ffffff66" });
  A("addSlot", { bone: "btn", name: "hit" });
  A("addBoundingBox", { slot: "hit", width: 230, height: 90 });
  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | string][], curve: string = "easeOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  A("createAnimation", { name: "idle", duration: 1.5 });
  K("idle", "bone", "btn", "scaleX", [[0, 1], [0.75, 1.02], [1.5, 1]], "easeInOut");
  K("idle", "bone", "btn", "scaleY", [[0, 1], [0.75, 1.02], [1.5, 1]], "easeInOut");
  A("createAnimation", { name: "hover", duration: 0.6 });
  K("hover", "bone", "btn", "scaleX", [[0, 1], [0.25, 1.08]], "backOut");
  K("hover", "bone", "btn", "scaleY", [[0, 1], [0.25, 1.08]], "backOut");
  K("hover", "slot", "bg", "color", [[0, "#ffffff"], [0.25, "#ffe7b3"]]);
  K("hover", "slot", "shine", "color", [[0, "#ffffffff"], [0.6, "#ffffffff"]]);
  K("hover", "bone", "shine", "x", [[0, -140], [0.6, 140]], "easeInOut");
  A("createAnimation", { name: "press", duration: 0.25 });
  K("press", "bone", "btn", "scaleX", [[0, 1.08], [0.08, 0.94], [0.25, 1.08]]);
  K("press", "bone", "btn", "scaleY", [[0, 1.08], [0.08, 0.9], [0.25, 1.08]]);
  K("press", "bone", "btn", "y", [[0, 0], [0.08, -4], [0.25, 0]]);
  A("addEventKey", { animation: "press", event: "clicked", time: 0.08 });
  A("createStateMachine", { name: "ui" });
  A("addInput", { stateMachine: "ui", name: "hover", type: "bool" });
  A("addInput", { stateMachine: "ui", name: "press", type: "trigger" });
  A("addState", { stateMachine: "ui", animation: "idle", x: 120, y: 120 });
  A("addState", { stateMachine: "ui", animation: "hover", loop: false, x: 360, y: 60 });
  A("addState", { stateMachine: "ui", animation: "press", loop: false, x: 360, y: 200 });
  A("addTransition", { stateMachine: "ui", from: "idle", to: "hover", conditions: [{ input: "hover", value: true }], duration: 0.1 });
  A("addTransition", { stateMachine: "ui", from: "hover", to: "idle", conditions: [{ input: "hover", value: false }], duration: 0.2 });
  A("addTransition", { stateMachine: "ui", from: "@any", to: "press", conditions: [{ input: "press" }], duration: 0.05 });
  A("addTransition", { stateMachine: "ui", from: "press", to: "hover", conditions: [{ input: "hover", value: true }], exitTime: 1, duration: 0.05 });
  A("addTransition", { stateMachine: "ui", from: "press", to: "idle", conditions: [{ input: "hover", value: false }], exitTime: 1, duration: 0.1 });
  A("addListener", { stateMachine: "ui", slot: "hit", event: "enter", actions: [{ type: "setInput", input: "hover", value: true }] });
  A("addListener", { stateMachine: "ui", slot: "hit", event: "exit", actions: [{ type: "setInput", input: "hover", value: false }] });
  A("addListener", { stateMachine: "ui", slot: "hit", event: "down", actions: [{ type: "fireTrigger", input: "press" }] });
  addButtonAudio(A);
  return s.doc;
}

// ---------- tail (path constraint + physics) ----------
function tail() {
  const s = new DocumentStore(createDocument("Tail", { background: "#bfe3ff" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 800, height: 500, originX: 470, originY: 380 });
  // Painted creature and meadow (see assets/eleven/LICENSE.md). The tail and antenna art is stored already turned to
  // lie along its bones, so the mesh grids map straight onto the chains.
  A("addImage", { name: "tail-body", src: "assets/eleven/tail-body.png", width: 420, height: 436 });
  A("addImage", { name: "tail-tail", src: "assets/eleven/tail-tail.png", width: 520, height: 213 });
  A("addImage", { name: "tail-antenna", src: "assets/eleven/tail-antenna.png", width: 260, height: 60 });
  A("addImage", { name: "tail-bg-far", src: "assets/eleven/tail-bg-far.jpg", width: 1600, height: 900 });
  const nearGrass = existsSync(path.join(here, "assets/eleven/tail-bg-near.png"));
  if (nearGrass) A("addImage", { name: "tail-bg-near", src: "assets/eleven/tail-bg-near.png", width: 1400, height: 261 });

  // Parallax layers hang off their own bones; a script moves them with the pointer (far a little, near a lot).
  A("addBone", { name: "bg-far", x: -70, y: 130, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "bg-near", x: -70, y: -70, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "body", y: 120, length: 0, color: "#ff9f43" });
  A("addBone", { name: "head", parent: "body", x: 52, y: 92, length: 0 });
  // Tail chain: 8 bones placed along the path by the path constraint.
  const SEG = 38;
  A("addBone", { name: "tail1", parent: "body", x: -100, y: -20, rotation: 165, length: SEG });
  for (let i = 2; i <= 8; i++) A("addBone", { name: `tail${i}`, parent: `tail${i - 1}`, x: SEG, length: SEG });
  // The path lives on `tail-base`; its knots are bound to control bones that the animations move.
  A("addBone", { name: "tail-base", parent: "body", x: -100, y: -20, rotation: 165, length: 0, color: "#ff7a00" });
  for (let i = 1; i <= 3; i++) A("addBone", { name: `ctrl${i}`, parent: "tail-base", x: i * 102, length: 0, color: "#ff7a00" });
  // Antennae: two-bone chains with spring physics, from the top of the head.
  for (const [side, x, y, rot] of [["l", -10, 0, 104], ["r", 10, -6, 72]] as const) {
    A("addBone", { name: `antenna-${side}1`, parent: "head", x, y, rotation: rot, length: 55 });
    A("addBone", { name: `antenna-${side}2`, parent: `antenna-${side}1`, x: 55, rotation: -18, length: 55 });
  }

  // Visuals, back to front: far meadow, tail, antennae, body, near grass.
  A("addSlot", { bone: "bg-far", name: "bg-far" });
  A("addRegion", { slot: "bg-far", image: "tail-bg-far", width: 900, height: 506 });
  A("addSlot", { bone: "tail-base", name: "tail-path" });
  A("addPath", { slot: "tail-path", anchors: [0, 0, 102, 0, 204, 0, 306, 0], color: "#ff7a00" });
  for (let k = 1; k <= 3; k++)
    for (let v = k * 3; v < k * 3 + 3; v++)
      A("setWeights", { slot: "tail-path", attachment: "path", vertex: v, influences: [{ bone: `ctrl${k}`, weight: 1 }] });
  // The painted tail as one mesh weighted along the chain, so it bends smoothly as the path moves.
  A("addSlot", { bone: "tail1", name: "tail" });
  A("addMesh", { slot: "tail", name: "tail", image: "tail-tail", x: (SEG * 8) / 2, width: SEG * 8, height: 125, cols: 16, rows: 2 });
  A("autoWeights", { slot: "tail", attachment: "tail", bones: ["tail1", "tail2", "tail3", "tail4", "tail5", "tail6", "tail7", "tail8"], maxInfluences: 2 });
  for (const side of ["r", "l"]) {
    A("addSlot", { bone: `antenna-${side}1`, name: `antenna-${side}` });
    A("addMesh", { slot: `antenna-${side}`, name: "antenna", image: "tail-antenna", x: 55, width: 110, height: 26, cols: 6, rows: 1 });
    A("autoWeights", { slot: `antenna-${side}`, attachment: "antenna", bones: [`antenna-${side}1`, `antenna-${side}2`], maxInfluences: 2 });
  }
  A("addSlot", { bone: "body", name: "body" });
  A("addRegion", { slot: "body", image: "tail-body", y: 15, width: 260, height: 270 });
  A("addBoundingBox", { slot: "body", name: "body-hit", y: 15, width: 230, height: 250 });
  if (nearGrass) {
    A("addSlot", { bone: "bg-near", name: "bg-near" });
    A("addRegion", { slot: "bg-near", image: "tail-bg-near", y: 22, width: 1000, height: 186 });
  }

  A("addPathConstraint", {
    name: "tail-path",
    bones: ["tail1", "tail2", "tail3", "tail4", "tail5", "tail6", "tail7", "tail8"],
    target: "tail-path",
    positionMode: "fixed",
    position: 0,
    spacingMode: "length",
    rotateMode: "chain",
  });
  for (const side of ["l", "r"])
    for (const n of [1, 2])
      A("addPhysicsConstraint", { name: `antenna-${side}${n}`, bone: `antenna-${side}${n}`, inertia: 0.9, strength: 90, damping: 3, gravity: 60 });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  // ---- wag: a travelling wave down the tail's control points ----
  A("createAnimation", { name: "wag", duration: 1.6 });
  const wave = (amp: number, phase: number): [number, number][] =>
    [0, 1, 2, 3, 4].map((i) => [i * 0.4, [0, amp, 0, -amp][(i + phase) % 4]]);
  K("wag", "bone", "ctrl1", "y", wave(22, 0));
  K("wag", "bone", "ctrl2", "y", wave(45, 1));
  K("wag", "bone", "ctrl3", "y", wave(75, 2));
  K("wag", "bone", "body", "y", [[0, 120], [0.4, 123], [0.8, 120], [1.2, 123], [1.6, 120]]);
  K("wag", "bone", "body", "scaleY", [[0, 1], [0.4, 0.98], [0.8, 1], [1.2, 0.98], [1.6, 1]]);
  K("wag", "bone", "head", "rotation", [[0, 0], [0.8, -6], [1.6, 0]]);
  // ---- curl: control points sweep up over the back; spacing tightens (keyed path field) ----
  A("createAnimation", { name: "curl", duration: 2 });
  K("curl", "bone", "ctrl1", "x", [[0, 102], [1, 90], [2, 102]]);
  K("curl", "bone", "ctrl1", "y", [[0, 0], [1, -45], [2, 0]]);
  K("curl", "bone", "ctrl2", "x", [[0, 204], [1, 135], [2, 204]]);
  K("curl", "bone", "ctrl2", "y", [[0, 0], [1, -145], [2, 0]]);
  K("curl", "bone", "ctrl3", "x", [[0, 306], [1, 55], [2, 306]]);
  K("curl", "bone", "ctrl3", "y", [[0, 0], [1, -190], [2, 0]]);
  K("curl", "path", "tail-path", "spacing", [[0, 0], [1, -6], [2, 0]]);
  // A happy hop: crouch, spring up, land with a squash.
  K("curl", "bone", "body", "y", [[0, 120], [0.2, 114], [0.5, 165], [0.85, 120], [1, 120], [2, 120]]);
  K("curl", "bone", "body", "scaleY", [[0, 1], [0.2, 0.9], [0.35, 1.08], [0.85, 0.9], [1.05, 1], [2, 1]]);
  K("curl", "bone", "body", "scaleX", [[0, 1], [0.2, 1.06], [0.35, 0.95], [0.85, 1.06], [1.05, 1], [2, 1]]);
  sfx(A, "chirp", "tail-chirp", { volume: 0.7 });
  A("addAudioKey", { animation: "curl", sound: "chirp", time: 0.35 });
  // Click the creature: it hops and curls its tail, then wags again.
  A("createStateMachine", { name: "creature" });
  A("addInput", { stateMachine: "creature", name: "curl", type: "trigger" });
  A("addState", { stateMachine: "creature", animation: "wag", x: 120, y: 120 });
  A("addState", { stateMachine: "creature", animation: "curl", loop: false, onComplete: "wag", x: 380, y: 120 });
  A("addTransition", { stateMachine: "creature", from: "wag", to: "curl", conditions: [{ input: "curl" }], duration: 0.15 });
  A("addListener", { stateMachine: "creature", slot: "body", event: "click", actions: [{ type: "fireTrigger", input: "curl" }] });
  // Parallax: a slow camera pan on its own state-machine layer. Each depth moves by its own amount (the meadow a
  // little, the creature more, the grass in front most), so the scene reads as layers in depth.
  A("createAnimation", { name: "camera-pan", duration: 10 });
  const pan = (id: string, base: number, amp: number) =>
    A("setKeys", { animation: "camera-pan", target: "bone", id, property: "x", keys: [[0, base], [5, base - amp], [10, base]].map(([time, value]) => ({ time, value, curve: "easeInOut" })) });
  pan("bg-far", -70, -24);
  pan("body", 0, -55);
  if (nearGrass) pan("bg-near", -70, -95);
  A("addLayer", { stateMachine: "creature", name: "camera" });
  A("addState", { stateMachine: "creature", layer: "camera", animation: "camera-pan", x: 120, y: 120 });
  return s.doc;
}

// ---------- campfire (sprite sequences) ----------
const FLAME_FRAMES = 12;
/** One frame of a looping flame: tongues of fire whose height and sway follow sines of the loop phase. */
function makeFlame(i: number) {
  const w = 64;
  const h = 96;
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  const ph = (i / FLAME_FRAMES) * Math.PI * 2;
  const tongue = (cx: number, base: number, width: number, height: number, sway: number, inner: string, outer: string) => {
    const grad = g.createLinearGradient(0, base, 0, base - height);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx - width / 2, base);
    g.bezierCurveTo(cx - width / 2, base - height * 0.5, cx + sway - width * 0.15, base - height * 0.7, cx + sway, base - height);
    g.bezierCurveTo(cx + sway + width * 0.15, base - height * 0.7, cx + width / 2, base - height * 0.5, cx + width / 2, base);
    g.closePath();
    g.fill();
  };
  g.globalCompositeOperation = "lighter";
  tongue(32, 92, 46, 70 + 10 * Math.sin(ph), 8 * Math.sin(ph + 1), "rgba(255,90,0,0.85)", "rgba(255,40,0,0)");
  tongue(24, 92, 26, 52 + 12 * Math.sin(ph * 2 + 2), -6 + 5 * Math.sin(ph * 2), "rgba(255,140,0,0.8)", "rgba(255,80,0,0)");
  tongue(41, 92, 24, 48 + 12 * Math.sin(ph * 2 + 4), 6 + 5 * Math.cos(ph * 2), "rgba(255,140,0,0.8)", "rgba(255,80,0,0)");
  tongue(32, 92, 22, 40 + 8 * Math.sin(ph + 3), 4 * Math.sin(ph * 3), "rgba(255,240,150,0.95)", "rgba(255,200,60,0)");
  return c.toBuffer("image/png");
}
const SMOKE_FRAMES = 6;
function makeSmoke(i: number) {
  const c = createCanvas(48, 48);
  const g = c.getContext("2d");
  const r = 8 + i * 2.5;
  const grad = g.createRadialGradient(24, 24, 0, 24, 24, r);
  grad.addColorStop(0, `rgba(120,120,130,${0.5 - i * 0.07})`);
  grad.addColorStop(1, "rgba(120,120,130,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 48, 48);
  return c.toBuffer("image/png");
}
const frameName = (base: string, i: number) => `${base}_${String(i + 1).padStart(4, "0")}`;

function campfire() {
  const s = new DocumentStore(createDocument("Campfire", { background: "#1d2333" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 400, height: 400, originX: 200, originY: 330, fps: 30 });
  const frames = (base: string, n: number, w: number, h: number) =>
    Array.from({ length: n }, (_, i) => {
      const name = frameName(base, i);
      A("addImage", { name, src: `assets/${name}.png`, width: w, height: h });
      return name;
    });
  A("addBone", { name: "fire", y: 0, length: 0 });
  A("addBone", { name: "smoke", parent: "fire", y: 270, length: 0 });
  // A three-bone tongue of fire that bends and licks: a mesh flame weighted to it sways on top of the frame flames.
  A("addBone", { name: "tongue1", parent: "fire", x: 6, y: -20, rotation: 90, length: 65, color: "#ff7a00" });
  A("addBone", { name: "tongue2", parent: "tongue1", x: 65, length: 65, color: "#ff7a00" });
  A("addBone", { name: "tongue3", parent: "tongue2", x: 65, length: 60, color: "#ff7a00" });
  // Painted logs and stone ring (see assets/eleven/LICENSE.md): 460 × 306 art drawn 270 wide, centred at y 30.
  const LW = 270, LH = 180, LY = 30, k = LW / 460;
  const art = (ix: number, iy: number) => [Math.round((ix * k - LW / 2) * 10) / 10, Math.round((LY + LH / 2 - iy * k) * 10) / 10];
  A("addImage", { name: "campfire-logs", src: "assets/eleven/campfire-logs.png", width: 460, height: 306 });

  // Back to front: glow, smoke, the logs, firelight on the logs, the flames on the wood, then the front stones again
  // (clipped to their outline) so the flames' base sits down among the coals, behind the stones.
  A("addSlot", { bone: "root", name: "glow" });
  A("addShape", { slot: "glow", shape: "ellipse", y: 90, width: 380, height: 260, fill: "#ff8a000d" });
  A("addSlot", { bone: "smoke", name: "smoke" });
  A("addSequence", { slot: "smoke", name: "smoke", frames: frames("smoke", SMOKE_FRAMES, 48, 48), fps: 8, mode: "pingPong", scaleX: 2, scaleY: 2 });
  A("addSlot", { bone: "root", name: "logs" });
  A("addRegion", { slot: "logs", image: "campfire-logs", y: LY, width: LW, height: LH });
  // Firelight: the same art again, added in orange and flickering, so the wood and stones look lit by the fire.
  A("addSlot", { bone: "root", name: "firelight", color: "#ff7a1a55", blend: "additive" });
  A("addRegion", { slot: "firelight", name: "lit", image: "campfire-logs", y: LY, width: LW, height: LH });
  const flame = frames("flame", FLAME_FRAMES, 64, 96);
  A("addSlot", { bone: "fire", name: "flame-small", blend: "additive" });
  A("addSequence", { slot: "flame-small", name: "flame", frames: flame, x: 46, y: 58, width: 100, height: 180, fps: 15, offset: 6 });
  A("addSlot", { bone: "fire", name: "flame", color: "#ffffffe6", blend: "additive" });
  A("addSequence", { slot: "flame", name: "flame", frames: flame, x: 4, y: 115, width: 170, height: 330, fps: 15, mode: "loop" });
  A("addSlot", { bone: "fire", name: "tongue", color: "#ffd9a6aa", blend: "additive" });
  A("addMesh", { slot: "tongue", name: "tongue", image: frameName("flame", 5), x: 6, y: 82, width: 100, height: 220, cols: 3, rows: 6 });
  A("autoWeights", { slot: "tongue", attachment: "tongue", bones: ["tongue1", "tongue2", "tongue3"], maxInfluences: 2 });
  // Front stones: their top edge traced on the art (pixel coordinates), everything below it drawn over the flames.
  const front = [[0, 306], [460, 306], [460, 180], [440, 172], [400, 170], [375, 182], [355, 205], [330, 212], [300, 215], [240, 213], [200, 218], [160, 215], [122, 212], [110, 195], [80, 180], [40, 178], [10, 195], [0, 210]].flatMap(([x, y]) => art(x, y));
  A("addSlot", { bone: "root", name: "front-mask" });
  A("addSlot", { bone: "root", name: "front-stones" });
  A("addClipping", { slot: "front-mask", name: "front-mask", vertices: front, end: "front-stones" });
  A("addRegion", { slot: "front-stones", name: "front", image: "campfire-logs", y: LY, width: LW, height: LH });

  // burn: the fire breathes, the tongue licks (each bone a little later and further than its parent), the firelight
  // flickers on the wood and the glow pulses.
  A("createAnimation", { name: "burn", duration: 1.6 });
  const K = (target: string, id: string, property: string, keys: [number, number | string][], curve = "easeInOut") =>
    A("setKeys", { animation: "burn", target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  K("bone", "fire", "scaleY", [[0, 1], [0.8, 1.08], [1.6, 1]]);
  K("bone", "tongue1", "rotation", [[0, 90], [0.4, 95], [0.8, 87], [1.2, 93], [1.6, 90]]);
  K("bone", "tongue2", "rotation", [[0, -4], [0.5, 8], [0.9, -9], [1.3, 6], [1.6, -4]]);
  K("bone", "tongue3", "rotation", [[0, 10], [0.6, -14], [1.0, 16], [1.35, -8], [1.6, 10]]);
  K("bone", "tongue1", "scaleX", [[0, 1], [0.3, 1.12], [0.7, 0.92], [1.1, 1.1], [1.6, 1]]);
  K("slot", "firelight", "color", [[0, "#ff7a1a55"], [0.15, "#ff7a1a3a"], [0.35, "#ff8a2a66"], [0.6, "#ff7a1a40"], [0.8, "#ff8a2a5c"], [1.05, "#ff7a1a33"], [1.3, "#ff8a2a60"], [1.6, "#ff7a1a55"]], "linear");
  K("slot", "glow", "color", [[0, "#ffffff"], [0.8, "#ffffffaa"], [1.6, "#ffffff"]]);
  // The crackle loops for as long as the fire burns (a looping sound on a state plays until the state exits).
  sfx(A, "crackle", "campfire-loop", { loop: true, volume: 0.8, fadeIn: 0.5 });
  A("createStateMachine", { name: "fire" });
  A("addState", { stateMachine: "fire", animation: "burn", x: 120, y: 120 });
  A("setStateSound", { stateMachine: "fire", state: "burn", sound: "crackle" });
  return s.doc;
}

// ---------- rocket (particles) ----------
/** Height of the launch pad's deck above the ground (the rocket stands on it). */
const DECK = 75;

function rocket() {
  const s = new DocumentStore(createDocument("Rocket", { background: "#1b1440" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 600, height: 700, originX: 300, originY: 620 });
  // Painted rocket, launch pad and dusk space centre (see assets/eleven/LICENSE.md). The sky, the space centre and the
  // pad sit on their own bones: on launch they drop away at different speeds, so the camera seems to follow the rocket.
  A("addImage", { name: "rocket-bg-far", src: "assets/eleven/rocket-bg-far.jpg", width: 900, height: 1355 });
  A("addImage", { name: "rocket-bg-mid", src: "assets/eleven/rocket-bg-mid.png", width: 2000, height: 320 });
  A("addImage", { name: "rocket-pad", src: "assets/eleven/rocket-pad.png", width: 560, height: 564 });
  A("addImage", { name: "rocket-ship", src: "assets/eleven/rocket-ship.png", width: 197, height: 435 });
  A("addBone", { name: "bg-far", y: 200, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "bg-mid", y: 60, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "pad", length: 0 });
  A("addBone", { name: "rocket", y: DECK, length: 0, color: "#ff9f43" });
  A("addBone", { name: "nozzle", parent: "rocket", y: 6, length: 0 });
  // Back to front: sky, space centre, ground, launch pad, smoke, exhaust, sparks, then the rocket over its own flame.
  A("addSlot", { bone: "bg-far", name: "sky" });
  A("addRegion", { slot: "sky", image: "rocket-bg-far", width: 640, height: 964 });
  A("addSlot", { bone: "bg-mid", name: "space-centre" });
  A("addRegion", { slot: "space-centre", image: "rocket-bg-mid", width: 1200, height: 192 });
  A("addSlot", { bone: "pad", name: "ground" });
  A("addShape", { slot: "ground", shape: "rect", y: -60, width: 700, height: 120, fill: "#231c3a" });
  A("addSlot", { bone: "pad", name: "launch-pad" });
  A("addRegion", { slot: "launch-pad", image: "rocket-pad", x: -48, y: 201.5, width: 400, height: 403 });
  A("addSlot", { bone: "pad", name: "smoke" });
  A("addParticles", { slot: "smoke", name: "smoke", preset: "smoke", emitting: false, prewarm: false, shape: "box", y: DECK, width: 180, height: 6, rate: 30, angle: 60, speed: [40, 90], seed: 3 });
  A("addSlot", { bone: "nozzle", name: "exhaust" });
  A("addParticles", { slot: "exhaust", name: "exhaust", preset: "exhaust", emitting: false, seed: 11 });
  A("addSlot", { bone: "nozzle", name: "sparks" });
  A("addParticles", { slot: "sparks", name: "sparks", preset: "sparks", emitting: false, rotation: -90, angle: 120, loop: true, duration: 0.35, bursts: [{ time: 0, count: 14 }], gravity: 300, seed: 5 });
  A("addSlot", { bone: "rocket", name: "body" });
  A("addRegion", { slot: "body", image: "rocket-ship", y: 130, width: 118, height: 260 });
  A("addSlot", { bone: "rocket", name: "hit" });
  A("addBoundingBox", { slot: "hit", y: 130, width: 110, height: 260 });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | boolean][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve: typeof value === "boolean" ? "stepped" : curve })) });
  // ---- launch: sits, ignites (sparks + smoke), then climbs out of frame with a world-space exhaust trail ----
  A("createAnimation", { name: "launch", duration: 3 });
  K("launch", "particles", "exhaust", "emitting", [[0, false], [0.5, true]]);
  K("launch", "particles", "exhaust", "rate", [[0.5, 40], [1.2, 110]]);
  K("launch", "particles", "sparks", "emitting", [[0, false], [0.45, true], [1.4, false]]);
  K("launch", "particles", "smoke", "emitting", [[0, false], [0.5, true], [1.8, false]]);
  K("launch", "bone", "rocket", "y", [[0, DECK], [0.5, DECK], [3, 820]], "easeIn");
  // The world falls away: the pad fastest, the space centre slower, the sky barely (parallax).
  K("launch", "bone", "pad", "y", [[0, 0], [0.6, 0], [3, -520]], "easeIn");
  K("launch", "bone", "bg-mid", "y", [[0, 60], [0.6, 60], [3, -180]], "easeIn");
  K("launch", "bone", "bg-far", "y", [[0, 200], [0.6, 200], [3, 140]], "easeIn");
  K("launch", "bone", "rocket", "x", [[0, 0], [0.6, 0], [3, 60]], "easeIn");
  K("launch", "bone", "rocket", "rotation", [[0, 0], [0.5, 0], [0.55, 2], [0.6, -2], [0.65, 0], [3, -8]], "linear");
  // ---- land: the rocket comes back down on its exhaust, the world rises back into view, touch-down on the pad ----
  A("createAnimation", { name: "land", duration: 3.2 });
  K("land", "bone", "rocket", "y", [[0, 820], [2.7, DECK + 6], [3.0, DECK]], "easeOut");
  K("land", "bone", "rocket", "x", [[0, 60], [2.4, 0]], "easeOut");
  K("land", "bone", "rocket", "rotation", [[0, -8], [1.6, 3], [2.4, -1], [3.0, 0]]);
  K("land", "bone", "pad", "y", [[0, -520], [2.6, 0]], "easeOut");
  K("land", "bone", "bg-mid", "y", [[0, -180], [2.6, 60]], "easeOut");
  K("land", "bone", "bg-far", "y", [[0, 140], [2.6, 200]], "easeOut");
  K("land", "particles", "exhaust", "emitting", [[0, true], [2.95, false]]);
  K("land", "particles", "exhaust", "rate", [[0, 90], [2.4, 60], [2.9, 30]]);
  K("land", "particles", "smoke", "emitting", [[0, false], [2.3, true], [3.2, false]]);
  A("createAnimation", { name: "parked", duration: 1 });
  K("parked", "bone", "rocket", "y", [[0, DECK]]);
  // ---- state machine: click the rocket to launch it; it flies out of frame, comes back down and lands ----
  A("createStateMachine", { name: "engine" });
  A("addInput", { stateMachine: "engine", name: "launch", type: "trigger" });
  A("addState", { stateMachine: "engine", name: "parked", animation: "parked", x: 120, y: 120 });
  A("addState", { stateMachine: "engine", name: "land", animation: "land", loop: false, onComplete: "parked", x: 360, y: 200 });
  A("addState", { stateMachine: "engine", name: "launch", animation: "launch", loop: false, onComplete: "land", x: 360, y: 60 });
  A("setStateEmitter", { stateMachine: "engine", state: "parked", slot: "exhaust", emitting: false });
  A("addTransition", { stateMachine: "engine", from: "parked", to: "launch", conditions: [{ input: "launch" }], duration: 0.1 });
  A("addListener", { stateMachine: "engine", slot: "hit", event: "down", actions: [{ type: "fireTrigger", input: "launch" }] });
  // Sounds: ignition at lift-off; the engine roars while it comes back down and fades as it touches the pad.
  sfx(A, "ignite", "rocket-ignite", { volume: 0.6 });
  sfx(A, "engine", "rocket-engine-loop", { loop: true, volume: 0.3, fadeIn: 0.3, fadeOut: 0.8 });
  A("addAudioKey", { animation: "launch", sound: "ignite", time: 0.35 });
  A("setStateSound", { stateMachine: "engine", state: "land", sound: "engine" });
  return s.doc;
}

// ---------- crash: staged game flow driven by live data ----------
// idle → flyout (plays once) → flying (loops) → crash | cashout (play once) → idle.
// The host app ramps `multiplier`; a text attachment shows it and bindings move the rocket and tint the sky.
function crash() {
  const s = new DocumentStore(createDocument("Crash", { background: "#0b1020" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 800, height: 500, originX: 110, originY: 420 });
  A("addBone", { name: "climb", length: 0 });
  A("addBone", { name: "rocket", parent: "climb", rotation: 35, length: 70, color: "#ff9f43" });
  A("addBone", { name: "flame", parent: "rocket", x: -34, rotation: 180, length: 30 });
  A("addBone", { name: "boom", parent: "rocket", x: 10, length: 0 });
  A("addBone", { name: "hud", x: 290, y: 300, length: 0 });
  A("addBone", { name: "status", x: 290, y: 236, length: 0 });
  A("addBone", { name: "button", x: 570, y: -40, length: 0 });

  // Painted night sky, clouds, space centre and rocket (see assets/eleven/LICENSE.md); the explosion frames are Canva
  // art (assets/canva/LICENSE.md). The layers sit on their own bones, bound to the multiplier at different rates, so
  // the rocket seems to climb through them (parallax). The sky's tint is bound too.
  A("addImage", { name: "crash-sky", src: "assets/eleven/crash-bg-sky.jpg", width: 1600, height: 900 });
  A("addImage", { name: "crash-clouds", src: "assets/eleven/crash-bg-clouds.png", width: 2000, height: 379 });
  A("addImage", { name: "crash-ground", src: "assets/eleven/rocket-bg-mid.png", width: 2000, height: 320 });
  A("addImage", { name: "crash-pad", src: "assets/eleven/rocket-pad.png", width: 560, height: 564 });
  A("addImage", { name: "rocket", src: "assets/eleven/rocket-ship.png", width: 197, height: 435 });
  for (let i = 1; i <= 4; i++) A("addImage", { name: `explosion_${String(i).padStart(4, "0")}`, src: `assets/canva/explosion_${String(i).padStart(4, "0")}.png`, width: 180, height: 180 });
  A("addBone", { name: "sky-layer", x: 290, y: 170, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "cloud-layer", x: 420, y: 190, length: 0, color: "#7fb7ff" });
  A("addBone", { name: "ground-layer", x: 290, y: 0, length: 0, color: "#7fb7ff" });
  A("addSlot", { bone: "sky-layer", name: "sky", color: "#c9d2ff" });
  A("addRegion", { slot: "sky", image: "crash-sky", width: 1100, height: 619 });
  A("addSlot", { bone: "cloud-layer", name: "clouds", color: "#ffffffa0" });
  A("addRegion", { slot: "clouds", image: "crash-clouds", width: 1700, height: 322 });
  A("addSlot", { bone: "ground-layer", name: "ground" });
  A("addRegion", { slot: "ground", image: "crash-ground", y: 18, width: 1300, height: 208 });
  A("addSlot", { bone: "ground-layer", name: "pad" });
  A("addRegion", { slot: "pad", image: "crash-pad", x: -308, y: 38, width: 150, height: 151 });

  // Rocket.
  A("addSlot", { bone: "flame", name: "flame" });
  A("addShape", { slot: "flame", shape: "polygon", points: [0, 12, 46, 0, 0, -12], fill: "#f97316" });
  A("addSlot", { bone: "flame", name: "flame-core" });
  A("addShape", { slot: "flame-core", shape: "polygon", points: [0, 6, 26, 0, 0, -6], fill: "#fde047" });
  // The rocket image points up; the bone points along the flight path (nose at +x).
  A("addSlot", { bone: "rocket", name: "body" });
  A("addRegion", { slot: "body", image: "rocket", x: 10, rotation: -90, width: 46, height: 102 });
  // Explosion: a 4-frame painted sequence, additive so its dark backdrop disappears.
  A("addSlot", { bone: "boom", name: "boom", color: "#ffffff00", blend: "additive" });
  A("addSequence", { slot: "boom", name: "boom", frames: ["explosion_0001", "explosion_0002", "explosion_0003", "explosion_0004"], fps: 6, mode: "holdLast", width: 120, height: 120 });

  // HUD: the live multiplier and a status line (a string input), both text templates.
  A("addSlot", { bone: "hud", name: "multiplier" });
  A("addText", { slot: "multiplier", text: "{multiplier:0.00}x", size: 84, weight: 800, width: 360, height: 100, color: "#ffffff", outline: "#0b1020", outlineWidth: 4 });
  A("addSlot", { bone: "status", name: "status" });
  A("addText", { slot: "status", text: "{status}", size: 22, weight: 600, width: 420, height: 32, color: "#e2e8f0", outline: "#0b1020", outlineWidth: 3 });

  // Start button: the text attachment's box is the hit area for the click listener.
  A("addSlot", { bone: "button", name: "button-bg" });
  A("addShape", { slot: "button-bg", shape: "rect", width: 150, height: 48, radius: 24, fill: "#22c55e" });
  A("addSlot", { bone: "button", name: "button-label" });
  A("addText", { slot: "button-label", text: "START", size: 22, weight: 700, width: 150, height: 48, color: "#052e16" });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | string][], curve: string = "linear") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  // idle: parked on the pad, pilot light flickering.
  A("createAnimation", { name: "idle", duration: 1.2 });
  K("idle", "bone", "rocket", "rotation", [[0, 90], [1.2, 90]]);
  K("idle", "bone", "rocket", "y", [[0, 14], [1.2, 14]]);
  K("idle", "bone", "flame", "scaleX", [[0, 0.25], [0.6, 0.35], [1.2, 0.25]], "easeInOut");
  K("idle", "slot", "button-bg", "color", [[0, "#ffffff"], [0.6, "#bbf7d0"], [1.2, "#ffffff"]], "easeInOut");
  // flyout: lift off and tip over towards the flight path (plays once).
  A("createAnimation", { name: "flyout", duration: 0.9 });
  K("flyout", "bone", "rocket", "rotation", [[0, 90], [0.9, 35]], "easeInOut");
  K("flyout", "bone", "rocket", "y", [[0, 14], [0.9, 0]], "easeOut");
  K("flyout", "bone", "rocket", "scaleX", [[0, 1], [0.3, 1.15], [0.9, 1]], "easeOut");
  K("flyout", "bone", "flame", "scaleX", [[0, 0.3], [0.25, 1.8], [0.9, 1.3]], "easeOut");
  K("flyout", "slot", "button-bg", "color", [[0, "#ffffff"], [0.3, "#ffffff00"]]);
  K("flyout", "slot", "button-label", "color", [[0, "#ffffff"], [0.3, "#ffffff00"]]);
  // flying: loop, wobble and roaring flame.
  A("createAnimation", { name: "flying", duration: 0.6 });
  K("flying", "bone", "rocket", "rotation", [[0, 33], [0.3, 37], [0.6, 33]], "easeInOut");
  K("flying", "bone", "rocket", "y", [[0, 0], [0.3, 4], [0.6, 0]], "easeInOut");
  K("flying", "bone", "flame", "scaleX", [[0, 1.2], [0.15, 1.6], [0.3, 1.1], [0.45, 1.5], [0.6, 1.2]]);
  K("flying", "bone", "flame", "scaleY", [[0, 1], [0.3, 1.2], [0.6, 1]]);
  for (const slot of ["button-bg", "button-label"]) K("flying", "slot", slot, "color", [[0, "#ffffff00"]]);
  // crash: spin out, explode, number turns red (plays once, then back to idle).
  A("createAnimation", { name: "crash", duration: 1.8 });
  K("crash", "bone", "rocket", "rotation", [[0, 35], [0.6, -160]], "easeOut");
  K("crash", "bone", "rocket", "y", [[0, 0], [0.6, -40]], "easeIn");
  K("crash", "bone", "flame", "scaleX", [[0, 1.4], [0.2, 0]]);
  K("crash", "slot", "body", "color", [[0.2, "#ffffffff"], [0.5, "#ffffff00"]]);
  K("crash", "slot", "boom", "color", [[0, "#ffffff00"], [0.05, "#ffffffff"], [1.1, "#ffffffff"], [1.5, "#ffffff00"]]);
  K("crash", "bone", "boom", "scaleX", [[0, 0.2], [0.5, 1.8]], "easeOut");
  K("crash", "bone", "boom", "scaleY", [[0, 0.2], [0.5, 1.8]], "easeOut");
  K("crash", "bone", "boom", "rotation", [[0, 0], [0.9, 40]]);
  K("crash", "slot", "multiplier", "color", [[0, "#ef4444"], [1.8, "#ef4444"]]);
  for (const slot of ["button-bg", "button-label"]) K("crash", "slot", slot, "color", [[0, "#ffffff00"], [1.4, "#ffffff00"], [1.8, "#ffffff"]]);
  // cashout: rocket zooms off, number turns green (plays once, then back to idle).
  A("createAnimation", { name: "cashout", duration: 1.6 });
  K("cashout", "bone", "rocket", "x", [[0, 0], [0.8, 700]], "easeIn");
  K("cashout", "bone", "rocket", "y", [[0, 0], [0.8, 260]], "easeIn");
  K("cashout", "bone", "flame", "scaleX", [[0, 1.3], [0.3, 2.2]]);
  K("cashout", "slot", "multiplier", "color", [[0, "#22c55e"], [1.6, "#22c55e"]]);
  K("cashout", "bone", "hud", "scaleX", [[0, 1], [0.2, 1.2], [0.5, 1]], "easeOut");
  K("cashout", "bone", "hud", "scaleY", [[0, 1], [0.2, 1.2], [0.5, 1]], "easeOut");
  for (const slot of ["button-bg", "button-label"]) K("cashout", "slot", slot, "color", [[0, "#ffffff00"], [1.2, "#ffffff00"], [1.6, "#ffffff"]]);

  A("createStateMachine", { name: "game" });
  for (const name of ["start", "crash", "cashout"]) A("addInput", { stateMachine: "game", name, type: "trigger" });
  A("addInput", { stateMachine: "game", name: "multiplier", type: "number", default: 1 });
  A("addInput", { stateMachine: "game", name: "status", type: "string", default: "Press START" });
  A("addState", { stateMachine: "game", animation: "idle", x: 80, y: 160 });
  A("addState", { stateMachine: "game", animation: "flying", x: 520, y: 160 });
  A("addState", { stateMachine: "game", animation: "flyout", loop: false, onComplete: "flying", x: 300, y: 160 });
  A("addState", { stateMachine: "game", animation: "crash", loop: false, onComplete: "idle", x: 740, y: 60 });
  A("addState", { stateMachine: "game", animation: "cashout", loop: false, onComplete: "idle", x: 740, y: 260 });
  const T = (from: string, to: string, input: string, duration = 0.1) =>
    A("addTransition", { stateMachine: "game", from, to, conditions: [{ input }], duration });
  T("idle", "flyout", "start");
  for (const from of ["flyout", "flying"]) {
    T(from, "crash", "crash", 0.05);
    T(from, "cashout", "cashout");
  }
  // Live data: 1x → 10x carries the rocket up and right, and the sky warms up.
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "climb", property: "x", inMin: 1, inMax: 10, outMin: 0, outMax: 520 });
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "climb", property: "y", inMin: 1, inMax: 10, outMin: 0, outMax: 300 });
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "sky", property: "color", inMin: 1, inMax: 10, outMin: "#c9d2ff", outMax: "#ffd9ef" });
  // Parallax: as the multiplier climbs, the ground drops away fast, the clouds drift down and left, the sky barely moves.
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "ground-layer", property: "y", inMin: 1, inMax: 3, outMin: 0, outMax: -260 });
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "cloud-layer", property: "x", inMin: 1, inMax: 10, outMin: 420, outMax: -180 });
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "cloud-layer", property: "y", inMin: 1, inMax: 10, outMin: 190, outMax: 20 });
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "sky-layer", property: "y", inMin: 1, inMax: 10, outMin: 170, outMax: 130 });
  sfx(A, "click", "button-click", { bus: "ui", volume: 0.8 });
  sfx(A, "liftoff", "crash-liftoff", { volume: 0.7 });
  sfx(A, "engine", "rocket-engine-loop", { loop: true, volume: 0.22, fadeIn: 0.3, fadeOut: 0.15 });
  sfx(A, "explosion", "crash-explosion", { volume: 0.75 });
  sfx(A, "cashout", "crash-cashout", { volume: 0.8 });
  A("setStateSound", { stateMachine: "game", state: "flyout", sound: "liftoff" });
  A("setStateSound", { stateMachine: "game", state: "flying", sound: "engine" });
  A("setStateSound", { stateMachine: "game", state: "crash", sound: "explosion" });
  A("setStateSound", { stateMachine: "game", state: "cashout", sound: "cashout" });
  A("addListener", { stateMachine: "game", name: "start button", slot: "button-label", event: "click", actions: [{ type: "fireTrigger", input: "start" }, { type: "playSound", sound: "click" }] });
  // Back to idle after a crash or cash-out: reset the round so the rocket returns to the pad and the HUD to 1.00x.
  A("setStateInput", { stateMachine: "game", state: "idle", input: "multiplier", value: 1 });
  A("setStateInput", { stateMachine: "game", state: "idle", input: "status", value: "Press START" });
  return s.doc;
}

/** Spiky star polygon: `n` points between radius r0 and r1. */
function star(n: number, r1: number, r0: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 ? r0 : r1;
    out.push(Math.round(Math.cos(a) * r * 10) / 10, Math.round(Math.sin(a) * r * 10) / 10);
  }
  return out;
}

/** Mono samples of a 16-bit PCM WAV file. */
function readWav(file: string): { samples: Float32Array; rate: number } {
  const b = readFileSync(file);
  let p = 12;
  let rate = 22050;
  let channels = 1;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
    } else if (id === "data") {
      const n = Math.floor(size / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += b.readInt16LE(p + 8 + (i * channels + c) * 2);
        samples[i] = v / channels / 32768;
      }
      return { samples, rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no PCM data`);
}

/** Robot: lip sync example. Its voice is formant-synthesised; the mouth keys come from the same lipSync analysis as the editor's Lip sync dialog. */
function robot() {
  const s = new DocumentStore(createDocument("Robot"));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 500, height: 560, originX: 250, originY: 520 });
  // Painted torso and head (see assets/eleven/LICENSE.md), both drawn at 0.7 of the art's size. The head's screen is
  // blank in the art: the eyes, mouth shapes and the chest light's glow are vector shapes drawn on top.
  const S = 0.7;
  A("addImage", { name: "robot-torso", src: "assets/eleven/robot-torso.png", width: 440, height: 269 });
  A("addImage", { name: "robot-head", src: "assets/eleven/robot-head.png", width: 420, height: 233 });
  A("addBone", { name: "body", y: 40, length: 0 });
  // The neck points up out of the torso's neck stub; the head turns back upright so its parts use x right, y up.
  A("addBone", { name: "neck", parent: "body", y: 178, rotation: 90, length: 20 });
  A("addBone", { name: "head", parent: "neck", x: 12, rotation: -90, length: 0 });
  A("addBone", { name: "antenna", parent: "head", y: 146, rotation: 90, length: 50 });
  A("addBone", { name: "mouth", parent: "head", y: 54, length: 0 });
  const shape = (slot: string, bone: string, args: Record<string, unknown>) => {
    A("addSlot", { bone, name: slot });
    A("addShape", { slot, ...args });
  };
  // Antenna behind the head, so its base tucks under the head's top edge.
  shape("antenna-stick", "antenna", { shape: "rect", x: 22, y: 0, width: 50, height: 7, radius: 3, fill: "#5c6f8f", stroke: "#1e2638", strokeWidth: 2 });
  shape("antenna-ball", "antenna", { shape: "ellipse", x: 50, y: 0, width: 22, height: 22, fill: "#ff5d5d", stroke: "#1e2638", strokeWidth: 2 });
  A("addSlot", { bone: "body", name: "torso" });
  A("addRegion", { slot: "torso", image: "robot-torso", y: 94, width: 440 * S, height: 269 * S });
  // Chest light: an additive glow over the painted green lamp, pulsed by the animations.
  A("addSlot", { bone: "body", name: "light", blend: "additive" });
  A("addShape", { slot: "light", shape: "ellipse", x: -43, y: 110, width: 22, height: 22, fill: "#5dff9e99" });
  A("addSlot", { bone: "head", name: "head" });
  A("addRegion", { slot: "head", image: "robot-head", y: 74, width: 420 * S, height: 233 * S });
  for (const [name, x] of [["eye-l", -46], ["eye-r", 46]] as const) shape(name, "head", { shape: "ellipse", x, y: 94, width: 34, height: 34, fill: "#8ad4ff" });
  // Mouth shapes, one attachment each (named so the editor's Lip sync dialog guesses them).
  A("addSlot", { bone: "mouth", name: "mouth" });
  const mouth = (name: string, args: Record<string, unknown>) => A("addShape", { slot: "mouth", name, activate: name === "mouth-rest", fill: "#8ad4ff", ...args });
  mouth("mouth-rest", { shape: "rect", width: 64, height: 6, radius: 3 });
  mouth("mouth-closed", { shape: "rect", width: 52, height: 10, radius: 5 });
  mouth("mouth-small", { shape: "ellipse", width: 38, height: 15 });
  mouth("mouth-open", { shape: "ellipse", width: 54, height: 28 });
  mouth("mouth-wide", { shape: "rect", width: 80, height: 34, radius: 16 });
  mouth("mouth-round", { shape: "ellipse", width: 28, height: 28 });
  A("addBoundingBox", { slot: "head", name: "head-hit", y: 74, width: 420 * S, height: 233 * S });

  const voice = readWav(path.join(here, "assets/eleven/robot-voice.wav"));
  const length = voice.samples.length / voice.rate;
  A("addAudio", { name: "robot-voice", src: "assets/eleven/robot-voice.wav", duration: Math.round(length * 1000) / 1000, bus: "sfx" });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | string][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  // idle: antenna sways, eyes blink, status light pulses.
  A("createAnimation", { name: "idle", duration: 3 });
  K("idle", "bone", "antenna", "rotation", [[0, 90], [1.5, 84], [3, 90]]);
  K("idle", "bone", "head", "rotation", [[0, -90], [1.5, -91.5], [3, -90]]);
  for (const eye of ["eye-l", "eye-r"]) K("idle", "slot", eye, "color", [[0, "#ffffff"], [2.6, "#ffffff"], [2.7, "#ffffff22"], [2.8, "#ffffff"]], "linear");
  K("idle", "slot", "light", "color", [[0, "#ffffff"], [1.5, "#ffffff55"], [3, "#ffffff"]]);
  // talk: the voice, lip-synced mouth, a little head and antenna motion.
  A("createAnimation", { name: "talk", duration: Math.round(length * 30) / 30 });
  const keys = lipSync(voice.samples, voice.rate, { fps: 30 });
  A("setKeys", { animation: "talk", target: "slot", id: "mouth", property: "attachment", keys: keys.map((k) => ({ time: k.time, value: `mouth-${k.shape}`, curve: "stepped" })) });
  A("addAudioKey", { animation: "talk", sound: "robot-voice", time: 0 });
  K("talk", "bone", "head", "rotation", [[0, -90], [0.8, -87], [1.6, -92], [2.4, -88], [length, -90]]);
  K("talk", "bone", "antenna", "rotation", [[0, 90], [0.4, 100], [0.9, 82], [1.5, 96], [2.2, 84], [length, 90]]);
  K("talk", "slot", "light", "color", [[0, "#ffffff"], [0.2, "#ffd166"], [length - 0.2, "#ffd166"], [length, "#ffffff"]]);

  A("createStateMachine", { name: "robot" });
  A("addInput", { stateMachine: "robot", name: "talk", type: "trigger" });
  A("addState", { stateMachine: "robot", animation: "idle", x: 120, y: 120 });
  A("addState", { stateMachine: "robot", animation: "talk", loop: false, onComplete: "idle", x: 380, y: 120 });
  A("addTransition", { stateMachine: "robot", from: "idle", to: "talk", conditions: [{ input: "talk" }], duration: 0.15 });
  A("addListener", { stateMachine: "robot", slot: "head", event: "click", actions: [{ type: "fireTrigger", input: "talk" }] });
  return s.doc;
}

/** Fox: lip sync with a real voice. Art and voice generated with ElevenLabs (see assets/eleven/LICENSE.md); mouth keys from lipSync. */
function fox() {
  const s = new DocumentStore(createDocument("Fox"));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 560, height: 620, originX: 280, originY: 600 });
  const S = 0.9;
  A("addImage", { name: "fox-head", src: "assets/eleven/fox-head.png", width: 497, height: 532 });
  for (const n of ["rest", "closed", "small", "open", "wide", "round"]) A("addImage", { name: `fox-mouth-${n}`, src: `assets/eleven/fox-mouth-${n}.png`, width: 185, height: 98 });
  // The bone sits at the neck so tilts pivot there; the image centre is 240 px above it.
  A("addBone", { name: "fox", y: 30, length: 0 });
  A("addBone", { name: "head", parent: "fox", y: 0, rotation: 90, length: 300 });
  A("addBone", { name: "face", parent: "head", x: 240, rotation: -90, length: 0 });
  A("addSlot", { bone: "face", name: "head" });
  A("addRegion", { slot: "head", image: "fox-head", width: 497 * S, height: 532 * S });
  A("addBoundingBox", { slot: "head", name: "head-hit", width: 420 * S, height: 520 * S });
  // Mouth on the muzzle: 106 px below the image centre in the art.
  A("addBone", { name: "mouth", parent: "face", x: 0.5 * S, y: -106 * S, length: 0 });
  A("addSlot", { bone: "mouth", name: "mouth" });
  for (const n of ["rest", "closed", "small", "open", "wide", "round"])
    A("addRegion", { slot: "mouth", name: `mouth-${n}`, image: `fox-mouth-${n}`, width: 185 * 0.92 * S, height: 98 * 0.92 * S, activate: n === "rest" });

  const voice = readWav(path.join(here, "assets/eleven/fox-voice.wav"));
  const length = voice.samples.length / voice.rate;
  A("addAudio", { name: "pip-voice", src: "assets/eleven/fox-voice.wav", duration: Math.round(length * 1000) / 1000, bus: "sfx" });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  A("createAnimation", { name: "idle", duration: 3 });
  K("idle", "bone", "head", "rotation", [[0, 90], [1.5, 91.5], [3, 90]]);
  K("idle", "bone", "fox", "y", [[0, 30], [1.5, 26], [3, 30]]);
  // talk: the voice, lip-synced mouth, and a livelier head.
  const len = Math.round(length * 30) / 30;
  A("createAnimation", { name: "talk", duration: len });
  const keys = lipSync(voice.samples, voice.rate, { fps: 30 });
  A("setKeys", { animation: "talk", target: "slot", id: "mouth", property: "attachment", keys: keys.map((k) => ({ time: k.time, value: `mouth-${k.shape}`, curve: "stepped" })) });
  A("addAudioKey", { animation: "talk", sound: "pip-voice", time: 0 });
  const sway: [number, number][] = [];
  for (let t = 0, i = 0; t <= len + 1e-6; t += 0.7, i++) sway.push([Math.min(t, len), 90 + (i === 0 || t >= len ? 0 : i % 2 ? 4 : -3)]);
  K("talk", "bone", "head", "rotation", sway);
  const bob: [number, number][] = [];
  for (let t = 0, i = 0; t <= len + 1e-6; t += 0.35, i++) bob.push([Math.min(t, len), i % 2 ? 36 : 30]);
  K("talk", "bone", "fox", "y", bob);

  A("createStateMachine", { name: "fox" });
  A("addInput", { stateMachine: "fox", name: "talk", type: "trigger" });
  A("addState", { stateMachine: "fox", animation: "idle", x: 120, y: 120 });
  A("addState", { stateMachine: "fox", animation: "talk", loop: false, onComplete: "idle", x: 380, y: 120 });
  A("addTransition", { stateMachine: "fox", from: "idle", to: "talk", conditions: [{ input: "talk" }], duration: 0.15 });
  A("addListener", { stateMachine: "fox", slot: "head", event: "click", actions: [{ type: "fireTrigger", input: "talk" }] });
  return s.doc;
}

// Build only when run as a script (tests import the example builders).
const runAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (runAsScript) {
  for (let i = 0; i < FLAME_FRAMES; i++) writeFileSync(path.join(here, `assets/${frameName("flame", i)}.png`), makeFlame(i));
  for (let i = 0; i < SMOKE_FRAMES; i++) writeFileSync(path.join(here, `assets/${frameName("smoke", i)}.png`), makeSmoke(i));
}
if (runAsScript)
for (const [file, doc] of [["walker.obone", walker()], ["button.obone", button()], ["tail.obone", tail()], ["campfire.obone", campfire()], ["rocket.obone", rocket()], ["crash.obone", crash()], ["knight.obone", knight()], ["robot.obone", robot()], ["fox.obone", fox()]] as const) {
  const issues = validate(doc);
  if (issues.some((i) => i.level === "error")) throw new Error(`${file}: ${JSON.stringify(issues)}`);
  writeFileSync(path.join(here, file), serialize(doc));
  console.log(`wrote examples/${file}${issues.length ? ` (${issues.length} warnings)` : ""}`);
}
