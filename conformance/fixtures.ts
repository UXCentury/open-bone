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

export const FIXTURES: Record<string, () => OpenBoneDocument> = { transforms, constraints, meshes, dynamics, interactive, rigging, mixing };
