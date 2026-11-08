/**
 * Builds the example projects in this folder using the same ops the editor and MCP server use.
 * Run: pnpm tsx examples/build-examples.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { DocumentStore, createDocument, lipSync, serialize, validate } from "@openbone/core";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- assets ----------
function makeCape() {
  const c = createCanvas(120, 60);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 120, 0);
  grad.addColorStop(0, "#b91c1c");
  grad.addColorStop(1, "#7f1d1d");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, 8);
  g.lineTo(120, 0);
  g.lineTo(120, 60);
  g.lineTo(0, 52);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.15)";
  for (let x = 10; x < 120; x += 20) g.fillRect(x, 0, 6, 60);
  return c.toBuffer("image/png");
}
writeFileSync(path.join(here, "assets/cape.png"), makeCape());

// ---------- walker ----------
function walker() {
  const s = new DocumentStore(createDocument("Walker"));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 800, height: 600, originX: 400, originY: 500 });
  A("addBone", { name: "hip", y: 165, length: 20, color: "#ff9f43" });
  A("addBone", { name: "torso", parent: "hip", rotation: 90, length: 110 });
  A("addBone", { name: "head", parent: "torso", x: 118, length: 60 });
  A("addBone", { name: "pupils", parent: "head", x: 32, length: 0 });
  for (const side of ["back", "front"] as const) {
    const dx = side === "front" ? 6 : -6;
    A("addBone", { name: `${side}-arm`, parent: "torso", x: 100, rotation: 180, length: 60 });
    A("addBone", { name: `${side}-forearm`, parent: `${side}-arm`, x: 60, rotation: -15, length: 55 });
    A("addBone", { name: `${side}-thigh`, parent: "hip", x: 0, y: dx, rotation: -90, length: 82 });
    A("addBone", { name: `${side}-shin`, parent: `${side}-thigh`, x: 82, length: 80 });
    A("addBone", { name: `${side}-foot-target`, x: side === "front" ? 10 : -10, y: 4, length: 0 });
  }
  A("addBone", { name: "cape1", parent: "torso", x: 105, y: -8, rotation: 175, length: 40 });
  A("addBone", { name: "cape2", parent: "cape1", x: 40, length: 40 });
  A("addBone", { name: "cape3", parent: "cape2", x: 40, length: 40 });

  // Visuals (back to front).
  const limb = (slot: string, bone: string, len: number, w: number, fill: string) => {
    A("addSlot", { bone, name: slot });
    A("addShape", { slot, shape: "rect", x: len / 2, width: len + w * 0.6, height: w, radius: w / 2, fill });
  };
  A("addImage", { name: "cape", src: "assets/cape.png", width: 120, height: 60 });
  A("addSlot", { bone: "cape1", name: "cape" });
  A("addMesh", { slot: "cape", image: "cape", x: 60, cols: 6, rows: 2 });
  A("autoWeights", { slot: "cape", attachment: "cape", bones: ["cape1", "cape2", "cape3"], maxInfluences: 2 });
  limb("back-arm", "back-arm", 60, 18, "#3b5b8f");
  limb("back-forearm", "back-forearm", 55, 16, "#e0a77b");
  limb("back-thigh", "back-thigh", 82, 24, "#2c3e66");
  limb("back-shin", "back-shin", 80, 20, "#2c3e66");
  A("addSlot", { bone: "back-shin", name: "back-shoe" });
  A("addShape", { slot: "back-shoe", shape: "rect", x: 82, y: 10, width: 18, height: 34, radius: 6, fill: "#1f2937" });
  A("addSlot", { bone: "torso", name: "body" });
  A("addShape", { slot: "body", shape: "rect", x: 55, width: 125, height: 70, radius: 26, fill: "#4a78c2" });
  A("addBoundingBox", { slot: "body", name: "body-hit", x: 60, width: 150, height: 90 });
  limb("front-thigh", "front-thigh", 82, 24, "#34497a");
  limb("front-shin", "front-shin", 80, 20, "#34497a");
  A("addSlot", { bone: "front-shin", name: "front-shoe" });
  A("addShape", { slot: "front-shoe", shape: "rect", x: 82, y: 10, width: 18, height: 34, radius: 6, fill: "#111827" });
  A("addSlot", { bone: "head", name: "face" });
  A("addShape", { slot: "face", shape: "ellipse", x: 28, width: 66, height: 62, fill: "#f2c49b", stroke: "#c9956b", strokeWidth: 2 });
  for (const [n, y] of [["eye-l", 12], ["eye-r", -12]] as const) {
    A("addSlot", { bone: "head", name: n });
    A("addShape", { slot: n, shape: "ellipse", x: 32, y, width: 16, height: 13, fill: "#ffffff" });
    A("addSlot", { bone: "pupils", name: `${n}-pupil` });
    A("addShape", { slot: `${n}-pupil`, shape: "ellipse", x: 0, y, width: 7, height: 7, fill: "#1f2937" });
  }
  A("addSlot", { bone: "head", name: "hair" });
  A("addShape", { slot: "hair", shape: "polygon", points: [40, 34, 62, 20, 66, -10, 56, -32, 44, -30, 50, -6, 44, 20], fill: "#5b3a29" });
  limb("front-arm", "front-arm", 60, 18, "#5b8bd6");
  limb("front-forearm", "front-forearm", 55, 16, "#f2c49b");

  A("addIkConstraint", { name: "back-leg", bones: ["back-thigh", "back-shin"], target: "back-foot-target", bendPositive: false });
  A("addIkConstraint", { name: "front-leg", bones: ["front-thigh", "front-shin"], target: "front-foot-target", bendPositive: false });

  // ---- idle ----
  A("createAnimation", { name: "idle", duration: 2 });
  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | string][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  K("idle", "bone", "hip", "y", [[0, 165], [1, 160], [2, 165]]);
  K("idle", "bone", "torso", "rotation", [[0, 90], [1, 92], [2, 90]]);
  K("idle", "bone", "head", "rotation", [[0, 0], [1, -3], [2, 0]]);
  K("idle", "bone", "front-arm", "rotation", [[0, 182], [1, 186], [2, 182]]);
  K("idle", "bone", "back-arm", "rotation", [[0, 178], [1, 174], [2, 178]]);
  K("idle", "bone", "cape1", "rotation", [[0, 175], [1, 172], [2, 175]]);
  K("idle", "bone", "cape2", "rotation", [[0, 0], [1, -4], [2, 0]]);
  // blink
  A("setKeys", { animation: "idle", target: "slot", id: "eye-l", property: "color", keys: [{ time: 0, value: "#ffffff", curve: "stepped" }, { time: 1.6, value: "#f2c49b", curve: "stepped" }, { time: 1.7, value: "#ffffff", curve: "stepped" }] });
  A("setKeys", { animation: "idle", target: "slot", id: "eye-r", property: "color", keys: [{ time: 0, value: "#ffffff", curve: "stepped" }, { time: 1.6, value: "#f2c49b", curve: "stepped" }, { time: 1.7, value: "#ffffff", curve: "stepped" }] });

  // ---- walk (1s cycle) ----
  A("createAnimation", { name: "walk", duration: 1 });
  const L = "linear";
  K("walk", "bone", "hip", "y", [[0, 160], [0.25, 166], [0.5, 160], [0.75, 166], [1, 160]]);
  K("walk", "bone", "torso", "rotation", [[0, 86], [1, 86]]);
  for (const [side, phase] of [["front", 0], ["back", 0.5]] as const) {
    // stance: foot slides back on the ground; swing: lifts and moves forward
    const key = (t: number) => (t + phase) % 1;
    const xs: [number, number][] = [[key(0), 45], [key(0.5), -45], [key(0.75), 0], [key(1 - 1e-3), 45]];
    const ys: [number, number][] = [[key(0), 4], [key(0.5), 4], [key(0.7), 34], [key(1 - 1e-3), 4]];
    const sort = (k: [number, number][]) => {
      const s2 = k.sort((a, b) => a[0] - b[0]);
      // close the loop: value at t=1 equals value at t=0
      const first = s2[0];
      if (first[0] > 0) {
        const last = s2[s2.length - 1];
        s2.unshift([0, last[1] + ((first[1] - last[1]) * (1 - last[0])) / (1 - last[0] + first[0])]);
      }
      s2.push([1, s2[0][1]]);
      return s2;
    };
    K("walk", "bone", `${side}-foot-target`, "x", sort(xs), L);
    K("walk", "bone", `${side}-foot-target`, "y", sort(ys), L);
    const armPhase = side === "front" ? 1 : -1;
    K("walk", "bone", `${side}-arm`, "rotation", [[0, 180 - 25 * armPhase], [0.5, 180 + 25 * armPhase], [1, 180 - 25 * armPhase]]);
  }
  K("walk", "bone", "cape1", "rotation", [[0, 160], [0.5, 150], [1, 160]]);
  K("walk", "bone", "cape2", "rotation", [[0, -10], [0.5, 5], [1, -10]]);
  K("walk", "bone", "cape3", "rotation", [[0, 10], [0.5, -10], [1, 10]]);
  A("addEventKey", { animation: "walk", event: "footstep", time: 0, string: "front" });
  A("addEventKey", { animation: "walk", event: "footstep", time: 0.5, string: "back" });

  // ---- jump ----
  A("createAnimation", { name: "jump", duration: 0.8 });
  K("jump", "bone", "hip", "y", [[0, 160], [0.12, 140], [0.4, 240], [0.7, 160], [0.8, 165]]);
  K("jump", "bone", "front-arm", "rotation", [[0, 180], [0.4, 30], [0.8, 180]]);
  K("jump", "bone", "back-arm", "rotation", [[0, 180], [0.4, -30], [0.8, 180]]);
  K("jump", "bone", "cape1", "rotation", [[0, 175], [0.4, 200], [0.8, 175]]);
  A("addEventKey", { animation: "jump", event: "land", time: 0.7 });

  // ---- state machine ----
  A("createStateMachine", { name: "character" });
  A("addInput", { stateMachine: "character", name: "speed", type: "number", default: 0 });
  A("addInput", { stateMachine: "character", name: "jump", type: "trigger" });
  A("addState", { stateMachine: "character", name: "locomotion", type: "blend1d", blendInput: "speed", blend: [{ animation: "idle", value: 0 }, { animation: "walk", value: 1 }], x: 160, y: 120 });
  A("addState", { stateMachine: "character", animation: "jump", loop: false, x: 420, y: 120 });
  A("addTransition", { stateMachine: "character", from: "@any", to: "jump", conditions: [{ input: "jump" }], duration: 0.1 });
  A("addTransition", { stateMachine: "character", from: "jump", to: "locomotion", duration: 0.2 });
  A("addListener", { stateMachine: "character", slot: "body", event: "click", actions: [{ type: "fireTrigger", input: "jump" }] });
  A("addScript", {
    name: "eyes-follow-pointer",
    code: `// Pupils look toward the pointer.
function onUpdate(dt) {
  const p = ob.pointer();
  const h = ob.bone("head");
  if (!h) return;
  const dx = p.x - h.worldX, dy = p.y - h.worldY;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(4, len / 25);
  // head's local frame is rotated +90° from world
  ob.setBone("pupils", { x: 32 + (dy / len) * k, y: -(dx / len) * k });
}
function onEvent(e) { if (e.name === "land") ob.log("landed!"); }`,
  });
  A("attachScript", { stateMachine: "character", script: "eyes-follow-pointer" });
  return s.doc;
}

// ---------- sounds (synthesized, so the examples carry no third-party audio) ----------
/** 8-bit mono WAV as a data: URI. */
function wav(samples: Float32Array, rate: number): string {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = Math.round(128 + 127 * Math.max(-1, Math.min(1, samples[i])));
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

/** A short UI click: a pitched-down blip with a fast decay. */
function clickSound() {
  const rate = 22050;
  const out = new Float32Array(Math.round(rate * 0.06));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    phase += (2 * Math.PI * (1400 - 9000 * t)) / rate;
    out[i] = Math.sin(phase) * Math.exp(-t * 70) * 0.8;
  }
  return { src: wav(out, rate), duration: out.length / rate };
}

/** A soft hover hum that loops seamlessly (whole cycles of every partial in 0.5 s). */
function humSound() {
  const rate = 11025;
  const out = new Float32Array(Math.round(rate * 0.5));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 330 * t) + 0.08 * Math.sin(2 * Math.PI * 4 * t) * Math.sin(2 * Math.PI * 440 * t);
  }
  return { src: wav(out, rate), duration: out.length / rate };
}

/** Button audio: a click on the press event, and a hum that loops while hovered (stops on exit). */
export function addButtonAudio(A: (op: string, args: Record<string, unknown>) => unknown) {
  A("addAudio", { name: "click", ...clickSound(), bus: "ui" });
  A("addAudio", { name: "hover-hum", ...humSound(), bus: "ui", loop: true });
  A("updateSound", { sound: "hover-hum", volume: 0.35, fadeIn: 0.15, fadeOut: 0.25 });
  A("setEventSound", { event: "clicked", sound: "click" });
  A("setStateSound", { stateMachine: "ui", state: "hover", sound: "hover-hum" });
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
  const s = new DocumentStore(createDocument("Tail", { background: "#f3efe6" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 800, height: 500, originX: 470, originY: 380 });
  A("addBone", { name: "body", y: 120, length: 0, color: "#ff9f43" });
  A("addBone", { name: "head", parent: "body", x: 95, y: 30, length: 0 });
  // Tail chain: 8 bones placed along the path by the path constraint.
  const SEG = 32;
  A("addBone", { name: "tail1", parent: "body", x: -70, y: 10, rotation: 165, length: SEG });
  for (let i = 2; i <= 8; i++) A("addBone", { name: `tail${i}`, parent: `tail${i - 1}`, x: SEG, length: SEG });
  // The path lives on `tail-base`; its knots are bound to control bones that the animations move.
  A("addBone", { name: "tail-base", parent: "body", x: -70, y: 10, rotation: 165, length: 0, color: "#ff7a00" });
  for (let i = 1; i <= 3; i++) A("addBone", { name: `ctrl${i}`, parent: "tail-base", x: i * 90, length: 0, color: "#ff7a00" });
  // Antennae: two-bone chains with spring physics.
  for (const [side, y, rot] of [["l", 14, 70], ["r", -6, 55]] as const) {
    A("addBone", { name: `antenna-${side}1`, parent: "head", x: 10, y, rotation: rot, length: 34 });
    A("addBone", { name: `antenna-${side}2`, parent: `antenna-${side}1`, x: 34, rotation: -25, length: 30 });
  }

  // Visuals (back to front).
  A("addSlot", { bone: "tail-base", name: "tail-path" });
  A("addPath", { slot: "tail-path", anchors: [0, 0, 90, 0, 180, 0, 270, 0], color: "#ff7a00" });
  for (let k = 1; k <= 3; k++)
    for (let v = k * 3; v < k * 3 + 3; v++)
      A("setWeights", { slot: "tail-path", attachment: "path", vertex: v, influences: [{ bone: `ctrl${k}`, weight: 1 }] });
  for (let i = 8; i >= 1; i--) {
    const w = 34 - i * 3;
    A("addSlot", { bone: `tail${i}`, name: `tail${i}` });
    A("addShape", { slot: `tail${i}`, shape: "rect", x: SEG / 2, width: SEG + w * 0.7, height: w, radius: w / 2, fill: i % 2 ? "#7c5cbf" : "#6a4dad" });
  }
  A("addSlot", { bone: "tail8", name: "tuft" });
  A("addShape", { slot: "tuft", shape: "ellipse", x: SEG + 6, width: 34, height: 22, fill: "#f7c948" });
  for (const side of ["r", "l"]) {
    for (const n of [1, 2]) {
      A("addSlot", { bone: `antenna-${side}${n}`, name: `antenna-${side}${n}` });
      A("addShape", { slot: `antenna-${side}${n}`, shape: "rect", x: 16, width: 36, height: 6, radius: 3, fill: "#4b3a7a" });
    }
    A("addSlot", { bone: `antenna-${side}2`, name: `antenna-${side}-tip` });
    A("addShape", { slot: `antenna-${side}-tip`, shape: "ellipse", x: 31, width: 13, height: 13, fill: "#f7c948" });
  }
  A("addSlot", { bone: "body", name: "body" });
  A("addShape", { slot: "body", shape: "ellipse", width: 190, height: 120, fill: "#8b6fd1", stroke: "#5b45a0", strokeWidth: 3 });
  A("addSlot", { bone: "body", name: "belly" });
  A("addShape", { slot: "belly", shape: "ellipse", y: -22, width: 120, height: 54, fill: "#c9b8f0" });
  A("addSlot", { bone: "head", name: "head" });
  A("addShape", { slot: "head", shape: "ellipse", width: 96, height: 86, fill: "#8b6fd1", stroke: "#5b45a0", strokeWidth: 3 });
  A("addSlot", { bone: "head", name: "eye" });
  A("addShape", { slot: "eye", shape: "ellipse", x: 18, y: 8, width: 24, height: 26, fill: "#ffffff" });
  A("addSlot", { bone: "head", name: "pupil" });
  A("addShape", { slot: "pupil", shape: "ellipse", x: 23, y: 6, width: 11, height: 13, fill: "#1f1640" });
  A("addSlot", { bone: "head", name: "smile" });
  A("addShape", { slot: "smile", shape: "polygon", points: [8, -18, 40, -12, 36, -20, 12, -24], fill: "#5b45a0" });

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
  K("wag", "bone", "body", "y", [[0, 120], [0.4, 128], [0.8, 120], [1.2, 128], [1.6, 120]]);
  K("wag", "bone", "head", "rotation", [[0, 0], [0.8, -6], [1.6, 0]]);
  // ---- curl: control points sweep up over the back; spacing tightens (keyed path field) ----
  A("createAnimation", { name: "curl", duration: 2 });
  K("curl", "bone", "ctrl1", "x", [[0, 90], [1, 80], [2, 90]]);
  K("curl", "bone", "ctrl1", "y", [[0, 0], [1, -40], [2, 0]]);
  K("curl", "bone", "ctrl2", "x", [[0, 180], [1, 120], [2, 180]]);
  K("curl", "bone", "ctrl2", "y", [[0, 0], [1, -130], [2, 0]]);
  K("curl", "bone", "ctrl3", "x", [[0, 270], [1, 50], [2, 270]]);
  K("curl", "bone", "ctrl3", "y", [[0, 0], [1, -170], [2, 0]]);
  K("curl", "path", "tail-path", "spacing", [[0, 0], [1, -6], [2, 0]]);
  K("curl", "bone", "body", "y", [[0, 120], [0.5, 150], [1, 120], [2, 120]]);
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
  A("addBone", { name: "fire", y: 10, length: 0 });
  A("addBone", { name: "smoke", parent: "fire", y: 150, length: 0 });
  // Glow behind everything, then logs, then the flame on top.
  A("addSlot", { bone: "root", name: "glow" });
  A("addShape", { slot: "glow", shape: "ellipse", y: 40, width: 260, height: 170, fill: "#ff8a0033" });
  for (const [name, rot] of [["log1", 18], ["log2", -18]] as const) {
    A("addSlot", { bone: "root", name });
    A("addShape", { slot: name, shape: "rect", y: 4, rotation: rot, width: 150, height: 22, radius: 11, fill: "#6b4226", stroke: "#3e2615", strokeWidth: 2 });
  }
  A("addSlot", { bone: "smoke", name: "smoke" });
  A("addSequence", { slot: "smoke", name: "smoke", frames: frames("smoke", SMOKE_FRAMES, 48, 48), fps: 8, mode: "pingPong", scaleX: 2, scaleY: 2 });
  const flame = frames("flame", FLAME_FRAMES, 64, 96);
  A("addSlot", { bone: "fire", name: "flame", blend: "additive" });
  A("addSequence", { slot: "flame", name: "flame", frames: flame, y: 70, width: 96, height: 144, fps: 15, mode: "loop" });
  // A second, smaller flame starts half a loop later so the two never match.
  A("addSlot", { bone: "fire", name: "flame-small", blend: "additive" });
  A("addSequence", { slot: "flame-small", name: "flame", frames: flame, x: 34, y: 40, width: 56, height: 84, fps: 15, offset: 6 });
  // Breathing: the fire bone scales a little; the glow pulses.
  A("createAnimation", { name: "burn", duration: 1.6 });
  A("setKeys", { animation: "burn", target: "bone", id: "fire", property: "scaleY", keys: [{ time: 0, value: 1, curve: "easeInOut" }, { time: 0.8, value: 1.08, curve: "easeInOut" }, { time: 1.6, value: 1 }] });
  A("setKeys", { animation: "burn", target: "slot", id: "glow", property: "color", keys: [{ time: 0, value: "#ffffff" }, { time: 0.8, value: "#ffffffaa" }, { time: 1.6, value: "#ffffff" }] });
  return s.doc;
}

// ---------- rocket (particles) ----------
function rocket() {
  const s = new DocumentStore(createDocument("Rocket", { background: "#101828" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 600, height: 700, originX: 300, originY: 620 });
  A("addBone", { name: "rocket", y: 40, length: 0, color: "#ff9f43" });
  A("addBone", { name: "nozzle", parent: "rocket", y: 6, length: 0 });
  A("addBone", { name: "pad", length: 0 });
  // Back to front: ground, smoke, exhaust, sparks, then the rocket over its own flame.
  A("addSlot", { bone: "pad", name: "ground" });
  A("addShape", { slot: "ground", shape: "rect", y: -40, width: 600, height: 80, fill: "#1f2937" });
  A("addSlot", { bone: "pad", name: "smoke" });
  A("addParticles", { slot: "smoke", name: "smoke", preset: "smoke", emitting: false, prewarm: false, shape: "box", width: 180, height: 6, rate: 30, angle: 60, speed: [40, 90], seed: 3 });
  A("addSlot", { bone: "nozzle", name: "exhaust" });
  A("addParticles", { slot: "exhaust", name: "exhaust", preset: "exhaust", emitting: false, seed: 11 });
  A("addSlot", { bone: "nozzle", name: "sparks" });
  A("addParticles", { slot: "sparks", name: "sparks", preset: "sparks", emitting: false, rotation: -90, angle: 120, loop: true, duration: 0.35, bursts: [{ time: 0, count: 14 }], gravity: 300, seed: 5 });
  // Painted rocket (see assets/canva/LICENSE.md): nozzle at the bone, nose up.
  A("addImage", { name: "rocket", src: "assets/canva/rocket.png", width: 204, height: 352 });
  A("addSlot", { bone: "rocket", name: "body" });
  A("addRegion", { slot: "body", image: "rocket", y: 112, width: 132, height: 228 });
  A("addSlot", { bone: "rocket", name: "hit" });
  A("addBoundingBox", { slot: "hit", y: 100, width: 120, height: 230 });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | boolean][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve: typeof value === "boolean" ? "stepped" : curve })) });
  // ---- launch: sits, ignites (sparks + smoke), then climbs out of frame with a world-space exhaust trail ----
  A("createAnimation", { name: "launch", duration: 3 });
  K("launch", "particles", "exhaust", "emitting", [[0, false], [0.5, true]]);
  K("launch", "particles", "exhaust", "rate", [[0.5, 40], [1.2, 110]]);
  K("launch", "particles", "sparks", "emitting", [[0, false], [0.45, true], [1.4, false]]);
  K("launch", "particles", "smoke", "emitting", [[0, false], [0.5, true], [1.8, false]]);
  K("launch", "bone", "rocket", "y", [[0, 40], [0.5, 40], [3, 760]], "easeIn");
  K("launch", "bone", "rocket", "x", [[0, 0], [0.6, 0], [3, 60]], "easeIn");
  K("launch", "bone", "rocket", "rotation", [[0, 0], [0.5, 0], [0.55, 2], [0.6, -2], [0.65, 0], [3, -8]], "linear");
  // ---- hover: engine on, gentle bob and sway (loops) ----
  A("createAnimation", { name: "hover", duration: 2 });
  K("hover", "bone", "rocket", "y", [[0, 220], [1, 250], [2, 220]]);
  K("hover", "bone", "rocket", "rotation", [[0, -4], [1, 4], [2, -4]]);
  K("hover", "particles", "exhaust", "rate", [[0, 70], [1, 100], [2, 70]]);
  A("createAnimation", { name: "parked", duration: 1 });
  K("parked", "bone", "rocket", "y", [[0, 40]]);
  // ---- state machine: click the rocket to toggle the engine; each click also throws sparks ----
  A("createStateMachine", { name: "engine" });
  A("addInput", { stateMachine: "engine", name: "thrust", type: "bool" });
  A("addState", { stateMachine: "engine", name: "parked", animation: "parked", x: 120, y: 120 });
  A("addState", { stateMachine: "engine", name: "hover", animation: "hover", x: 360, y: 120 });
  A("setStateEmitter", { stateMachine: "engine", state: "parked", slot: "exhaust", emitting: false });
  A("setStateEmitter", { stateMachine: "engine", state: "hover", slot: "exhaust", emitting: true });
  A("addTransition", { stateMachine: "engine", from: "parked", to: "hover", conditions: [{ input: "thrust", value: true }], duration: 0.6 });
  A("addTransition", { stateMachine: "engine", from: "hover", to: "parked", conditions: [{ input: "thrust", value: false }], duration: 0.8 });
  A("addListener", { stateMachine: "engine", slot: "hit", event: "down", actions: [{ type: "toggleInput", input: "thrust" }, { type: "emitParticles", slot: "sparks", count: 24 }] });
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

  // Backdrop (its colour is bound to the multiplier), ground and launch pad.
  // Painted art (see assets/canva/LICENSE.md). The sky's tint is bound to the multiplier.
  A("addImage", { name: "crash-sky", src: "assets/canva/crash-sky.jpg", width: 800, height: 655 });
  A("addImage", { name: "rocket", src: "assets/canva/rocket.png", width: 204, height: 352 });
  for (let i = 1; i <= 4; i++) A("addImage", { name: `explosion_${String(i).padStart(4, "0")}`, src: `assets/canva/explosion_${String(i).padStart(4, "0")}.png`, width: 180, height: 180 });
  A("addSlot", { bone: "root", name: "sky", color: "#7f8cc8" });
  A("addRegion", { slot: "sky", image: "crash-sky", x: 290, y: 170, width: 800, height: 655 });
  A("addSlot", { bone: "root", name: "ground" });
  A("addShape", { slot: "ground", shape: "rect", x: 290, y: -40, width: 800, height: 80, fill: "#111827" });
  A("addSlot", { bone: "root", name: "pad" });
  A("addShape", { slot: "pad", shape: "rect", y: -8, width: 90, height: 14, radius: 4, fill: "#374151" });

  // Rocket.
  A("addSlot", { bone: "flame", name: "flame" });
  A("addShape", { slot: "flame", shape: "polygon", points: [0, 12, 46, 0, 0, -12], fill: "#f97316" });
  A("addSlot", { bone: "flame", name: "flame-core" });
  A("addShape", { slot: "flame-core", shape: "polygon", points: [0, 6, 26, 0, 0, -6], fill: "#fde047" });
  // The rocket image points up; the bone points along the flight path (nose at +x).
  A("addSlot", { bone: "rocket", name: "body" });
  A("addRegion", { slot: "body", image: "rocket", x: 10, rotation: -90, width: 54, height: 94 });
  // Explosion: a 4-frame painted sequence, additive so its dark backdrop disappears.
  A("addSlot", { bone: "boom", name: "boom", color: "#ffffff00", blend: "additive" });
  A("addSequence", { slot: "boom", name: "boom", frames: ["explosion_0001", "explosion_0002", "explosion_0003", "explosion_0004"], fps: 6, mode: "holdLast", width: 120, height: 120 });

  // HUD: the live multiplier and a status line (a string input), both text templates.
  A("addSlot", { bone: "hud", name: "multiplier" });
  A("addText", { slot: "multiplier", text: "{multiplier:0.00}x", size: 84, weight: 800, width: 360, height: 100, color: "#ffffff", outline: "#0b1020", outlineWidth: 4 });
  A("addSlot", { bone: "status", name: "status" });
  A("addText", { slot: "status", text: "{status}", size: 22, weight: 500, width: 420, height: 32, color: "#cbd5e1" });

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
  A("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "sky", property: "color", inMin: 1, inMax: 10, outMin: "#7f8cc8", outMax: "#ffd9ef" });
  A("addListener", { stateMachine: "game", name: "start button", slot: "button-label", event: "click", actions: [{ type: "fireTrigger", input: "start" }] });
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

// ---------- knight: painted parts rigged front-facing (Canva art, see assets/canva/LICENSE.md) ----------
function knight() {
  const s = new DocumentStore(createDocument("Knight"));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 600, height: 700, originX: 300, originY: 660 });
  // Art is drawn at 0.6x of the Canva sheet so every part keeps the sheet's proportions.
  const S = 0.6;
  const img = (name: string, w: number, h: number) => A("addImage", { name: `knight-${name}`, src: `assets/canva/knight-${name}.png`, width: w, height: h });
  img("helmet", 98, 196);
  img("torso", 186, 381);
  img("shoulder", 90, 103);
  img("arm-upper", 82, 91);
  img("arm-lower", 71, 91);
  img("hand", 66, 80);
  img("thigh", 106, 172);
  img("shin", 79, 240);
  img("boot", 90, 88);
  img("cape", 226, 379);

  // Skeleton (y-up). Torso points up; limbs point down, so their images (drawn upright) rotate by ±90.
  A("addBone", { name: "hip", y: 300, length: 20, color: "#ff9f43" });
  A("addBone", { name: "torso", parent: "hip", rotation: 90, length: 160 });
  A("addBone", { name: "head", parent: "torso", x: 158, length: 60 });
  A("addBone", { name: "cape-root", parent: "torso", x: 150, rotation: -90, length: 0 });
  A("addBone", { name: "cape1", parent: "torso", x: 150, rotation: 180, length: 95 });
  A("addBone", { name: "cape2", parent: "cape1", x: 95, length: 95 });
  A("addBone", { name: "cape3", parent: "cape2", x: 95, length: 95 });
  for (const [side, dy] of [["right", 1], ["left", -1]] as const) {
    A("addBone", { name: `${side}-arm`, parent: "torso", x: 132, y: dy * 58, rotation: 180 - dy * 6, length: 66 });
    A("addBone", { name: `${side}-forearm`, parent: `${side}-arm`, x: 66, rotation: dy * 4, length: 62 });
    A("addBone", { name: `${side}-hand`, parent: `${side}-forearm`, x: 62, length: 34 });
    A("addBone", { name: `${side}-thigh`, parent: "hip", x: dy * -34, rotation: -90, length: 100 });
    A("addBone", { name: `${side}-shin`, parent: `${side}-thigh`, x: 100, length: 140 });
  }

  // Back to front: cape, legs, torso, arms, helmet. Right-side parts mirror the right-side art (scaleX -1).
  const part = (slot: string, bone: string, image: string, w: number, h: number, o: { x?: number; y?: number; rotation?: number; mirror?: boolean; k?: number } = {}) => {
    A("addSlot", { bone, name: slot });
    A("addRegion", { slot, image: `knight-${image}`, x: o.x ?? 0, y: o.y ?? 0, rotation: o.rotation ?? 90, scaleX: o.mirror ? -1 : 1, width: w * S * (o.k ?? 1), height: h * S * (o.k ?? 1) });
  };
  A("addSlot", { bone: "cape-root", name: "cape" });
  A("addMesh", { slot: "cape", name: "cape", image: "knight-cape", y: -140, width: 170, height: 285, cols: 3, rows: 6 });
  A("autoWeights", { slot: "cape", attachment: "cape", bones: ["cape1", "cape2", "cape3"], maxInfluences: 2 });
  for (const side of ["right", "left"] as const) {
    const mirror = side === "left";
    part(`${side}-thigh`, `${side}-thigh`, "thigh", 106, 172, { x: 48, mirror });
    part(`${side}-shin`, `${side}-shin`, "shin", 79, 240, { x: 64, mirror });
    part(`${side}-boot`, `${side}-shin`, "boot", 90, 88, { x: 150, y: mirror ? 6 : -6, mirror });
  }
  part("torso", "torso", "torso", 186, 381, { x: 44, rotation: -90 });
  A("addBoundingBox", { slot: "torso", name: "body-hit", x: 60, width: 260, height: 170 });
  for (const side of ["right", "left"] as const) {
    const mirror = side === "left";
    part(`${side}-arm-lower`, `${side}-forearm`, "arm-lower", 71, 91, { x: 28, mirror, k: 1.25 });
    part(`${side}-hand`, `${side}-hand`, "hand", 66, 80, { x: 10, mirror, k: 1.15 });
    part(`${side}-arm-upper`, `${side}-arm`, "arm-upper", 82, 91, { x: 34, mirror, k: 1.38 });
    part(`${side}-shoulder`, `${side}-arm`, "shoulder", 90, 103, { x: 4, y: mirror ? 4 : -4, mirror });
  }
  part("helmet", "head", "helmet", 98, 196, { x: 46, rotation: -90 });

  const K = (anim: string, target: string, id: string, property: string, keys: [number, number][], curve = "easeInOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  // ---- idle: breathing, slight sway, cape drifting ----
  A("createAnimation", { name: "idle", duration: 2.4 });
  K("idle", "bone", "hip", "y", [[0, 300], [1.2, 296], [2.4, 300]]);
  K("idle", "bone", "torso", "rotation", [[0, 90], [1.2, 91.5], [2.4, 90]]);
  K("idle", "bone", "head", "rotation", [[0, 0], [1.2, -2], [2.4, 0]]);
  K("idle", "bone", "right-arm", "rotation", [[0, 174], [1.2, 171], [2.4, 174]]);
  K("idle", "bone", "left-arm", "rotation", [[0, 186], [1.2, 189], [2.4, 186]]);
  K("idle", "bone", "cape2", "rotation", [[0, 0], [1.2, 3], [2.4, 0]]);
  K("idle", "bone", "cape3", "rotation", [[0, 0], [1.2, 5], [2.4, 0]]);
  // ---- march in place (loop), seen from the front ----
  // A knee lifting towards the viewer is foreshortened: the thigh gets shorter (scaleX) and the foot rises straight up.
  // The shin scales up by the inverse so only the thigh looks shorter. Arms swing opposite to the legs.
  A("createAnimation", { name: "march", duration: 0.9 });
  const lift = (leg: string, t0: number, outward: number) => {
    const up = t0 + 0.225, down = t0 + 0.45;
    const before = t0 > 0 ? ([[0, 1]] as [number, number][]) : [];
    const after = down < 0.9 ? ([[0.9, 1]] as [number, number][]) : [];
    K("march", "bone", `${leg}-thigh`, "scaleX", [...before, [t0, 1], [up, 0.55], [down, 1], ...after]);
    K("march", "bone", `${leg}-shin`, "scaleX", [...before, [t0, 1], [up, 1 / 0.55], [down, 1], ...after]);
    K("march", "bone", `${leg}-thigh`, "rotation", [...before.map(([t]) => [t, -90] as [number, number]), [t0, -90], [up, -90 + outward], [down, -90], ...after.map(([t]) => [t, -90] as [number, number])]);
  };
  lift("right", 0, -4);
  lift("left", 0.45, 4);
  // Only the upper body bobs, so the planted foot stays on the ground.
  K("march", "bone", "torso", "y", [[0, 0], [0.225, 4], [0.45, 0], [0.675, 4], [0.9, 0]]);
  K("march", "bone", "torso", "rotation", [[0, 90], [0.225, 91.5], [0.45, 90], [0.675, 88.5], [0.9, 90]]);
  K("march", "bone", "head", "rotation", [[0, 0], [0.225, -1], [0.45, 0], [0.675, 1], [0.9, 0]]);
  // The arm opposite the lifted knee swings forward: the hand comes in towards the body and up a little.
  K("march", "bone", "left-forearm", "rotation", [[0, -4], [0.225, -18], [0.45, -4], [0.9, -4]]);
  K("march", "bone", "left-arm", "rotation", [[0, 186], [0.225, 182], [0.45, 186], [0.675, 189], [0.9, 186]]);
  K("march", "bone", "right-forearm", "rotation", [[0, 4], [0.45, 4], [0.675, 18], [0.9, 4]]);
  K("march", "bone", "right-arm", "rotation", [[0, 174], [0.225, 171], [0.45, 174], [0.675, 178], [0.9, 174]]);
  K("march", "bone", "cape2", "rotation", [[0, 0], [0.225, 2], [0.45, 0], [0.675, -2], [0.9, 0]]);
  K("march", "bone", "cape3", "rotation", [[0, 0], [0.225, 4], [0.45, 0], [0.675, -4], [0.9, 0]]);
  // ---- wave: left arm up, hand waves, cape flicks (plays once) ----
  A("createAnimation", { name: "wave", duration: 1.6 });
  K("wave", "bone", "right-arm", "rotation", [[0, 174], [0.35, 32], [1.25, 32], [1.6, 174]]);
  K("wave", "bone", "right-forearm", "rotation", [[0, 4], [0.35, -12], [1.25, -12], [1.6, 4]]);
  // The hanging hand shows its back; flip it across the arm when raised so the open palm faces the viewer.
  K("wave", "bone", "right-hand", "scaleY", [[0, 1], [0.2, 1], [0.21, -1], [1.39, -1], [1.4, 1]], "stepped");
  K("wave", "bone", "right-hand", "rotation", [[0, 0], [0.35, 0], [0.55, -22], [0.75, 14], [0.95, -22], [1.15, 14], [1.35, 0]]);
  K("wave", "bone", "torso", "rotation", [[0, 90], [0.35, 87], [1.25, 87], [1.6, 90]]);
  K("wave", "bone", "head", "rotation", [[0, 0], [0.35, -4], [1.25, -4], [1.6, 0]]);
  K("wave", "bone", "cape3", "rotation", [[0, 0], [0.4, -8], [0.9, 6], [1.6, 0]]);

  // ---- state machine: click the knight to wave; "march" toggles marching ----
  A("createStateMachine", { name: "knight" });
  A("addInput", { stateMachine: "knight", name: "march", type: "bool" });
  A("addInput", { stateMachine: "knight", name: "wave", type: "trigger" });
  A("addState", { stateMachine: "knight", name: "idle", animation: "idle", x: 120, y: 140 });
  A("addState", { stateMachine: "knight", name: "march", animation: "march", x: 380, y: 60 });
  A("addState", { stateMachine: "knight", name: "wave", animation: "wave", loop: false, onComplete: "idle", x: 380, y: 220 });
  A("addTransition", { stateMachine: "knight", from: "idle", to: "march", conditions: [{ input: "march", value: true }], duration: 0.25 });
  A("addTransition", { stateMachine: "knight", from: "march", to: "idle", conditions: [{ input: "march", value: false }], duration: 0.25 });
  A("addTransition", { stateMachine: "knight", from: "@any", to: "wave", conditions: [{ input: "wave" }], duration: 0.2 });
  A("addListener", { stateMachine: "knight", slot: "torso", event: "click", actions: [{ type: "fireTrigger", input: "wave" }] });
  return s.doc;
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
  A("addBone", { name: "body", y: 40, length: 0 });
  // The neck points up from the top of the torso; the head turns back upright so its shapes use x right, y up.
  A("addBone", { name: "neck", parent: "body", y: 140, rotation: 90, length: 30 });
  A("addBone", { name: "head", parent: "neck", x: 30, rotation: -90, length: 0 });
  A("addBone", { name: "antenna", parent: "head", y: 150, rotation: 90, length: 60 });
  A("addBone", { name: "mouth", parent: "head", y: 40, length: 0 });
  const shape = (slot: string, bone: string, args: Record<string, unknown>) => {
    A("addSlot", { bone, name: slot });
    A("addShape", { slot, ...args });
  };
  shape("torso", "body", { shape: "rect", x: 0, y: 60, width: 220, height: 170, radius: 28, fill: "#5b6b8c", stroke: "#2c3550", strokeWidth: 4 });
  shape("panel", "body", { shape: "rect", x: 0, y: 70, width: 120, height: 70, radius: 10, fill: "#3a4566" });
  shape("light", "body", { shape: "ellipse", x: -30, y: 70, width: 22, height: 22, fill: "#3ddc84" });
  shape("neck", "neck", { shape: "rect", x: 15, y: 0, width: 30, height: 40, radius: 6, fill: "#46536f" });
  shape("antenna-stick", "antenna", { shape: "rect", x: 30, y: 0, width: 60, height: 6, radius: 3, fill: "#2c3550" });
  shape("antenna-ball", "antenna", { shape: "ellipse", x: 62, y: 0, width: 22, height: 22, fill: "#ff5d5d" });
  shape("head", "head", { shape: "rect", x: 0, y: 75, width: 240, height: 170, radius: 36, fill: "#7d8db0", stroke: "#2c3550", strokeWidth: 4 });
  shape("face", "head", { shape: "rect", x: 0, y: 75, width: 200, height: 125, radius: 26, fill: "#1b2133" });
  for (const [name, x] of [["eye-l", -48], ["eye-r", 48]] as const) shape(name, "head", { shape: "ellipse", x, y: 105, width: 38, height: 38, fill: "#8ad4ff" });
  // Mouth shapes, one attachment each (named so the editor's Lip sync dialog guesses them).
  A("addSlot", { bone: "mouth", name: "mouth" });
  const mouth = (name: string, args: Record<string, unknown>) => A("addShape", { slot: "mouth", name, activate: name === "mouth-rest", fill: "#8ad4ff", ...args });
  mouth("mouth-rest", { shape: "rect", width: 70, height: 6, radius: 3 });
  mouth("mouth-closed", { shape: "rect", width: 56, height: 10, radius: 5 });
  mouth("mouth-small", { shape: "ellipse", width: 40, height: 16 });
  mouth("mouth-open", { shape: "ellipse", width: 58, height: 30 });
  mouth("mouth-wide", { shape: "rect", width: 86, height: 40, radius: 18 });
  mouth("mouth-round", { shape: "ellipse", width: 30, height: 30 });
  A("addBoundingBox", { slot: "head", name: "head-hit", y: 75, width: 240, height: 170 });

  const voice = readWav(path.join(here, "assets/robot-voice.wav"));
  const length = voice.samples.length / voice.rate;
  A("addAudio", { name: "robot-voice", src: "assets/robot-voice.wav", duration: Math.round(length * 1000) / 1000, bus: "sfx" });

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

// Build only when run as a script (tests import the example builders).
const runAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (runAsScript) {
  for (let i = 0; i < FLAME_FRAMES; i++) writeFileSync(path.join(here, `assets/${frameName("flame", i)}.png`), makeFlame(i));
  for (let i = 0; i < SMOKE_FRAMES; i++) writeFileSync(path.join(here, `assets/${frameName("smoke", i)}.png`), makeSmoke(i));
}
if (runAsScript)
for (const [file, doc] of [["walker.obone", walker()], ["button.obone", button()], ["tail.obone", tail()], ["campfire.obone", campfire()], ["rocket.obone", rocket()], ["crash.obone", crash()], ["knight.obone", knight()], ["robot.obone", robot()]] as const) {
  const issues = validate(doc);
  if (issues.some((i) => i.level === "error")) throw new Error(`${file}: ${JSON.stringify(issues)}`);
  writeFileSync(path.join(here, file), serialize(doc));
  console.log(`wrote examples/${file}${issues.length ? ` (${issues.length} warnings)` : ""}`);
}
