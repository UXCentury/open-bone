import {
  type Affine,
  type Attachment,
  type BoneData,
  type Id,
  type ImageAsset,
  type OpenBoneDocument,
  type RGBA,
  type SkinData,
  type SlotData,
  DEG,
  RAD,
  apply,
  boneWorld,
  defaultSkin,
  identity,
  invert,
  parseHex,
  pointInPolygon,
  shapeOutline,
  triangulate,
  worldRotation,
} from "@openbone/core";

export class Bone {
  parent: Bone | null = null;
  children: Bone[] = [];
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  shearX = 0;
  shearY = 0;
  /** Rotation override written by IK for this frame. */
  ikRotation: number | null = null;
  world: Affine = identity();
  constructor(public data: BoneData) {
    this.setToSetupPose();
  }
  get name() {
    return this.data.name;
  }
  setToSetupPose() {
    const d = this.data;
    this.x = d.x;
    this.y = d.y;
    this.rotation = d.rotation;
    this.scaleX = d.scaleX;
    this.scaleY = d.scaleY;
    this.shearX = d.shearX;
    this.shearY = d.shearY;
    this.ikRotation = null;
  }
  updateWorld(root: Affine) {
    const local = {
      x: this.x,
      y: this.y,
      rotation: this.ikRotation ?? this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      shearX: this.shearX,
      shearY: this.shearY,
    };
    this.world = boneWorld(this.parent ? this.parent.world : root, local, this.parent ? this.data.inherit : "normal");
  }
  updateSubtree(root: Affine, includeSelf = true) {
    if (includeSelf) this.updateWorld(root);
    for (const c of this.children) c.updateSubtree(root);
  }
  get worldX() {
    return this.world.x;
  }
  get worldY() {
    return this.world.y;
  }
  get worldRotation() {
    return worldRotation(this.world);
  }
  /** World -> this bone's local space. */
  worldToLocal(x: number, y: number): [number, number] {
    return apply(invert(this.world), x, y);
  }
}

export class Slot {
  color: RGBA = [1, 1, 1, 1];
  attachmentName: string | null = null;
  /** Mesh deform offsets by attachment name. */
  deform = new Map<string, number[]>();
  constructor(
    public data: SlotData,
    public bone: Bone,
  ) {
    this.setToSetupPose();
  }
  get name() {
    return this.data.name;
  }
  setToSetupPose() {
    this.color = parseHex(this.data.color);
    this.attachmentName = this.data.attachment;
    this.deform.clear();
  }
}

export interface DrawItem {
  slot: Slot;
  attachment: Attachment;
  /** null = solid colour fill. */
  image: ImageAsset | null;
  vertices: Float32Array; // world x,y pairs
  uvs: Float32Array;
  indices: Uint16Array;
  color: RGBA;
  blend: SlotData["blend"];
  stroke?: { color: RGBA; width: number; outline: Float32Array };
}

export class Skeleton {
  bones: Bone[] = [];
  slots: Slot[] = [];
  drawOrder: Slot[] = [];
  skin: SkinData | null = null;
  ikMix = new Map<Id, number>();
  transformMix = new Map<Id, number>();
  /** Placement of the skeleton (applied to root bones). */
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  private boneById = new Map<Id, Bone>();
  private slotById = new Map<Id, Slot>();
  private images = new Map<Id, ImageAsset>();

  constructor(public doc: OpenBoneDocument) {
    for (const bd of doc.skeleton.bones) {
      const b = new Bone(bd);
      if (bd.parent) {
        b.parent = this.boneById.get(bd.parent) ?? null;
        b.parent?.children.push(b);
      }
      this.bones.push(b);
      this.boneById.set(bd.id, b);
    }
    for (const sd of doc.skeleton.slots) {
      const bone = this.boneById.get(sd.bone);
      if (!bone) continue;
      const s = new Slot(sd, bone);
      this.slots.push(s);
      this.slotById.set(sd.id, s);
    }
    for (const img of doc.images) this.images.set(img.id, img);
    this.setToSetupPose();
    this.updateWorldTransform();
  }

  findBone(ref: string): Bone | undefined {
    return this.boneById.get(ref) ?? this.bones.find((b) => b.data.name === ref);
  }
  findSlot(ref: string): Slot | undefined {
    return this.slotById.get(ref) ?? this.slots.find((s) => s.data.name === ref);
  }
  boneById_(id: Id) {
    return this.boneById.get(id);
  }
  slotById_(id: Id) {
    return this.slotById.get(id);
  }

  setSkin(ref: string | null) {
    this.skin = ref ? (this.doc.skeleton.skins.find((s) => s.id === ref || s.name === ref) ?? null) : null;
  }

  setToSetupPose() {
    for (const b of this.bones) b.setToSetupPose();
    for (const s of this.slots) s.setToSetupPose();
    this.drawOrder = this.slots.slice();
    this.ikMix.clear();
    this.transformMix.clear();
    for (const c of this.doc.skeleton.ik) this.ikMix.set(c.id, c.mix);
    for (const c of this.doc.skeleton.transform) this.transformMix.set(c.id, 1);
  }

  private get rootMatrix(): Affine {
    return { a: this.scaleX, b: 0, c: 0, d: this.scaleY, x: this.x, y: this.y };
  }

  updateWorldTransform() {
    const root = this.rootMatrix;
    for (const b of this.bones) {
      b.ikRotation = null;
      b.updateWorld(root);
    }
    for (const c of this.doc.skeleton.ik) this.applyIk(c.id, c.bones, c.target, this.ikMix.get(c.id) ?? c.mix, c.bendPositive);
    for (const c of this.doc.skeleton.transform) this.applyTransform(c);
  }

  private applyIk(_id: Id, boneIds: Id[], targetId: Id, mix: number, bendPositive: boolean) {
    if (mix <= 0) return;
    const target = this.boneById.get(targetId);
    const bones = boneIds.map((id) => this.boneById.get(id)).filter(Boolean) as Bone[];
    if (!target || bones.length === 0) return;
    const root = this.rootMatrix;
    const tx = target.world.x;
    const ty = target.world.y;
    if (bones.length === 1) {
      const b = bones[0];
      const pw = b.parent ? b.parent.world : root;
      const inv = invert(pw);
      const dx = tx - b.world.x;
      const dy = ty - b.world.y;
      const lx = inv.a * dx + inv.b * dy;
      const ly = inv.c * dx + inv.d * dy;
      const want = Math.atan2(ly, lx) * RAD - b.shearX;
      b.ikRotation = b.rotation + wrap(want - b.rotation) * mix;
      b.updateSubtree(root);
      return;
    }
    const [p, c] = bones;
    const det = (m: Affine) => Math.sign(m.a * m.d - m.b * m.c) || 1;
    const px = p.world.x;
    const py = p.world.y;
    const l1 = Math.hypot(c.world.x - px, c.world.y - py);
    const l2 = c.data.length * Math.hypot(c.world.a, c.world.c);
    let d = Math.hypot(tx - px, ty - py);
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
    const base = Math.atan2(ty - py, tx - px);
    const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d || 1);
    const a1 = base + (bendPositive ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, cosA)));
    // Rotate parent so its child origin points along a1.
    const curDir = Math.atan2(c.world.y - py, c.world.x - px);
    const sP = det(p.parent ? p.parent.world : root);
    const deltaP = wrap((a1 - curDir) * RAD) * sP;
    p.ikRotation = p.rotation + deltaP;
    p.updateSubtree(root);
    // Child aims from the elbow at the target.
    const ex = c.world.x;
    const ey = c.world.y;
    const want = Math.atan2(ty - ey, tx - ex) * RAD;
    const sC = det(p.world);
    const deltaC = wrap(want - c.worldRotation) * sC;
    p.ikRotation = p.rotation + deltaP * mix;
    c.ikRotation = c.rotation + deltaC * mix;
    p.updateWorld(root);
    c.updateSubtree(root);
    for (const sib of p.children) if (sib !== c) sib.updateSubtree(root);
  }

  private applyTransform(c: OpenBoneDocument["skeleton"]["transform"][number]) {
    const mixScale = (this.transformMix.get(c.id) ?? 1);
    const target = this.boneById.get(c.target);
    if (!target) return;
    const t = target.world;
    for (const id of c.bones) {
      const b = this.boneById.get(id);
      if (!b) continue;
      const w = b.world;
      if (c.mixRotate > 0) {
        const r = wrap(worldRotation(t) + c.offsetRotation - worldRotation(w)) * c.mixRotate * mixScale * DEG;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        const { a, b: bb, c: cc, d } = w;
        w.a = cos * a - sin * cc;
        w.b = cos * bb - sin * d;
        w.c = sin * a + cos * cc;
        w.d = sin * bb + cos * d;
      }
      if (c.mixTranslate > 0) {
        const [ox, oy] = apply(t, c.offsetX, c.offsetY);
        const m = c.mixTranslate * mixScale;
        w.x += (ox - w.x) * m;
        w.y += (oy - w.y) * m;
      }
      if (c.mixScale > 0) {
        const m = c.mixScale * mixScale;
        const sx = Math.hypot(w.a, w.c) || 1;
        const sy = Math.hypot(w.b, w.d) || 1;
        const k1 = (sx + (Math.hypot(t.a, t.c) - sx) * m) / sx;
        const k2 = (sy + (Math.hypot(t.b, t.d) - sy) * m) / sy;
        w.a *= k1;
        w.c *= k1;
        w.b *= k2;
        w.d *= k2;
      }
      b.updateSubtree(this.rootMatrix, false);
    }
  }

  getAttachment(slot: Slot, name: string | null = slot.attachmentName): Attachment | null {
    if (name == null) return null;
    const id = slot.data.id;
    return this.skin?.attachments[id]?.[name] ?? defaultSkin(this.doc).attachments[id]?.[name] ?? null;
  }

  /** World-space vertices of a slot's current mesh/region/bbox/shape attachment. */
  attachmentWorldVertices(slot: Slot, att: Attachment): Float32Array {
    const m = slot.bone.world;
    if (att.type === "region") {
      const hw = (att.width / 2) * att.scaleX;
      const hh = (att.height / 2) * att.scaleY;
      const cos = Math.cos(att.rotation * DEG);
      const sin = Math.sin(att.rotation * DEG);
      // TL, TR, BR, BL (y-up)
      const corners = [-hw, hh, hw, hh, hw, -hh, -hw, -hh];
      const out = new Float32Array(8);
      for (let i = 0; i < 8; i += 2) {
        const lx = att.x + corners[i] * cos - corners[i + 1] * sin;
        const ly = att.y + corners[i] * sin + corners[i + 1] * cos;
        out[i] = m.a * lx + m.b * ly + m.x;
        out[i + 1] = m.c * lx + m.d * ly + m.y;
      }
      return out;
    }
    if (att.type === "mesh") {
      const n = att.vertices.length / 2;
      const deform = slot.deform.get(att.name);
      const out = new Float32Array(n * 2);
      if (att.weights) {
        for (let v = 0; v < n; v++) {
          let wx = 0;
          let wy = 0;
          const dx = deform ? deform[v * 2] : 0;
          const dy = deform ? deform[v * 2 + 1] : 0;
          for (const inf of att.weights[v]) {
            const bm = this.boneById.get(inf.bone)?.world ?? m;
            const lx = inf.x + dx;
            const ly = inf.y + dy;
            wx += (bm.a * lx + bm.b * ly + bm.x) * inf.weight;
            wy += (bm.c * lx + bm.d * ly + bm.y) * inf.weight;
          }
          out[v * 2] = wx;
          out[v * 2 + 1] = wy;
        }
      } else {
        for (let v = 0; v < n; v++) {
          const lx = att.vertices[v * 2] + (deform ? deform[v * 2] : 0);
          const ly = att.vertices[v * 2 + 1] + (deform ? deform[v * 2 + 1] : 0);
          out[v * 2] = m.a * lx + m.b * ly + m.x;
          out[v * 2 + 1] = m.c * lx + m.d * ly + m.y;
        }
      }
      return out;
    }
    const local = att.type === "shape" ? shapeOutline(att) : att.type === "boundingBox" ? att.vertices : [att.x, att.y];
    const out = new Float32Array(local.length);
    for (let i = 0; i < local.length; i += 2) {
      out[i] = m.a * local[i] + m.b * local[i + 1] + m.x;
      out[i + 1] = m.c * local[i] + m.d * local[i + 1] + m.y;
    }
    return out;
  }

  private shapeCache = new WeakMap<object, { key: string; indices: Uint16Array }>();

  /** Renderable geometry in draw order. */
  drawList(): DrawItem[] {
    const items: DrawItem[] = [];
    for (const slot of this.drawOrder) {
      const att = this.getAttachment(slot);
      if (!att) continue;
      if (att.type === "region" || att.type === "mesh") {
        const image = this.images.get(att.image) ?? null;
        const ac = parseHex(att.color);
        const color = mulColor(slot.color, ac);
        if (color[3] <= 0) continue;
        const vertices = this.attachmentWorldVertices(slot, att);
        const uvs = att.type === "region" ? REGION_UVS : new Float32Array(att.uvs);
        const indices = att.type === "region" ? REGION_INDICES : new Uint16Array(att.triangles);
        items.push({ slot, attachment: att, image, vertices, uvs, indices, color, blend: slot.data.blend });
      } else if (att.type === "shape") {
        const outline = this.attachmentWorldVertices(slot, att);
        const key = `${att.shape}|${att.width}|${att.height}|${att.radius}|${att.points?.join(",")}`;
        let cached = this.shapeCache.get(att);
        if (!cached || cached.key !== key) {
          cached = { key, indices: new Uint16Array(triangulate(shapeOutline(att))) };
          this.shapeCache.set(att, cached);
        }
        const color = mulColor(slot.color, parseHex(att.fill));
        items.push({
          slot,
          attachment: att,
          image: null,
          vertices: outline,
          uvs: new Float32Array(outline.length),
          indices: cached.indices,
          color,
          blend: slot.data.blend,
          ...(att.stroke && att.strokeWidth
            ? { stroke: { color: mulColor(slot.color, parseHex(att.stroke)), width: att.strokeWidth, outline } }
            : {}),
        });
      }
    }
    return items;
  }

  /** World polygon of the slot's bounding box: the active attachment if it is one, else the first bbox on the slot. */
  hitPolygon(slot: Slot): Float32Array | null {
    let att = this.getAttachment(slot);
    if (!att || att.type !== "boundingBox") {
      const all = { ...defaultSkin(this.doc).attachments[slot.data.id], ...(this.skin?.attachments[slot.data.id] ?? {}) };
      att = Object.values(all).find((a) => a.type === "boundingBox") ?? att;
    }
    if (!att) return null;
    if (att.type === "boundingBox" || att.type === "shape") return this.attachmentWorldVertices(slot, att);
    if (att.type === "region") return this.attachmentWorldVertices(slot, att);
    if (att.type === "mesh") {
      const v = this.attachmentWorldVertices(slot, att);
      return v.slice(0, att.hull * 2);
    }
    return null;
  }

  hitTest(slot: Slot, x: number, y: number): boolean {
    const poly = this.hitPolygon(slot);
    return !!poly && pointInPolygon(x, y, poly);
  }

  /** Axis-aligned bounds of everything drawn (world space). */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const it of this.drawList()) for (let i = 0; i < it.vertices.length; i += 2) add(it.vertices[i], it.vertices[i + 1]);
    for (const b of this.bones) {
      add(b.world.x, b.world.y);
      const [ex, ey] = apply(b.world, b.data.length, 0);
      add(ex, ey);
    }
    return { minX, minY, maxX, maxY };
  }
}

const REGION_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const REGION_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const mulColor = (a: RGBA, b: RGBA): RGBA => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];

function wrap(d: number) {
  d %= 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}
