/**
 * Focused conformance rigs: each one exercises a part of the runtime the examples don't cover well (or covers
 * in a way that's hard to debug). Built from ops, so they are valid documents by construction. Images are tiny
 * placeholders: runtimes never need pixels, only sizes.
 */
import { DocumentStore, type OpenBoneDocument, createDocument } from "@openbone/core";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function store(name: string) {
  const s = new DocumentStore(createDocument(name));
  s.apply("setDocument", { width: 400, height: 400, originX: 200, originY: 300 });
  return s;
}
const image = (s: DocumentStore, name: string, width: number, height: number) => s.apply("addImage", { id: `img_${name}`, name, src: PIXEL, width, height });

/** Inherit modes, shear, non-uniform scale, colour/attachment/draw-order keys and every curve type. */
function transforms(): OpenBoneDocument {
  const s = store("transforms");
  image(s, "box", 40, 20);
  image(s, "box2", 30, 30);
  s.apply("addBone", { name: "base", x: 0, y: 50, length: 60, scaleX: 1.5, scaleY: 0.75, shearY: 10 });
  const modes = ["normal", "onlyTranslation", "noRotation", "noScale"] as const;
  modes.forEach((inherit, i) => {
    s.apply("addBone", { name: `c-${inherit}`, parent: "base", x: 40 + i * 20, y: 10, rotation: 20, length: 30, inherit });
    s.apply("addSlot", { name: `s-${inherit}`, bone: `c-${inherit}`, color: i % 2 ? "#ff8040cc" : "#ffffff" });
    s.apply("addRegion", { slot: `s-${inherit}`, image: "box", x: 15, rotation: 5, scaleX: 1.2 });
  });
  s.apply("addRegion", { slot: "s-normal", image: "box2", name: "alt", activate: false });
  s.apply("createAnimation", { name: "move" });
  const k = (property: string, keys: unknown[]) => s.apply("setKeys", { animation: "move", target: "bone", id: "base", property, keys });
  k("rotation", [{ time: 0, value: 0, curve: "linear" }, { time: 0.5, value: 90, curve: "easeInOut" }, { time: 1, value: -45, curve: [0.2, 0.9, 0.3, 1.2] }, { time: 1.5, value: 0 }]);
  k("x", [{ time: 0, value: 0, curve: "stepped" }, { time: 0.75, value: 40 }, { time: 1.5, value: 0 }]);
  k("scaleX", [{ time: 0, value: 1.5 }, { time: 1, value: 0.5 }]);
  k("shearX", [{ time: 0, value: 0 }, { time: 1.5, value: 30 }]);
  s.apply("setKeys", { animation: "move", target: "slot", id: "s-normal", property: "color", keys: [{ time: 0, value: "#ffffffff" }, { time: 1, value: "#00ff0080" }] });
  s.apply("setKeys", { animation: "move", target: "slot", id: "s-normal", property: "dark", keys: [{ time: 0, value: "#000000" }, { time: 1, value: "#ff0000" }] });
  s.apply("setKeys", { animation: "move", target: "slot", id: "s-normal", property: "attachment", keys: [{ time: 0, value: "box" }, { time: 0.6, value: "alt" }, { time: 1.2, value: null }] });
  s.apply("setKeys", { animation: "move", target: "drawOrder", keys: [{ time: 0.8, value: ["s-noScale", "s-noRotation", "s-onlyTranslation", "s-normal"] }] });
  s.apply("addEventKey", { animation: "move", event: "step", time: 0.5, int: 3, float: 1.5, string: "left" });
  s.apply("addEventKey", { animation: "move", event: "step", time: 1.25 });
  return s.doc;
}

/** IK (1- and 2-bone, softness, stretch, compress, bend keys), transform constraints (world/local, absolute/relative). */
function constraints(): OpenBoneDocument {
  const s = store("constraints");
  image(s, "seg", 60, 12);
  s.apply("addBone", { name: "thigh", x: -60, y: 100, rotation: -80, length: 70 });
  s.apply("addBone", { name: "shin", parent: "thigh", x: 70, rotation: 10, length: 70 });
  s.apply("addBone", { name: "target", x: -40, y: -10 });
  s.apply("addIkConstraint", { name: "leg", bones: ["thigh", "shin"], target: "target", softness: 10, stretch: true });
  s.apply("addBone", { name: "arm", x: 60, y: 100, length: 50 });
  s.apply("addBone", { name: "aim", x: 140, y: 160 });
  s.apply("addIkConstraint", { name: "point", bones: ["arm"], target: "aim", compress: true, stretch: true, uniform: true });
  s.apply("addBone", { name: "driver", x: 0, y: 200, rotation: 30, scaleX: 1.3, length: 40 });
  s.apply("addBone", { name: "follower-w", x: -100, y: 250, length: 40 });
  s.apply("addBone", { name: "follower-l", x: 100, y: 250, length: 40 });
  s.apply("addTransformConstraint", { name: "world", bones: ["follower-w"], target: "driver", mixRotate: 0.8, mixTranslate: 0.25, mixScale: 0.5, offsetRotation: 15 });
  s.apply("addTransformConstraint", { name: "local", bones: ["follower-l"], target: "driver", local: true, relative: true, mixRotate: 1, mixScale: 1, mixShear: 1 });
  for (const b of ["thigh", "shin", "arm", "follower-w", "follower-l"]) {
    s.apply("addSlot", { name: b, bone: b });
    s.apply("addRegion", { slot: b, image: "seg", x: 30 });
  }
  s.apply("createAnimation", { name: "reach" });
  s.apply("setKeys", { animation: "reach", target: "bone", id: "target", property: "x", keys: [{ time: 0, value: -40 }, { time: 1, value: 80 }, { time: 2, value: -40 }] });
  s.apply("setKeys", { animation: "reach", target: "bone", id: "target", property: "y", keys: [{ time: 0, value: -10 }, { time: 1, value: 120 }, { time: 2, value: -10 }] });
  s.apply("setKeys", { animation: "reach", target: "ik", id: "leg", property: "bend", keys: [{ time: 0, value: 1, curve: "stepped" }, { time: 1.5, value: -1 }] });
  s.apply("setKeys", { animation: "reach", target: "ik", id: "leg", property: "mix", keys: [{ time: 0, value: 1 }, { time: 2, value: 0.5 }] });
  s.apply("setKeys", { animation: "reach", target: "bone", id: "aim", property: "x", keys: [{ time: 0, value: 140 }, { time: 1, value: 70 }, { time: 2, value: 140 }] });
  s.apply("setKeys", { animation: "reach", target: "bone", id: "driver", property: "rotation", keys: [{ time: 0, value: 30 }, { time: 2, value: 210 }] });
  s.apply("setKeys", { animation: "reach", target: "transform", id: "world", property: "mixTranslate", keys: [{ time: 0, value: 0.25 }, { time: 2, value: 1 }] });
  return s.doc;
}

/** Weighted mesh with deform keys, a linked mesh in another skin that follows them, clipping, a path constraint. */
function meshes(): OpenBoneDocument {
  const s = store("meshes");
  image(s, "cloth", 100, 100);
  image(s, "cloth-blue", 100, 100);
  image(s, "bg", 200, 200);
  s.apply("addBone", { name: "top", y: 150, rotation: -90, length: 50 });
  s.apply("addBone", { name: "bottom", parent: "top", x: 50, length: 50 });
  s.apply("addSlot", { name: "mask", bone: "root" });
  s.apply("addSlot", { name: "back", bone: "root" });
  s.apply("addRegion", { slot: "back", image: "bg", y: 100 });
  s.apply("addSlot", { name: "cloth", bone: "top", dark: "#202060" });
  s.apply("addMesh", { slot: "cloth", image: "cloth", x: 0, y: 100, cols: 3, rows: 4 });
  s.apply("autoWeights", { slot: "cloth", attachment: "cloth", bones: ["top", "bottom"] });
  s.apply("addClipping", { slot: "mask", shape: "ellipse", y: 110, width: 160, height: 150, end: "cloth" });
  s.apply("addSkin", { name: "blue" });
  s.apply("addLinkedMesh", { slot: "cloth", skin: "blue", name: "cloth", image: "cloth-blue", parent: "cloth", parentSkin: "default" });
  s.apply("addBone", { name: "t1", x: -150, y: 20, length: 30 });
  s.apply("addBone", { name: "t2", parent: "t1", x: 30, length: 30 });
  s.apply("addBone", { name: "t3", parent: "t2", x: 30, length: 30 });
  s.apply("addSlot", { name: "rail", bone: "root" });
  s.apply("addPath", { slot: "rail", anchors: [-150, 20, -100, 80, -40, 40, 20, 120] });
  s.apply("addPathConstraint", { name: "follow", bones: ["t1", "t2", "t3"], target: "rail", rotateMode: "chain", position: 0.1 });
  s.apply("createAnimation", { name: "wave" });
  s.apply("setKeys", { animation: "wave", target: "bone", id: "bottom", property: "rotation", keys: [{ time: 0, value: -30 }, { time: 0.5, value: 30 }, { time: 1, value: -30 }] });
  const doc = s.doc;
  const n = (doc.skeleton.skins[0].attachments[doc.skeleton.slots.find((x) => x.name === "cloth")!.id].cloth as { vertices: number[] }).vertices.length;
  s.apply("setKeys", { animation: "wave", target: "deform", id: "cloth", attachment: "cloth", keys: [{ time: 0, value: new Array(n).fill(0) }, { time: 0.5, value: Array.from({ length: n }, (_, i) => (i % 2 ? 8 : -5)) }, { time: 1, value: new Array(n).fill(0) }] });
  s.apply("setKeys", { animation: "wave", target: "path", id: "follow", property: "position", keys: [{ time: 0, value: 0.1 }, { time: 1, value: 0.6 }] });
  return s.doc;
}

/** Physics chain driven by a moving root, sliders, sequences, particles and text. */
function dynamics(): OpenBoneDocument {
  const s = store("dynamics");
  image(s, "f1", 20, 20);
  image(s, "f2", 20, 20);
  image(s, "f3", 20, 20);
  s.apply("addBone", { name: "hair1", y: 200, rotation: -90, length: 30 });
  s.apply("addBone", { name: "hair2", parent: "hair1", x: 30, length: 30 });
  s.apply("addBone", { name: "hair3", parent: "hair2", x: 30, length: 30 });
  for (const b of ["hair1", "hair2", "hair3"]) s.apply("addPhysicsConstraint", { bone: b, inertia: 0.6, strength: 80, damping: 0.8, gravity: 40, wind: 10, rotate: 1, x: 0.5 });
  s.apply("addSlot", { name: "flip", bone: "root" });
  s.apply("addSequence", { slot: "flip", frames: ["f1", "f2", "f3"], fps: 6, mode: "pingPong", y: 40 });
  s.apply("addSlot", { name: "fx", bone: "hair3" });
  s.apply("addParticles", { slot: "fx", preset: "sparks", seed: 7, maxParticles: 40 });
  s.apply("addSlot", { name: "label", bone: "root" });
  s.apply("addText", { slot: "label", text: "Score {score:#,##0}", y: -40, width: 160, height: 24 });
  s.apply("createAnimation", { name: "shake" });
  s.apply("setKeys", { animation: "shake", target: "bone", id: "root", property: "x", keys: [{ time: 0, value: 0 }, { time: 0.3, value: 60 }, { time: 0.6, value: -60 }, { time: 1, value: 0 }] });
  s.apply("createAnimation", { name: "lean" });
  s.apply("setKeys", { animation: "lean", target: "bone", id: "hair1", property: "rotation", keys: [{ time: 0, value: -90 }, { time: 1, value: -45 }] });
  s.apply("addBone", { name: "knob", x: 150, y: 0, length: 20 });
  s.apply("addSlider", { name: "lean-by-knob", animation: "lean", bone: "knob", property: "rotation", from: 0, to: 90 });
  s.apply("setKeys", { animation: "shake", target: "bone", id: "knob", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] });
  return s.doc;
}

/** State machine: every input type, blend1d, any-state, exit time, listeners, bindings, events with sound, a script. */
function interactive(): OpenBoneDocument {
  const s = store("interactive");
  image(s, "btn", 80, 40);
  s.apply("addBone", { name: "body", y: 100, length: 50 });
  s.apply("addSlot", { name: "button", bone: "body" });
  s.apply("addRegion", { slot: "button", image: "btn" });
  s.apply("addBoundingBox", { slot: "button", width: 80, height: 40, activate: false });
  s.apply("addSlot", { name: "label", bone: "body" });
  s.apply("addText", { slot: "label", text: "{count} / {status}", y: 30, width: 120, height: 20 });
  for (const [name, rot] of [["idle", 0], ["walk", 30], ["run", 60], ["press", -20]] as const) {
    s.apply("createAnimation", { name });
    s.apply("setKeys", { animation: name, target: "bone", id: "body", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 0.5, value: rot }, { time: 1, value: 0 }] });
  }
  s.apply("addEventKey", { animation: "press", event: "click", time: 0.25 });
  s.apply("addAudio", { name: "beep", src: "beep.wav", duration: 0.2 });
  s.apply("setEventSound", { event: "click", sound: "beep" });
  s.apply("createStateMachine", { name: "main" });
  s.apply("addInput", { stateMachine: "main", name: "speed", type: "number", default: 0 });
  s.apply("addInput", { stateMachine: "main", name: "pressed", type: "trigger" });
  s.apply("addInput", { stateMachine: "main", name: "on", type: "bool", default: false });
  s.apply("addInput", { stateMachine: "main", name: "count", type: "number", default: 0 });
  s.apply("addInput", { stateMachine: "main", name: "status", type: "string", default: "ready" });
  s.apply("addState", { stateMachine: "main", name: "locomotion", type: "blend1d", blendInput: "speed", blend: [{ animation: "idle", value: 0 }, { animation: "walk", value: 0.5 }, { animation: "run", value: 1 }] });
  s.apply("addState", { stateMachine: "main", name: "press", animation: "press", loop: false });
  s.apply("addTransition", { stateMachine: "main", from: "@any", to: "press", conditions: [{ input: "pressed" }], duration: 0.1 });
  s.apply("addTransition", { stateMachine: "main", from: "press", to: "locomotion", exitTime: 1, duration: 0.2 });
  s.apply("addListener", { stateMachine: "main", slot: "button", event: "down", actions: [{ type: "fireTrigger", input: "pressed" }, { type: "reportEvent", event: "click" }] });
  // Mute buttons: toggle a bus twice (on, then off again), then mute everything. Each emits a "mix" audio command.
  s.apply("addListener", { stateMachine: "main", slot: "button", event: "up", actions: [{ type: "setMute", bus: "music", muted: "toggle" }, { type: "setMute", bus: "music", muted: "toggle" }, { type: "setMute", bus: null, muted: true }] });
  s.apply("addBinding", { stateMachine: "main", input: "speed", target: "bone", object: "body", property: "scaleX", inMin: 0, inMax: 1, outMin: 1, outMax: 1.5 });
  s.apply("addScript", { name: "counter", code: "let n = 0;\nfunction onEvent(e) { if (e.name === 'click') { n++; ob.setInput('count', n); ob.setInput('status', n > 1 ? 'busy' : 'ready'); } }" });
  s.apply("attachScript", { stateMachine: "main", script: "counter" });
  return s.doc;
}

/** Skin bones and skin constraints, inherit-mode keys, a custom constraint order, and a reference scale. */
function rigging(): OpenBoneDocument {
  const s = store("rigging");
  image(s, "part", 40, 16);
  s.apply("setDocument", { referenceScale: 50 });
  s.apply("addBone", { name: "spine", y: 100, rotation: 90, length: 60 });
  s.apply("addBone", { name: "head", parent: "spine", x: 60, length: 30 });
  s.apply("addBone", { name: "cape", parent: "spine", x: 50, rotation: 180, length: 50 });
  s.apply("addBone", { name: "cape-tip", parent: "cape", x: 50, length: 30 });
  s.apply("addBone", { name: "aim", x: 80, y: 60 });
  s.apply("addBone", { name: "copy", x: -80, y: 150, length: 30 });
  for (const b of ["spine", "head", "cape", "cape-tip", "copy"]) {
    s.apply("addSlot", { name: b, bone: b });
    s.apply("addRegion", { slot: b, image: "part", x: 20 });
  }
  // The cape (and its chain) only exists in the "hero" skin, with an IK and physics that only run there.
  s.apply("addIkConstraint", { name: "cape-reach", bones: ["cape", "cape-tip"], target: "aim", softness: 20 });
  s.apply("addPhysicsConstraint", { name: "tip-sway", bone: "cape-tip", rotate: 1, gravity: 60, wind: 20, strength: 60 });
  s.apply("addTransformConstraint", { name: "follow-head", bones: ["copy"], target: "head", mixRotate: 1, mixTranslate: 0.5 });
  s.apply("addSkin", { name: "hero" });
  s.apply("addToSkin", { skin: "hero", bones: ["cape"], constraints: ["cape-reach", "tip-sway"] });
  // Transform before IK (the default would be IK first).
  s.apply("setConstraintOrder", { constraints: ["follow-head", "cape-reach", "tip-sway"] });
  s.apply("createAnimation", { name: "turn" });
  s.apply("setKeys", { animation: "turn", target: "bone", id: "spine", property: "rotation", keys: [{ time: 0, value: 90 }, { time: 1, value: 150 }, { time: 2, value: 90 }] });
  s.apply("setKeys", { animation: "turn", target: "bone", id: "head", property: "inherit", keys: [{ time: 0, value: "normal" }, { time: 0.5, value: "noRotation" }, { time: 1.5, value: "onlyTranslation" }] });
  s.apply("setKeys", { animation: "turn", target: "bone", id: "aim", property: "y", keys: [{ time: 0, value: 60 }, { time: 2, value: 160 }] });
  return s.doc;
}

/**
 * Cross-fades where only the outgoing state keys a value: walk keys the foot, a colour, a dark colour and a
 * transform-constraint mix that idle doesn't, so over walk → idle they fade back to the setup pose.
 */
function mixing(): OpenBoneDocument {
  const s = store("mixing");
  image(s, "part", 30, 12);
  s.apply("addBone", { name: "hip", y: 100, length: 40 });
  s.apply("addBone", { name: "foot", parent: "hip", y: -100, length: 20 });
  s.apply("addBone", { name: "arm", parent: "hip", x: 30, length: 30 });
  s.apply("addBone", { name: "sway", x: 100, y: 80, rotation: 30, length: 30 });
  s.apply("addTransformConstraint", { name: "swing", bones: ["arm"], target: "sway", mixRotate: 0 });
  for (const b of ["hip", "foot", "arm"]) {
    s.apply("addSlot", { name: b, bone: b, ...(b === "hip" ? { dark: "#000000" } : {}) });
    s.apply("addRegion", { slot: b, image: "part", x: 15 });
  }
  s.apply("addRegion", { slot: "foot", image: "part", name: "step", activate: false });
  s.apply("createAnimation", { name: "idle", duration: 1 });
  s.apply("setKeys", { animation: "idle", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 100 }, { time: 0.5, value: 96 }, { time: 1, value: 100 }] });
  s.apply("createAnimation", { name: "walk", duration: 1 });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 104 }, { time: 0.5, value: 108 }, { time: 1, value: 104 }] });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "foot", property: "x", keys: [{ time: 0, value: -60 }, { time: 0.5, value: 60 }, { time: 1, value: -60 }] });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "foot", property: "rotation", keys: [{ time: 0, value: -170 }, { time: 0.5, value: 170 }, { time: 1, value: -170 }] });
  s.apply("setKeys", { animation: "walk", target: "slot", id: "hip", property: "color", keys: [{ time: 0, value: "#ff4020ff" }] });
  s.apply("setKeys", { animation: "walk", target: "slot", id: "hip", property: "dark", keys: [{ time: 0, value: "#4080ff" }] });
  s.apply("setKeys", { animation: "walk", target: "slot", id: "foot", property: "attachment", keys: [{ time: 0, value: "step" }] });
  s.apply("setKeys", { animation: "walk", target: "transform", id: "swing", property: "mixRotate", keys: [{ time: 0, value: 1 }] });
  s.apply("createStateMachine", { name: "walker" });
  s.apply("addInput", { stateMachine: "walker", name: "walking", type: "bool", default: true });
  s.apply("addState", { stateMachine: "walker", name: "walk", animation: "walk" });
  s.apply("addState", { stateMachine: "walker", name: "idle", animation: "idle" });
  s.apply("addTransition", { stateMachine: "walker", from: "walk", to: "idle", duration: 0.5, conditions: [{ input: "walking", op: "==", value: false }] });
  s.apply("addTransition", { stateMachine: "walker", from: "idle", to: "walk", duration: 0.5, conditions: [{ input: "walking", op: "==", value: true }] });
  return s.doc;
}

/**
 * Bounding-box queries: an unweighted polygon box, a box weighted to two bones, a box switched on and off by
 * attachment keys, a box on a skin-only bone, a draw-order key, and a region that must be ignored. The queries
 * are in `BOUNDS_QUERIES`.
 */
function bounds(): OpenBoneDocument {
  const s = store("bounds");
  image(s, "plate", 40, 40);
  s.apply("addBone", { name: "body", y: 100, rotation: 90, length: 80 });
  s.apply("addBone", { name: "arm", parent: "body", x: 60, rotation: -90, length: 60 });
  s.apply("addBone", { name: "hand", parent: "arm", x: 60, length: 40 });
  s.apply("addBone", { name: "tail", parent: "body", rotation: 180, length: 50 });
  s.apply("addSlot", { name: "torso", bone: "body" });
  s.apply("addBoundingBox", { slot: "torso", activate: true, vertices: [0, -30, 70, -25, 95, 0, 70, 28, 0, 32, -10, 0] });
  s.apply("addSlot", { name: "decor", bone: "body" });
  s.apply("addRegion", { slot: "decor", image: "plate", x: 40 });
  s.apply("addSlot", { name: "arm", bone: "arm" });
  s.apply("addBoundingBox", { slot: "arm", name: "sleeve", activate: true, vertices: [0, -12, 50, -14, 100, -10, 100, 10, 50, 14, 0, 12] });
  s.apply("autoWeights", { slot: "arm", attachment: "sleeve", bones: ["arm", "hand"] });
  s.apply("addSlot", { name: "shield", bone: "hand" });
  s.apply("addBoundingBox", { slot: "shield", name: "shield", activate: false, vertices: [20, -40, 60, 0, 20, 40] });
  s.apply("addSlot", { name: "tail", bone: "tail" });
  s.apply("addBoundingBox", { slot: "tail", name: "tail", activate: true, x: 25, width: 50, height: 16 });
  s.apply("addSkin", { name: "tailed" });
  s.apply("addToSkin", { skin: "tailed", bones: ["tail"] });
  s.apply("createAnimation", { name: "swing" });
  const k = (id: string, property: string, keys: unknown[]) => s.apply("setKeys", { animation: "swing", target: "bone", id, property, keys });
  k("body", "rotation", [{ time: 0, value: 90 }, { time: 1, value: 60 }, { time: 2, value: 90 }]);
  k("arm", "rotation", [{ time: 0, value: -90 }, { time: 1, value: -20 }, { time: 2, value: -90 }]);
  k("hand", "rotation", [{ time: 0, value: 0 }, { time: 1, value: 60 }, { time: 2, value: 0 }]);
  k("root", "x", [{ time: 0, value: 0 }, { time: 2, value: 40 }]);
  s.apply("setKeys", { animation: "swing", target: "slot", id: "shield", property: "attachment", keys: [{ time: 0, value: null }, { time: 0.5, value: "shield" }, { time: 1.5, value: null }] });
  s.apply("setKeys", { animation: "swing", target: "drawOrder", keys: [{ time: 0, value: ["torso", "decor", "arm", "shield", "tail"] }, { time: 1, value: ["shield", "arm", "torso", "decor", "tail"] }] });
  return s.doc;
}

/**
 * Path constraints on a curve with very uneven handles: the same path and chain with constant speed on (the
 * default) and off, an open and a closed path, keyed positions that run off the ends (and wrap on the closed one).
 */
function paths(): OpenBoneDocument {
  const s = store("paths");
  s.apply("addSlot", { name: "rail", bone: "root" });
  // Knots [in, anchor, out]: the first segment has one long and one tiny handle, the second the reverse.
  s.apply("addPath", { slot: "rail", vertices: [-180, 0, -150, 20, -40, 160, 0, 60, 10, 80, 20, 100, 150, 10, 170, 200, 190, 220] });
  s.apply("addSlot", { name: "loop", bone: "root" });
  s.apply("addPath", { slot: "loop", closed: true, vertices: [-60, 260, -40, 240, 20, 240, 60, 200, 70, 180, 60, 120, 10, 150, -60, 160, -70, 175] });
  const chain = (prefix: string, n: number, len: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const name = `${prefix}${i + 1}`;
      s.apply("addBone", { name, parent: i ? out[i - 1] : "root", x: i ? len : 0, length: len });
      out.push(name);
    }
    return out;
  };
  const even = chain("even", 5, 40);
  const raw = chain("raw", 5, 40);
  const loopEven = chain("loop-even", 4, 30);
  const loopRaw = chain("loop-raw", 4, 30);
  s.apply("addPathConstraint", { name: "even", bones: even, target: "rail", rotateMode: "chain", position: 0.05 });
  s.apply("addPathConstraint", { name: "raw", bones: raw, target: "rail", rotateMode: "chain", position: 0.05, constantSpeed: false });
  s.apply("addPathConstraint", { name: "loop-even", bones: loopEven, target: "loop", rotateMode: "tangent", spacingMode: "percent", spacing: 0.1, position: 0.1 });
  s.apply("addPathConstraint", { name: "loop-raw", bones: loopRaw, target: "loop", rotateMode: "chainScale", spacingMode: "percent", spacing: 0.1, position: 0.1 });
  s.apply("updatePathConstraint", { constraint: "loop-raw", constantSpeed: false });
  s.apply("createAnimation", { name: "slide" });
  for (const c of ["even", "raw"]) s.apply("setKeys", { animation: "slide", target: "path", id: c, property: "position", keys: [{ time: 0, value: -0.1 }, { time: 2, value: 0.9 }] });
  for (const c of ["loop-even", "loop-raw"]) s.apply("setKeys", { animation: "slide", target: "path", id: c, property: "position", keys: [{ time: 0, value: 0.1 }, { time: 2, value: 1.6 }] });
  return s.doc;
}

export const FIXTURES: Record<string, () => OpenBoneDocument> = { transforms, constraints, meshes, dynamics, interactive, rigging, mixing, bounds, paths };

/** Bounding-box queries recorded for a fixture (see conformance/README.md). Candidates unstable under a tiny nudge are dropped. */
export interface BoundsQueries {
  points: [number, number][];
  segments: [number, number, number, number][];
  aabbs: [number, number, number, number][];
  /** Placements (skeleton x, y) of a second copy of the document in its setup pose, for skeleton-skeleton overlap. */
  others: [number, number][];
}

/** Deterministic pseudo-random numbers (mulberry32), so the query candidates are the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boundsQueries(): BoundsQueries {
  const r = rng(7);
  const q = (v: number) => Math.round(v * 100) / 100;
  const x = () => q(-80 + r() * 300);
  const y = () => q(60 + r() * 240);
  const points: [number, number][] = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) points.push([q(-80 + i * 25.3), q(60 + j * 20.7)]);
  const segments: [number, number, number, number][] = [];
  for (let i = 0; i < 40; i++) segments.push([x(), y(), x(), y()]);
  for (let i = 0; i < 20; i++) {
    const [x0, y0] = [x(), y()];
    segments.push([x0, y0, q(x0 + (r() - 0.5) * 16), q(y0 + (r() - 0.5) * 16)]);
  }
  const aabbs: [number, number, number, number][] = [];
  for (let i = 0; i < 30; i++) {
    const [x0, y0] = [x() - 60, y() - 40];
    aabbs.push([x0, y0, q(x0 + 5 + r() * 40), q(y0 + 5 + r() * 40)]);
  }
  const others: [number, number][] = [[0, 0], [30, 0], [90, 20], [150, 60], [-160, 0], [0, 190], [60, -110], [200, 200]];
  return { points, segments, aabbs, others };
}

export const BOUNDS_QUERIES: Record<string, () => BoundsQueries> = { bounds: boundsQueries };
