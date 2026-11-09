import type { OpenBoneDocument } from "@openbone/core";
import {
  type Batch,
  type DriverOptions,
  type FetchOptions,
  type InputValue,
  OpenBoneDriver,
  type OpenBoneSource,
  TextRasterizer,
  buildBatches,
  loadDocument,
  loadTextures,
  particleDotPixels,
} from "@openbone/engine-kit";
import { type ClipRegion, PARTICLE_DOT_SIZE, PARTICLE_DOT_TEXTURE } from "@openbone/runtime";
import * as THREE from "three";

export type { DriverOptions, InputValue, OpenBoneSource } from "@openbone/engine-kit";

/** A loaded document and its textures (one THREE.Texture per image or atlas page), shareable by many objects. */
export interface OpenBoneAsset {
  doc: OpenBoneDocument;
  baseUrl: string;
  textures: Map<string, THREE.Texture>;
}

export interface LoadOptions extends FetchOptions {
  resolveImageUrl?: (src: string) => string;
  /** Generate mipmaps (default true: smoother when the object is small or seen at an angle). */
  mipmaps?: boolean;
}

/** Configure a texture the way OpenBone samples it: premultiplied on upload, v down, colours passed through. */
export function prepareTexture<T extends THREE.Texture>(t: T, mipmaps = true): T {
  t.premultiplyAlpha = true;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = mipmaps;
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Load a .obone / .obonb document and its images (atlas pages when packed) as Three.js textures. */
export async function loadOpenBone(src: OpenBoneSource, opts: LoadOptions = {}): Promise<OpenBoneAsset> {
  const { doc, baseUrl } = await loadDocument(src, opts);
  const images = await loadTextures(doc, baseUrl, { resolveImageUrl: opts.resolveImageUrl });
  const textures = new Map<string, THREE.Texture>();
  for (const [id, img] of images) textures.set(id, prepareTexture(new THREE.Texture(img), opts.mipmaps ?? true));
  return { doc, baseUrl, textures };
}

// DARK (materials of batches with a two-colour tint): rgb = dark + (light - dark) × texture rgb, on premultiplied
// texels, as render-webgl. Without it the dark attribute is neither declared nor uploaded.
const VERTEX = /* glsl */ `
attribute vec4 obColor;
varying vec2 vUv;
varying vec4 vColor;
#ifdef DARK
attribute vec3 obDark;
varying vec3 vDark;
#endif
void main() {
  vUv = uv;
  vColor = obColor;
#ifdef DARK
  vDark = obDark;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Same maths as render-webgl: premultiplied texture times straight vertex colour, output premultiplied.
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
varying vec4 vColor;
#ifdef DARK
varying vec3 vDark;
#endif
void main() {
  vec4 t = texture2D(map, vUv);
#ifdef DARK
  gl_FragColor = vec4(vDark * (t.a - t.rgb) + t.rgb * vColor.rgb, t.a) * vColor.a * opacity;
#else
  gl_FragColor = vec4(t.rgb * vColor.rgb, t.a) * vColor.a * opacity;
#endif
}`;

/** render-webgl's blend functions (premultiplied alpha), as Three.js factors. */
export const BLEND_FACTORS: Record<Batch["blend"], [THREE.BlendingSrcFactor, THREE.BlendingDstFactor]> = {
  normal: [THREE.OneFactor, THREE.OneMinusSrcAlphaFactor],
  additive: [THREE.OneFactor, THREE.OneFactor],
  multiply: [THREE.DstColorFactor, THREE.OneMinusSrcAlphaFactor],
  screen: [THREE.OneFactor, THREE.OneMinusSrcColorFactor],
};

export interface OpenBoneObjectOptions extends DriverOptions {
  /** Share a Three.js AudioListener's context for the document's sounds. */
  audioListener?: THREE.AudioListener;
  /** Test depth against the scene (default true); OpenBone never writes depth, draw order comes from renderOrder. */
  depthTest?: boolean;
  /** Pixels per skeleton unit to rasterise text at (default 2). */
  textResolution?: number;
}

let warned = false;
/** Clipping needs a stencil buffer, which WebGLRenderer no longer creates by default (r163+). */
function warnWithoutStencil(renderer: THREE.WebGLRenderer) {
  if (warned) return;
  const attrs = renderer.getContext().getContextAttributes?.();
  if (attrs && !attrs.stencil) {
    warned = true;
    console.warn("OpenBone: this document uses clipping masks; create the renderer with new THREE.WebGLRenderer({ stencil: true }).");
  }
}

/** Stencil reference values handed to clipping masks, shared by every object so masks never collide in a frame. */
let stencilRef = 0;
const nextStencilRef = () => (stencilRef = (stencilRef % 255) + 1);

type MaterialKind = { kind: "draw"; stencil: number; dark?: boolean } | { kind: "mask"; stencil: number };

/** A batch mesh whose buffers grow as needed and are re-filled each frame (no per-frame allocations). */
class BatchMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  private capV = 0;
  private capI = 0;
  /** True while the mesh holds a two-colour (dark) batch. */
  twoColor = false;
  constructor() {
    super(new THREE.BufferGeometry(), undefined as unknown as THREE.ShaderMaterial);
    this.frustumCulled = false;
  }
  private alloc(nv: number, ni: number) {
    if (nv <= this.capV && ni <= this.capI) return;
    this.geometry.dispose();
    this.capV = Math.max(64, 2 ** Math.ceil(Math.log2(nv)));
    this.capI = Math.max(96, 2 ** Math.ceil(Math.log2(ni)));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.capV * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.capV * 2), 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("obColor", new THREE.BufferAttribute(new Float32Array(this.capV * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(this.capI), 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = g;
  }
  /** The dark colour attribute, added the first time this mesh holds a dark batch (re-added after a grow). */
  private darkAttribute(): THREE.BufferAttribute {
    const g = this.geometry;
    let a = g.getAttribute("obDark") as THREE.BufferAttribute | undefined;
    if (!a) {
      a = new THREE.BufferAttribute(new Float32Array(this.capV * 3), 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("obDark", a);
    }
    return a;
  }
  /** Fill from x,y pairs (+ optional uvs / colours / dark colours). */
  fill(vertices: Float32Array, indices: Uint16Array, uvs?: Float32Array, colors?: Float32Array, dark?: Float32Array) {
    const nv = vertices.length / 2;
    this.alloc(nv, indices.length);
    const g = this.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    for (let i = 0; i < nv; i++) {
      p[i * 3] = vertices[i * 2];
      p[i * 3 + 1] = vertices[i * 2 + 1];
      p[i * 3 + 2] = 0;
    }
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const col = g.attributes.obColor as THREE.BufferAttribute;
    if (uvs) (uv.array as Float32Array).set(uvs);
    if (colors) (col.array as Float32Array).set(colors);
    else (col.array as Float32Array).fill(1, 0, nv * 4);
    (g.index!.array as Uint16Array).set(indices);
    for (const [a, n] of [
      [pos, nv * 3],
      [uv, nv * 2],
      [col, nv * 4],
      [g.index!, indices.length],
    ] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
    this.twoColor = !!dark;
    if (dark) {
      const d = this.darkAttribute();
      (d.array as Float32Array).set(dark);
      d.clearUpdateRanges();
      d.addUpdateRange(0, nv * 3);
      d.needsUpdate = true;
    }
    g.setDrawRange(0, indices.length);
  }
  /** Read back what is drawn: x, y, u, v, r, g, b, a, dark r, g, b per index (for tests and debugging). */
  drawnVertices(): number[][] {
    const g = this.geometry;
    const p = g.attributes.position.array;
    const uv = g.attributes.uv.array;
    const c = g.attributes.obColor.array;
    const d = this.twoColor ? g.attributes.obDark.array : null;
    const out: number[][] = [];
    const idx = g.index!.array;
    for (let k = 0; k < g.drawRange.count; k++) {
      const i = idx[k];
      out.push([p[i * 3], p[i * 3 + 1], uv[i * 2], uv[i * 2 + 1], c[i * 4], c[i * 4 + 1], c[i * 4 + 2], c[i * 4 + 3], d ? d[i * 3] : 0, d ? d[i * 3 + 1] : 0, d ? d[i * 3 + 2] : 0]);
    }
    return out;
  }
}

/**
 * An OpenBone document as a Three.js object: one Mesh per render-webgl batch, sharing one ShaderMaterial per
 * texture (atlas page) and blend mode, in the XY plane (skeleton units, y up). Draw order comes from renderOrder
 * (this is a Group, so it sorts as one unit against the rest of the scene). Clipping masks use the stencil buffer.
 */
export class OpenBoneObject3D extends THREE.Group {
  readonly driver: OpenBoneDriver;
  readonly asset: OpenBoneAsset;
  private meshes: BatchMesh[] = [];
  private masks: BatchMesh[] = [];
  private materials = new Map<string, THREE.ShaderMaterial>();
  private text = new TextRasterizer();
  private textTextures = new Map<string, { tex: THREE.Texture; version: number }>();
  private dot: THREE.DataTexture | null = null;
  private stencilRefs: number[] = [];
  private white: THREE.DataTexture;
  private depthTest: boolean;
  private textResolution: number;
  /** Opacity of the whole object (multiplies every slot). */
  opacity = 1;
  paused = false;
  /** Batches drawn by the last redraw. */
  drawCalls = 0;

  constructor(asset: OpenBoneAsset, driver: OpenBoneDriver, opts: OpenBoneObjectOptions = {}) {
    super();
    this.asset = asset;
    this.driver = driver;
    this.depthTest = opts.depthTest ?? true;
    this.textResolution = opts.textResolution ?? 2;
    this.white = prepareTexture(new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1), false);
    this.redraw();
  }

  /** Load a document (URL, bytes or parsed) and create the object; waits for images and the script sandbox. */
  static async from(src: OpenBoneSource | OpenBoneAsset, opts: OpenBoneObjectOptions & LoadOptions = {}): Promise<OpenBoneObject3D> {
    const asset = isAsset(src) ? src : await loadOpenBone(src, opts);
    const driver = await OpenBoneDriver.create(asset.doc, asset.baseUrl, { audioContext: opts.audioListener?.context, ...opts });
    return new OpenBoneObject3D(asset, driver, opts);
  }

  get instance() {
    return this.driver.instance;
  }
  get skeleton() {
    return this.driver.skeleton;
  }
  get stateMachine() {
    return this.driver.stateMachine;
  }
  get speed() {
    return this.driver.speed;
  }
  set speed(v: number) {
    this.driver.speed = v;
  }
  setInput(name: string, value: InputValue) {
    this.driver.setInput(name, value);
  }
  getInput(name: string) {
    return this.driver.getInput(name);
  }
  fire(name: string) {
    this.driver.fire(name);
  }
  setText(slot: string, text: string | null) {
    this.driver.setText(slot, text);
  }
  setSkin(name: string | null) {
    this.driver.setSkin(name);
    this.redraw();
  }
  play(animation: string, loop = true) {
    this.driver.play(animation, loop);
  }
  useStateMachine(name?: string) {
    return this.driver.useStateMachine(name);
  }
  /** Listen to "event", "stateChange" or "audio"; returns an unsubscribe function. */
  onOpenBone: OpenBoneDriver["on"] = (name, fn) => this.driver.on(name, fn);
  pause() {
    this.paused = true;
    this.driver.pause();
  }
  resume() {
    this.paused = false;
    this.driver.resume();
  }

  /** Advance by `dt` seconds and rebuild the meshes (call from your animation loop). */
  update(dt: number) {
    if (!this.paused) this.driver.advance(dt);
    this.redraw();
  }

  /** The artboard rectangle in local space (skeleton units, y up): x, y = bottom-left. */
  get artboard() {
    const d = this.asset.doc;
    return { x: -d.originX, y: d.originY - d.height, width: d.width, height: d.height };
  }

  private material(texture: THREE.Texture, blend: Batch["blend"], k: MaterialKind): THREE.ShaderMaterial {
    const dark = k.kind === "draw" && !!k.dark;
    const key = `${texture.uuid}|${blend}|${k.kind}|${k.stencil}${dark ? "|dark" : ""}`;
    let m = this.materials.get(key);
    if (m) {
      m.uniforms.opacity.value = this.opacity;
      return m;
    }
    const [src, dst] = BLEND_FACTORS[blend] ?? BLEND_FACTORS.normal;
    m = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, opacity: { value: this.opacity } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      ...(dark ? { defines: { DARK: "" } } : {}),
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: this.depthTest,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: src,
      blendDst: dst,
    });
    if (k.kind === "mask") {
      m.colorWrite = false;
      m.stencilWrite = true;
      m.stencilRef = k.stencil;
      m.stencilFunc = THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
    } else if (k.stencil) {
      m.stencilWrite = true;
      m.stencilWriteMask = 0;
      m.stencilRef = k.stencil;
      m.stencilFunc = THREE.EqualStencilFunc;
      m.stencilFail = m.stencilZFail = m.stencilZPass = THREE.KeepStencilOp;
    }
    this.materials.set(key, m);
    return m;
  }

  private textureFor(b: Batch): THREE.Texture {
    if (b.text) {
      const r = this.text.get(b.text.id, b.text.draw, this.textResolution);
      if (!r) return this.white;
      let e = this.textTextures.get(b.text.id);
      if (!e || e.version !== r.version) {
        if (e) this.dropTexture(e.tex);
        e = { tex: prepareTexture(new THREE.CanvasTexture(r.canvas as HTMLCanvasElement), false), version: r.version };
        this.textTextures.set(b.text.id, e);
      }
      return e.tex;
    }
    if (!b.texture) return this.white;
    if (b.texture === PARTICLE_DOT_TEXTURE) {
      this.dot ??= prepareTexture(new THREE.DataTexture(new Uint8Array(particleDotPixels(true).buffer), PARTICLE_DOT_SIZE, PARTICLE_DOT_SIZE), false);
      // Already premultiplied.
      this.dot.premultiplyAlpha = false;
      return this.dot;
    }
    return this.asset.textures.get(b.texture) ?? this.white;
  }

  private dropTexture(t: THREE.Texture) {
    for (const [k, m] of this.materials)
      if (m.uniforms.map.value === t) {
        m.dispose();
        this.materials.delete(k);
      }
    t.dispose();
  }

  /** Rebuild meshes from the current pose (call after changing the pose by hand). */
  redraw() {
    const tex = this.asset.textures;
    const batches = buildBatches(this.driver.instance.drawList(), { hasTexture: (id) => id === PARTICLE_DOT_TEXTURE || tex.has(id) });
    for (const id of this.text.nextFrame()) {
      const e = this.textTextures.get(id);
      if (e) this.dropTexture(e.tex);
      this.textTextures.delete(id);
    }
    let order = 0;
    let maskCount = 0;
    let clip: ClipRegion | undefined;
    let ref = 0;
    this.clear();
    batches.forEach((b, i) => {
      if (b.clip !== clip) {
        clip = b.clip;
        ref = 0;
        if (clip) {
          // Each clip run keeps its reference across frames, so its materials are reused.
          ref = this.stencilRefs[maskCount] ??= nextStencilRef();
          const mask = (this.masks[maskCount++] ??= new BatchMesh());
          mask.fill(clip.polygon, clip.indices);
          mask.material = this.material(this.white, "normal", { kind: "mask", stencil: ref });
          mask.renderOrder = order++;
          mask.onBeforeRender = warnWithoutStencil;
          this.add(mask);
        }
      }
      const mesh = (this.meshes[i] ??= new BatchMesh());
      mesh.fill(b.vertices, b.indices, b.uvs, b.colors, b.dark);
      mesh.material = this.material(this.textureFor(b), b.blend, { kind: "draw", stencil: ref, dark: !!b.dark });
      mesh.renderOrder = order++;
      this.add(mesh);
    });
    for (const m of this.meshes.splice(batches.length)) m.geometry.dispose();
    for (const m of this.masks.splice(maskCount)) m.geometry.dispose();
    this.drawCalls = batches.length;
  }

  /** The drawn meshes in order, with `mask` set for clipping-mask (stencil) meshes. */
  drawnMeshes(): { mask: boolean; vertices: number[][]; material: THREE.ShaderMaterial }[] {
    return (this.children as BatchMesh[]).map((m) => ({ mask: !m.material.colorWrite, vertices: m.drawnVertices(), material: m.material }));
  }

  /** Where a ray hits the object's plane, in skeleton space (y up); null when parallel or behind. */
  rayToSkeleton(ray: THREE.Ray): [number, number] | null {
    this.updateWorldMatrix(true, false);
    const inv = new THREE.Matrix4().copy(this.matrixWorld).invert();
    const local = ray.clone().applyMatrix4(inv);
    const hit = local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return hit ? [hit.x, hit.y] : null;
  }

  /** Send a pointer event along a ray (e.g. raycaster.ray) to the state machine; outside the artboard ends hovers. */
  pointer(type: "down" | "up" | "move", ray: THREE.Ray) {
    const p = this.rayToSkeleton(ray);
    const a = this.artboard;
    if (!p || p[0] < a.x || p[0] > a.x + a.width || p[1] < a.y || p[1] > a.y + a.height) {
      if (type === "move") this.driver.pointerLeave();
      return;
    }
    this.driver.pointer(type, p[0], p[1]);
  }

  /** Route a canvas's pointer events (raycast through `camera`) to the state machine. Returns an unbind function. */
  bindPointer(dom: HTMLElement, camera: THREE.Camera): () => void {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const send = (type: "down" | "up" | "move") => (e: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      this.pointer(type, raycaster.ray);
    };
    const down = send("down");
    const up = send("up");
    const move = send("move");
    const leave = () => this.driver.pointerLeave();
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerleave", leave);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerleave", leave);
    };
  }

  /** Free GPU resources (textures of the asset are kept: they may be shared). */
  dispose() {
    this.driver.dispose();
    for (const m of [...this.meshes, ...this.masks]) m.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const e of this.textTextures.values()) e.tex.dispose();
    this.dot?.dispose();
    this.white.dispose();
    this.materials.clear();
    this.clear();
  }
}

function isAsset(x: unknown): x is OpenBoneAsset {
  return !!x && typeof x === "object" && "textures" in x && "doc" in x;
}
