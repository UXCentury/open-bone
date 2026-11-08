/**
 * Builds the example projects in this folder using the same ops the editor and MCP server use.
 * Run: pnpm tsx examples/build-examples.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { DocumentStore, createDocument, serialize, validate } from "@openbone/core";

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
  const s = new DocumentStore(createDocument("Walker", { background: "#eef2f7" }));
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

// ---------- button ----------
function button() {
  const s = new DocumentStore(createDocument("Button", { background: "#0f172a" }));
  const A = (op: string, args: Record<string, unknown>) => s.apply(op, args);
  A("setDocument", { width: 400, height: 200, originX: 200, originY: 100 });
  A("addBone", { name: "btn", length: 0 });
  A("addBone", { name: "shine", parent: "btn", x: -140, length: 0 });
  A("addSlot", { bone: "btn", name: "shadow" });
  A("addShape", { slot: "shadow", shape: "rect", y: -6, width: 220, height: 74, radius: 24, fill: "#00000066" });
  A("addSlot", { bone: "btn", name: "bg" });
  A("addShape", { slot: "bg", shape: "rect", width: 220, height: 74, radius: 24, fill: "#6366f1" });
  // Glass sweep: the shine slides across on hover, clipped to the button's rounded outline.
  A("addSlot", { bone: "btn", name: "glass-mask" });
  A("addSlot", { bone: "shine", name: "shine", color: "#ffffff00" });
  A("addClipping", { slot: "glass-mask", name: "mask", width: 220, height: 74, radius: 24, end: "shine" });
  A("addShape", { slot: "shine", shape: "polygon", points: [-10, 37, 20, 37, 0, -37, -30, -37], fill: "#ffffff55" });
  A("addSlot", { bone: "btn", name: "icon" });
  A("addShape", { slot: "icon", shape: "polygon", points: [-12, 18, 20, 0, -12, -18], fill: "#ffffff" });
  A("addSlot", { bone: "btn", name: "hit" });
  A("addBoundingBox", { slot: "hit", width: 220, height: 74 });
  const K = (anim: string, target: string, id: string, property: string, keys: [number, number | string][], curve: string = "easeOut") =>
    A("setKeys", { animation: anim, target, id, property, keys: keys.map(([time, value]) => ({ time, value, curve })) });
  A("createAnimation", { name: "idle", duration: 1.5 });
  K("idle", "bone", "btn", "scaleX", [[0, 1], [0.75, 1.02], [1.5, 1]], "easeInOut");
  K("idle", "bone", "btn", "scaleY", [[0, 1], [0.75, 1.02], [1.5, 1]], "easeInOut");
  A("createAnimation", { name: "hover", duration: 0.6 });
  K("hover", "bone", "btn", "scaleX", [[0, 1], [0.25, 1.08]], "backOut");
  K("hover", "bone", "btn", "scaleY", [[0, 1], [0.25, 1.08]], "backOut");
  K("hover", "slot", "bg", "color", [[0, "#ffffff"], [0.25, "#c7d2fe"]]);
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
  return s.doc;
}

for (const [file, doc] of [["walker.obone", walker()], ["button.obone", button()]] as const) {
  const issues = validate(doc);
  if (issues.some((i) => i.level === "error")) throw new Error(`${file}: ${JSON.stringify(issues)}`);
  writeFileSync(path.join(here, file), serialize(doc));
  console.log(`wrote examples/${file}${issues.length ? ` (${issues.length} warnings)` : ""}`);
}
