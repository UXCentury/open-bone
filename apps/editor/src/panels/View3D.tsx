import { invert, textureAssets } from "@openbone/core";
import type { Bone, DrawItem, Skeleton } from "@openbone/runtime";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type * as THREE_NS from "three";
import { commitAttachmentMove, commitBone } from "../edit.ts";
import { imageFor } from "../images.ts";
import { kbd } from "../shortcuts/index.ts";
import { apply, mode, selectedBoneIds, selectedSlotIds, selection, setMultiBones, setMultiSlots, setSelection, store, toast, toggleInSelection, transaction } from "../state.ts";
import { eyeOpacity, boneLocked, slotLocked } from "../visibility.ts";
import { viewportApi } from "./Viewport.tsx";

/**
 * 3D view (View → 3D view, Shift+Z): the scene as a stack of layers you can orbit around, like an engine's scene view.
 * Every drawn part sits on its own plane, one step deeper per place in the draw order (front-most nearest the
 * viewer), with a thin outline around each plane. The bones are solid 3D bones (a pyramid from joint to tip, with a
 * ball at each joint) at the depth of the parts they carry, so the rig reads in depth too. A small inset shows the
 * normal front view. It shows the pose the viewport has, live, in Setup, Animate and Play.
 *
 * Drag to orbit, right-drag to pan, wheel to zoom; click a part or a bone to select it. three.js loads only when the
 * view opens, so the editor's start-up size doesn't change.
 */
export function View3D() {
  let host!: HTMLDivElement;
  const [depth, setDepth] = createSignal(16);
  const [outlines, setOutlines] = createSignal(true);
  const [bonesOn, setBonesOn] = createSignal(true);
  const [scenery, setScenery] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  let refit: (() => void) | null = null;
  let disposed = false;
  let stop = () => {};

  onMount(async () => {
    const THREE = await import("three");
    const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
    if (disposed) return;

    let renderer: THREE_NS.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed("The 3D view needs WebGL, which this browser has turned off. Enable hardware acceleration (or use the desktop app), then try again.");
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    renderer.domElement.classList.add("view3d-canvas");
    host.prepend(renderer.domElement); // under the bar, hint and inset label

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 100000);
    camera.layers.enableAll();
    const front = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
    front.layers.set(0); // the inset shows the parts only: no bones, outlines or grid
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;

    // Light for the bones (the parts are unlit, like the 2D view): a key light that follows the camera, from a little
    // above and to the side, so the bones' facets read from any angle.
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.layers.set(1);
    const fill = new THREE.AmbientLight(0xffffff, 0.8);
    fill.layers.set(1);
    scene.add(sun, sun.target, fill);

    const grid = new THREE.GridHelper(4000, 40, 0x4a5060, 0x2c313b);
    grid.layers.set(1);
    scene.add(grid);

    // ---- parts: one mesh per draw item, updated every frame from the posed skeleton ----
    const textures = new Map<string, THREE_NS.Texture>();
    const textureFor = (id: string): THREE_NS.Texture | null => {
      const hit = textures.get(id);
      if (hit) return hit;
      const asset = textureAssets(store.doc).find((a) => a.id === id);
      const img = asset ? (imageFor(asset) as (CanvasImageSource & { complete?: boolean; width?: number }) | null) : null;
      if (!img || (img as HTMLImageElement).complete === false || !(img as { width?: number }).width) return null;
      const t = new THREE.Texture(img as THREE_NS.Texture["image"]);
      t.flipY = false; // draw-item uvs run top-down, like the image
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      textures.set(id, t);
      return t;
    };
    interface PartMesh {
      mesh: THREE_NS.Mesh;
      geo: THREE_NS.BufferGeometry;
      mat: THREE_NS.MeshBasicMaterial;
      outline: THREE_NS.LineLoop;
    }
    const parts: PartMesh[] = [];
    const partSlot = new Map<THREE_NS.Object3D, string>();
    const getPart = (i: number): PartMesh => {
      let p = parts[i];
      if (!p) {
        const geo = new THREE.BufferGeometry();
        const mat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9aa3b2, transparent: true, opacity: 0.35, depthWrite: false }));
        outline.layers.set(1);
        scene.add(mesh, outline);
        p = { mesh, geo, mat, outline };
        parts[i] = p;
      }
      return p;
    };

    // ---- bones: solid octahedral bones and joint balls, re-built each frame ----
    const boneGeo = new THREE.BufferGeometry();
    const boneMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const boneMesh = new THREE.Mesh(boneGeo, boneMat);
    boneMesh.layers.set(1);
    boneMesh.renderOrder = 1000; // after the parts, which don't write depth, so bones are always on view
    const edgeGeo = new THREE.BufferGeometry();
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.55 }));
    edges.layers.set(1);
    edges.renderOrder = 1001;
    const ballGeo = new THREE.SphereGeometry(1, 12, 8);
    const MAX_JOINTS = 512;
    const balls = new THREE.InstancedMesh(ballGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_JOINTS);
    balls.layers.set(1);
    balls.renderOrder = 1002;
    scene.add(boneMesh, edges, balls);

    // ---- move gizmo on the selection: red X and green Y move it, blue Z moves it through the draw order ----
    const gizmo = new THREE.Group();
    gizmo.layers.set(1);
    gizmo.renderOrder = 2000;
    const AXES = { x: 0xff5d5d, y: 0x7bd88f, z: 0x5aa9ff } as const;
    type Axis = keyof typeof AXES;
    const handles: Record<Axis, { group: THREE_NS.Group; mats: THREE_NS.MeshBasicMaterial[]; hit: THREE_NS.Mesh }> = {} as never;
    for (const axis of ["x", "y", "z"] as Axis[]) {
      const group = new THREE.Group();
      const mat = () => new THREE.MeshBasicMaterial({ color: AXES[axis], depthTest: false, transparent: true });
      const mats = [mat(), mat()];
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.8, 8), mats[0]);
      shaft.position.y = 0.4;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 16), mats[1]);
      head.position.y = 0.9;
      // A fatter invisible cylinder, so the thin arrow is easy to grab.
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.05, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.52;
      for (const m of [shaft, head, hit]) {
        m.layers.set(1);
        m.renderOrder = 2000;
        group.add(m);
      }
      if (axis === "x") group.rotation.z = -Math.PI / 2;
      if (axis === "z") group.rotation.x = Math.PI / 2;
      gizmo.add(group);
      handles[axis] = { group, mats, hit };
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    hub.layers.set(1);
    hub.renderOrder = 2001;
    gizmo.add(hub);
    gizmo.traverse((o) => o.layers.set(1));
    gizmo.visible = false;
    scene.add(gizmo);
    /** What the gizmo is on, from the last update: the selection's centre and whether X/Y may move it. */
    let gz: { kind: "slot" | "bone"; ids: string[]; pos: THREE_NS.Vector3; moveXY: boolean; moveZ: boolean } | null = null;
    /** An X/Y gizmo drag: world-space offset of the selection while dragging (previewed, committed on release). */
    let gzDrag: { axis: "x" | "y"; kind: "slot" | "bone"; ids: string[]; x0: number; y0: number; s: [number, number]; amount: number } | null = null;
    const boneOf = new Map<number, string>(); // triangle index → bone id, for picking

    const BLEND: Record<string, THREE_NS.Blending> = {
      normal: THREE.NormalBlending,
      additive: THREE.AdditiveBlending,
      multiply: THREE.MultiplyBlending,
      screen: THREE.AdditiveBlending,
    };

    // Draw order of the parts on show (slot ids, back to front), and a part being dragged through the stack.
    let stack: string[] = [];
    let dragPart: { ids: string[]; from: number; steps: number; x0: number; y0: number; v: [number, number]; moved: boolean } | null = null;

    // Bounds of the character (scenery that spans the artboard is left out, as in the order view), for framing.
    let bounds = { minX: -200, maxX: 200, minY: 0, maxY: 400, depth: 300 };
    const tmpM = new THREE.Matrix4();
    const tmpC = new THREE.Color();

    function update(sk: Skeleton) {
      const docW0 = store.doc.width;
      const wide = (v: Float32Array) => {
        let x0 = Infinity;
        let x1 = -Infinity;
        for (let k = 0; k < v.length; k += 2) {
          x0 = Math.min(x0, v[k]);
          x1 = Math.max(x1, v[k]);
        }
        return x1 - x0 > docW0 * 0.8;
      };
      // Scenery (parts spanning the artboard) can be hidden, so orbiting round the character isn't blocked by it.
      const items = [...sk.drawList()].filter((it) => eyeOpacity(it.slot.data.id) > 0 && it.vertices.length >= 6 && it.indices.length >= 3 && (scenery() || !wide(it.vertices)));
      // One depth step per drawn slot, in draw order (a slot with several items keeps one depth).
      const slotDepth = new Map<string, number>();
      for (const it of items) if (!slotDepth.has(it.slot.data.id)) slotDepth.set(it.slot.data.id, slotDepth.size);
      const step = depth();
      const n = slotDepth.size;
      stack = [...slotDepth.keys()];
      // A dragged part previews at its new depth (half a step past the part it would land next to).
      const zOf = (slotId: string) => {
        const base = ((slotDepth.get(slotId) ?? 0) - (n - 1) / 2) * step;
        return dragPart?.ids.includes(slotId) && dragPart.steps ? base + (dragPart.steps + 0.5 * Math.sign(dragPart.steps)) * step : base;
      };
      // Transparent planes don't sort by distance well (a big background's centre can be nearer than a small part):
      // draw them in the draw order, reversed when the camera looks from behind.
      const fromBehind = camera.position.z < controls.target.z;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const sel = selection();
      const docW = store.doc.width;
      const selSlots = new Set(selectedSlotIds());
      const selected0 = (id: string) => selSlots.has(id);
      const sb: { box: { x0: number; x1: number; y0: number; y1: number; z: number } | null } = { box: null };
      partSlot.clear();
      items.forEach((it: DrawItem, i) => {
        const p = getPart(i);
        const order = slotDepth.get(it.slot.data.id) ?? 0;
        const z = zOf(it.slot.data.id);
        const v = it.vertices;
        const pos = new Float32Array((v.length / 2) * 3);
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        const moving = gzDrag?.kind === "slot" && gzDrag.ids.includes(it.slot.data.id);
        const ox = moving && gzDrag!.axis === "x" ? gzDrag!.amount : 0;
        const oy = moving && gzDrag!.axis === "y" ? gzDrag!.amount : 0;
        for (let k = 0, j = 0; k < v.length; k += 2, j += 3) {
          pos[j] = v[k] + ox;
          pos[j + 1] = v[k + 1] + oy;
          pos[j + 2] = z;
          x0 = Math.min(x0, v[k] + ox);
          x1 = Math.max(x1, v[k] + ox);
          y0 = Math.min(y0, v[k + 1] + oy);
          y1 = Math.max(y1, v[k + 1] + oy);
        }
        if (selected0(it.slot.data.id)) {
          const g = sb.box ?? { x0, x1, y0, y1, z };
          sb.box = { x0: Math.min(g.x0, x0), x1: Math.max(g.x1, x1), y0: Math.min(g.y0, y0), y1: Math.max(g.y1, y1), z };
        }
        if (x1 - x0 <= docW * 0.8) {
          minX = Math.min(minX, x0);
          maxX = Math.max(maxX, x1);
          minY = Math.min(minY, y0);
          maxY = Math.max(maxY, y1);
        }
        p.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        p.geo.setAttribute("uv", new THREE.BufferAttribute(it.uvs.slice(), 2));
        p.geo.setIndex(new THREE.BufferAttribute(it.indices.slice(), 1));
        p.geo.computeBoundingSphere();
        const tex = it.texture ?? it.image;
        const map = tex ? textureFor(tex.id) : null;
        if (p.mat.map !== map) {
          p.mat.map = map;
          p.mat.needsUpdate = true;
        }
        const c = it.color;
        p.mat.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
        p.mat.opacity = c[3];
        p.mat.blending = BLEND[it.blend] ?? THREE.NormalBlending;
        p.mesh.userData.order = order;
        p.mesh.renderOrder = fromBehind ? n - order : order;
        p.mesh.visible = !!map || !tex; // wait for an image to load rather than flash a white quad
        partSlot.set(p.mesh, it.slot.data.id);
        const selected = selSlots.has(it.slot.data.id);
        p.outline.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), 3));
        const om = p.outline.material as THREE_NS.LineBasicMaterial;
        om.color.set(selected ? 0xffcc00 : 0x9aa3b2);
        om.opacity = selected ? 1 : 0.35;
        p.outline.visible = outlines() || selected;
      });
      for (let i = items.length; i < parts.length; i++) {
        parts[i].mesh.visible = false;
        parts[i].outline.visible = false;
      }

      // ---- bones: each at the depth of the first part it carries (else its parent's) ----
      const boneZ = new Map<Bone, number>();
      for (const it of items) if (!boneZ.has(it.slot.bone)) boneZ.set(it.slot.bone, zOf(it.slot.data.id));
      const zFor = (b: Bone): number => {
        const known = boneZ.get(b);
        if (known !== undefined) return known;
        const z = b.parent ? zFor(b.parent) : 0;
        boneZ.set(b, z);
        return z;
      };
      const selBones = new Set(selectedBoneIds());
      const pos: number[] = [];
      const col: number[] = [];
      const edge: number[] = [];
      boneOf.clear();
      let joints = 0;
      // A Blender-style bone: head → a ring of four points at 15% of the length → tail. Its width follows its
      // length, so long bones read as heavier; zero-length bones are just a joint.
      const addBone = (b: Bone, z: number) => {
        const L = b.data.length;
        const w = b.world;
        const hx = w.x;
        const hy = w.y;
        if (L > 0.5) {
          const tx = w.x + w.a * L;
          const ty = w.y + w.c * L;
          const dx = tx - hx;
          const dy = ty - hy;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const r = Math.max(1.5, Math.min(len * 0.12, 9));
          const mx = hx + dx * 0.15;
          const my = hy + dy * 0.15;
          // Ring: perpendicular in the plane (±n) and along the depth axis (±z).
          const ring: [number, number, number][] = [
            [mx - uy * r, my + ux * r, z],
            [mx, my, z + r],
            [mx + uy * r, my - ux * r, z],
            [mx, my, z - r],
          ];
          const head: [number, number, number] = [hx, hy, z];
          const tail: [number, number, number] = [tx, ty, z];
          tmpC.set(selBones.has(b.data.id) ? "#ffcc00" : (b.data.color ?? "#8fd3ff"));
          const tri = (a: number[], b2: number[], c2: number[]) => {
            pos.push(...a, ...b2, ...c2);
            for (let k = 0; k < 3; k++) col.push(tmpC.r, tmpC.g, tmpC.b);
            boneOf.set(pos.length / 9 - 1, b.data.id);
          };
          for (let k = 0; k < 4; k++) {
            const p0 = ring[k];
            const p1 = ring[(k + 1) % 4];
            tri(head, p1, p0);
            tri(p0, p1, tail);
            edge.push(...head, ...p0, ...p0, ...tail, ...p0, ...p1);
          }
        }
        if (joints < MAX_JOINTS) {
          const s = Math.max(2, Math.min((L || 20) * 0.07, 6));
          tmpM.makeScale(s, s, s).setPosition(hx, hy, z);
          balls.setMatrixAt(joints, tmpM);
          balls.setColorAt(joints, tmpC.set(selBones.has(b.data.id) ? "#ffcc00" : "#ffffff"));
          joints++;
        }
      };
      for (const b of sk.bones) if (b.active) addBone(b, zFor(b));
      boneGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      boneGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
      boneGeo.computeVertexNormals();
      boneGeo.computeBoundingSphere();
      edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(edge), 3));
      balls.count = joints;
      balls.instanceMatrix.needsUpdate = true;
      if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
      boneMesh.visible = edges.visible = balls.visible = bonesOn();
      // Gizmo target: a selected part (its centre on its plane) or a selected bone (its joint).
      gz = null;
      const selBox = sb.box;
      if (sel?.kind === "slot" && selBox) {
        // Every selected part shown: X/Y only when all of them can move that way (images, shapes, text, points).
        const ids = [...selSlots].filter((id) => slotDepth.has(id));
        const movable = ids.every((id) => {
          const slot = sk.slots.find((x) => x.data.id === id);
          const att = slot ? sk.getAttachment(slot) : null;
          return !!att && ["region", "sequence", "shape", "point", "text"].includes(att.type);
        });
        const zs = ids.map((id) => zOf(id));
        const zc = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : selBox.z;
        gz = { kind: "slot", ids, pos: new THREE.Vector3((selBox.x0 + selBox.x1) / 2, (selBox.y0 + selBox.y1) / 2, zc), moveXY: movable && mode() === "setup", moveZ: true };
      } else if (sel?.kind === "bone" && selBones.size) {
        const bones = sk.bones.filter((x) => x.active && selBones.has(x.data.id));
        if (bones.length) {
          const dx = gzDrag?.kind === "bone" && gzDrag.axis === "x" ? gzDrag.amount : 0;
          const dy = gzDrag?.kind === "bone" && gzDrag.axis === "y" ? gzDrag.amount : 0;
          const avg = (f: (b: Bone) => number) => bones.reduce((a, b) => a + f(b), 0) / bones.length;
          gz = { kind: "bone", ids: bones.map((b) => b.data.id), pos: new THREE.Vector3(avg((b) => b.world.x) + dx, avg((b) => b.world.y) + dy, avg(zFor)), moveXY: true, moveZ: false };
        }
      }
      if (minX < maxX) bounds = { minX, maxX, minY, maxY, depth: Math.max(1, n - 1) * step };
    }

    // ---- camera: a three-quarter view framing the character ----
    const fit = () => {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const size = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.depth);
      const dist = (size / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.35;
      const yaw = (-40 * Math.PI) / 180;
      const pitch = (16 * Math.PI) / 180;
      controls.target.set(cx, cy, 0);
      camera.position.set(cx + dist * Math.sin(yaw) * Math.cos(pitch), cy + dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch));
      camera.near = dist / 200;
      camera.far = dist * 40;
      camera.updateProjectionMatrix();
      controls.update();
    };
    refit = fit;

    // ---- picking: press a part to select it and drag it through the stack; Alt+click picks the bone under it; ----
    // ---- press empty space to orbit. ----
    const ray = new THREE.Raycaster();
    ray.layers.enableAll();
    const aim = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    };
    const pickBone = () => {
      if (!bonesOn()) return undefined;
      const hit = ray.intersectObject(boneMesh)[0];
      const id = hit?.faceIndex != null ? boneOf.get(hit.faceIndex) : undefined;
      return id && !boneLocked(id) ? id : undefined;
    };
    const pickPart = () => {
      // Locked parts (Skeleton tree lock) can't be picked; the ray goes on to the part behind.
      const hits = ray.intersectObjects(parts.map((p) => p.mesh).filter((m) => m.visible)).filter((h) => !slotLocked(partSlot.get(h.object) ?? ""));
      // The front-most part under the pointer, by draw order (planes are close together in depth).
      const best = hits.sort((a, b) => (b.object.userData.order as number) - (a.object.userData.order as number))[0];
      const id = best ? partSlot.get(best.object) : undefined;
      return id && best ? { id, point: best.point } : undefined;
    };
    /** Screen pixels the pointer travels per layer, at a point (the depth axis projected onto the screen). */
    const depthAxis = (pt: THREE_NS.Vector3): [number, number] => {
      const r = renderer.domElement.getBoundingClientRect();
      const a = pt.clone().project(camera);
      const b = pt.clone().add(new THREE.Vector3(0, 0, depth() || 1)).project(camera);
      return [((b.x - a.x) * r.width) / 2, (-(b.y - a.y) * r.height) / 2];
    };
    let downAt: [number, number] | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.target !== renderer.domElement) return; // the bar's controls, not the scene
      downAt = [e.clientX, e.clientY];
      if (e.button !== 0) return;
      aim(e);
      const adding = e.shiftKey || e.ctrlKey || e.metaKey;
      if (e.altKey) {
        const bone = pickBone();
        if (bone) {
          if (adding) toggleInSelection("bone", bone, e);
          else {
            setMultiBones([]);
            setMultiSlots([]);
            setSelection({ kind: "bone", id: bone });
          }
          controls.enabled = false;
        }
        return;
      }
      // The gizmo's arrows come first: they sit on top of the selection.
      if (gz) {
        const live = (["x", "y", "z"] as const).filter((a) => handles[a].group.visible);
        const hit = ray.intersectObjects(live.map((a) => handles[a].hit))[0];
        const axis = hit ? live.find((a) => handles[a].hit === hit.object) : undefined;
        if (axis === "z" && gz.kind === "slot") {
          const from = Math.max(...gz.ids.map((id) => stack.indexOf(id)));
          const v = depthAxis(gz.pos);
          if (from >= 0 && Math.hypot(v[0], v[1]) >= 2) {
            controls.enabled = false;
            dragPart = { ids: gz.ids, from, steps: 0, x0: e.clientX, y0: e.clientY, v, moved: false };
            window.addEventListener("pointermove", onDragMove);
          } else toast("Turn the view a little to drag along depth (Z)", "info");
          return;
        }
        if (axis === "x" || axis === "y") {
          const r = renderer.domElement.getBoundingClientRect();
          const a = gz.pos.clone().project(camera);
          const b = gz.pos.clone().add(new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, 0)).project(camera);
          const sv: [number, number] = [((b.x - a.x) * r.width) / 2, (-(b.y - a.y) * r.height) / 2];
          if (Math.hypot(sv[0], sv[1]) < 1e-4) return;
          controls.enabled = false;
          gzDrag = { axis, kind: gz.kind, ids: gz.ids, x0: e.clientX, y0: e.clientY, s: sv, amount: 0 };
          window.addEventListener("pointermove", onGizmoMove);
          return;
        }
      }
      const part = pickPart();
      if (!part) return; // empty space: orbit
      if (adding) {
        // Shift-click adds the part to the selection (or removes it), Ctrl/⌘-click removes; no drag.
        toggleInSelection("slot", part.id, e);
        controls.enabled = false;
        return;
      }
      // Pressing a part already in a multi-selection drags the whole group; any other part replaces the selection.
      const group = selectedSlotIds();
      const ids = group.length > 1 && group.includes(part.id) ? group : [part.id];
      if (ids.length === 1) {
        setMultiBones([]);
        setMultiSlots([]);
      }
      setSelection({ kind: "slot", id: part.id });
      const from = stack.indexOf(part.id);
      const v = depthAxis(part.point);
      // Too edge-on to drag in depth (looking straight at the stack): select only, and let the view orbit.
      if (from < 0 || Math.hypot(v[0], v[1]) < 2) return;
      controls.enabled = false; // this press drags the part, not the camera
      dragPart = { ids, from, steps: 0, x0: e.clientX, y0: e.clientY, v, moved: false };
      window.addEventListener("pointermove", onDragMove);
    };
    const onDragMove = (e: PointerEvent) => {
      if (!dragPart) return;
      const dx = e.clientX - dragPart.x0;
      const dy = e.clientY - dragPart.y0;
      if (Math.hypot(dx, dy) > 3) dragPart.moved = true;
      const [vx, vy] = dragPart.v;
      const layers = (dx * vx + dy * vy) / (vx * vx + vy * vy);
      // A group can travel until its back-most part reaches the back, or its front-most the front.
      const idx = dragPart.ids.map((id) => stack.indexOf(id)).filter((i) => i >= 0);
      const lo = idx.length ? -Math.min(...idx) : -dragPart.from;
      const hi = idx.length ? stack.length - 1 - Math.max(...idx) : stack.length - 1 - dragPart.from;
      dragPart.steps = Math.max(lo, Math.min(hi, Math.round(layers)));
    };
    /**
     * Move parts `steps` places through the stack of parts on show (+ = towards the front), as one undoable edit.
     * Parts move one at a time, front-most first when moving forward, so a group keeps its own order.
     */
    const moveInStack = (ids: string[], steps: number) => {
      const slots = () => store.doc.skeleton.slots;
      const idx = (id: string) => slots().findIndex((x) => x.id === id);
      const order = [...ids].sort((a, b) => (steps > 0 ? idx(b) - idx(a) : idx(a) - idx(b)));
      const names = ids.map((id) => slots().find((x) => x.id === id)?.name ?? id);
      transaction(ids.length > 1 ? `Move ${ids.length} parts in the draw order` : "Move in the draw order", () => {
        for (const id of order) {
          const shown = [...stack].sort((a, b) => idx(a) - idx(b));
          const from = shown.indexOf(id);
          const to = Math.max(0, Math.min(shown.length - 1, from + steps));
          if (from < 0 || to === from) continue;
          // updateSlot's index is the final position: the target's index lands just in front of it (forward) or
          // just behind it (back), as in the order view.
          apply("updateSlot", { slot: id, index: idx(shown[to]) });
        }
      });
      toast(`${names.length > 1 ? `${names.length} parts` : names[0]} moved ${steps > 0 ? "forward" : "back"} ${Math.abs(steps)} place${Math.abs(steps) > 1 ? "s" : ""}`, "info");
    };
    const onGizmoMove = (e: PointerEvent) => {
      if (!gzDrag) return;
      const dx = e.clientX - gzDrag.x0;
      const dy = e.clientY - gzDrag.y0;
      const [sx, sy] = gzDrag.s;
      gzDrag.amount = (dx * sx + dy * sy) / (sx * sx + sy * sy); // world units along the axis
      if (e.shiftKey) gzDrag.amount = Math.round(gzDrag.amount / 10) * 10; // Shift: 10 px steps
    };
    /** Commit an X/Y gizmo drag: the world offset turned into the part's (or bone's) own coordinates. */
    const commitMove = (d: NonNullable<typeof gzDrag>) => {
      const sk = viewportApi.skeleton?.();
      if (!sk || Math.abs(d.amount) < 0.01) return;
      const wx = d.axis === "x" ? d.amount : 0;
      const wy = d.axis === "y" ? d.amount : 0;
      const local = (m: { a: number; b: number; c: number; d: number; x: number; y: number }) => {
        const iv = invert(m);
        return [iv.a * wx + iv.b * wy, iv.c * wx + iv.d * wy] as const;
      };
      const r2 = (n: number) => Math.round(n * 100) / 100;
      transaction(d.ids.length > 1 ? `Move ${d.ids.length} ${d.kind === "slot" ? "parts" : "bones"}` : "Move", () => {
        if (d.kind === "slot") {
          for (const id of d.ids) {
            const slot = sk.slots.find((x) => x.data.id === id);
            const att = slot ? sk.getAttachment(slot) : null;
            if (!slot || !att || !("x" in att)) continue;
            const [lx, ly] = local(slot.bone.world);
            commitAttachmentMove(id, att.name, r2((att as { x: number }).x + lx), r2((att as { y: number }).y + ly));
          }
        } else {
          // A bone whose ancestor is also selected already moves with it.
          const set = new Set(d.ids);
          for (const id of d.ids) {
            const b = sk.bones.find((x) => x.data.id === id);
            if (!b) continue;
            let p = b.parent;
            let inherited = false;
            while (p) {
              if (set.has(p.data.id)) inherited = true;
              p = p.parent;
            }
            if (inherited) continue;
            const [lx, ly] = b.parent ? local(b.parent.world) : [wx, wy];
            commitBone(id, { x: r2(b.x + lx), y: r2(b.y + ly) });
          }
        }
      });
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointermove", onGizmoMove);
      controls.enabled = true;
      if (gzDrag) {
        const g = gzDrag;
        gzDrag = null;
        commitMove(g);
        return;
      }
      const d = dragPart;
      dragPart = null;
      if (d) {
        if (d.steps) moveInStack(d.ids, d.steps);
        return;
      }
      // A click on empty space (not the end of an orbit drag) clears the selection.
      if (!e.altKey && downAt && e.button === 0 && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) <= 4) {
        aim(e);
        if (!pickPart() && !pickBone()) {
          setMultiBones([]);
          setMultiSlots([]);
          setSelection(null);
        }
      }
    };
    // Capture phase on the host: decide before the orbit controls (listening on the canvas) start a rotation.
    host.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointerup", onUp);

    let raf = 0;
    let fitted = false;
    const bg = new THREE.Color();
    const size = new THREE.Vector2();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.getSize(size);
      if (size.x !== w || size.y !== h) {
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      const sk = viewportApi.skeleton?.();
      if (sk) update(sk);
      if (!fitted && sk) {
        fit();
        fitted = true;
      }
      controls.update();
      const off = new THREE.Vector3().subVectors(camera.position, controls.target);
      const side = new THREE.Vector3().crossVectors(off, camera.up).normalize().multiplyScalar(off.length() * 0.4);
      sun.position.copy(camera.position).add(side).addScaledVector(camera.up, off.length() * 0.5);
      sun.target.position.copy(controls.target);
      gizmo.visible = !!gz;
      if (gz) {
        gizmo.position.copy(gz.pos);
        gizmo.scale.setScalar(camera.position.distanceTo(gz.pos) * 0.11); // constant size on screen
        handles.x.group.visible = handles.y.group.visible = gz.moveXY;
        handles.z.group.visible = gz.moveZ;
        const active = gzDrag?.axis ?? (dragPart && gz.kind === "slot" ? "z" : null);
        for (const a of ["x", "y", "z"] as const) for (const m of handles[a].mats) m.opacity = active && active !== a ? 0.35 : 1;
      }
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.setClearColor(0x1b1e24, 1);
      renderer.clear();
      grid.position.set((bounds.minX + bounds.maxX) / 2, bounds.minY, 0);
      renderer.render(scene, camera);
      // Inset: the normal front view of the artboard.
      const d = store.doc;
      const iw = Math.min(260, Math.round(w * 0.28));
      const ih = Math.round((iw * d.height) / d.width);
      const ix = w - iw - 12;
      const iy = 12;
      front.left = -d.originX;
      front.right = d.width - d.originX;
      front.top = d.originY;
      front.bottom = d.originY - d.height;
      front.position.set(0, 0, 50000);
      front.lookAt(0, 0, 0);
      front.updateProjectionMatrix();
      for (const p of parts) p.mesh.renderOrder = (p.mesh.userData.order as number) ?? 0; // front view: plain draw order
      renderer.setScissorTest(true);
      renderer.setScissor(ix, iy, iw, ih);
      renderer.setViewport(ix, iy, iw, ih);
      bg.set(d.background ?? "#20242c");
      renderer.setClearColor(bg, 1);
      renderer.clear();
      renderer.render(scene, front);
      renderer.setScissorTest(false);
    };
    raf = requestAnimationFrame(frame);
    setReady(true);

    stop = () => {
      cancelAnimationFrame(raf);
      host.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointermove", onGizmoMove);
      controls.dispose();
      for (const p of parts) {
        p.geo.dispose();
        p.mat.dispose();
        p.outline.geometry.dispose();
        (p.outline.material as THREE_NS.Material).dispose();
      }
      boneGeo.dispose();
      edgeGeo.dispose();
      ballGeo.dispose();
      boneMat.dispose();
      for (const t of textures.values()) t.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  });

  onCleanup(() => {
    disposed = true;
    stop();
  });

  return (
    <div class="view3d" ref={host} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <Show when={!ready()}>
        <div class="view3d-loading">{failed() ?? "Loading 3D view…"}</div>
      </Show>
      <div class="view3d-bar">
        <span class="view3d-title">3D view</span>
        <label title="Space between layers">
          Depth <input type="range" min="0" max="60" step="1" value={depth()} onInput={(e) => setDepth(Number(e.currentTarget.value))} />
        </label>
        <label class="check">
          <input type="checkbox" checked={outlines()} onChange={(e) => setOutlines(e.currentTarget.checked)} /> Outlines
        </label>
        <label class="check">
          <input type="checkbox" checked={bonesOn()} onChange={(e) => setBonesOn(e.currentTarget.checked)} /> Bones
        </label>
        <label class="check" title="Show the layers that span the artboard (backgrounds)">
          <input type="checkbox" checked={scenery()} onChange={(e) => setScenery(e.currentTarget.checked)} /> Scenery
        </label>
        <button onClick={() => refit?.()} title="Back to the three-quarter view of the character">
          Reset view
        </button>
      </div>
      <div class="view3d-inset-label">Front</div>
      <div class="view3d-hint">
        arrows: move (red X, green Y) and draw order (blue Z) · Shift+click: add to selection · drag a part: draw order · drag empty space: orbit · right-drag: pan · wheel: zoom · Alt+click: select a bone · {kbd("edit.bringForward")} / {kbd("edit.sendBackward")}: forward / back · {kbd("view.3d")}: leave
      </div>
    </div>
  );
}
