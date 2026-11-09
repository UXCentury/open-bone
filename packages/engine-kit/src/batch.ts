import type { ClipRegion, DrawItem, TextDraw } from "@openbone/runtime";

export type BlendMode = DrawItem["blend"];

/**
 * One draw call's worth of geometry: consecutive draw items that share a texture, blend mode and clipping mask.
 * Built exactly the way `@openbone/render-webgl` batches (same split points, same vertex order), so an engine
 * that draws each batch as one indexed triangle list shows the same picture as the reference renderer.
 */
export interface Batch {
  /** Texture id to bind (image id, atlas page id or PARTICLE_DOT_TEXTURE); null = solid white. Unset for text. */
  texture: string | null;
  /** Set for text: the item to rasterise (see TextRasterizer); its quad is in `vertices`. */
  text?: { id: string; draw: TextDraw; item: DrawItem };
  blend: BlendMode;
  /** Clipping mask the batch is drawn inside (same object for consecutive batches under the same mask). */
  clip: ClipRegion | undefined;
  /** World x,y pairs in skeleton space (y-up). */
  vertices: Float32Array;
  /** Texture coordinates (0..1, v down). */
  uvs: Float32Array;
  /** Straight (not premultiplied) RGBA per vertex: the light colour of the two-colour tint. */
  colors: Float32Array;
  /**
   * Two-colour tint: dark RGB per vertex (what the image's black becomes), set only when an item in the batch has a
   * dark colour (others in it get 0, 0, 0 = plain multiply tint). Unset = draw the usual way, no extra attribute.
   * Shade as render-webgl does: rgb = dark + (light - dark) * texture rgb, alpha = texture alpha × light alpha.
   */
  dark?: Float32Array;
  indices: Uint16Array;
  /** The draw items in this batch, in order. */
  items: DrawItem[];
}

export interface BatchOptions {
  /** False for textures the engine could not load: they draw (and batch) as solid white, like render-webgl. */
  hasTexture?: (id: string) => boolean;
  /** Largest vertex count per batch (render-webgl: 16384, so indices fit in 16 bits). */
  maxVertices?: number;
  /** Largest index count per batch (render-webgl: 6 × 16384). */
  maxIndices?: number;
}

/** Padding (skeleton units) around a text box, so outlines and overhangs are not cut off (as in render-webgl). */
export const textPad = (t: TextDraw) => t.outlineWidth + t.size * 0.25;

/** Quad of a text item's texture: the box grown by `pad` (TL, TR, BR, BL in world space). */
export function textQuad(t: TextDraw, pad = textPad(t)): Float32Array {
  const m = t.matrix;
  const hw = t.width / 2 + pad;
  const hh = t.height / 2 + pad;
  const out = new Float32Array(8);
  const corners = [-hw, hh, hw, hh, hw, -hh, -hw, -hh];
  for (let i = 0; i < 8; i += 2) {
    out[i] = m.a * corners[i] + m.b * corners[i + 1] + m.x;
    out[i + 1] = m.c * corners[i] + m.d * corners[i + 1] + m.y;
  }
  return out;
}

/** Cache key of a text item's texture (per slot and attachment). */
export const textId = (it: DrawItem) => `${it.slot.data.id}/${it.attachment.name}`;

/** An item's dark colour (rgb), or null when it has none (unset or black: the same as a plain tint). */
export function darkOf(it: Pick<DrawItem, "dark">): readonly [number, number, number] | null {
  const d = it.dark;
  return d && (d[0] > 0 || d[1] > 0 || d[2] > 0) ? [d[0], d[1], d[2]] : null;
}

class Builder {
  verts: number[] = [];
  uvs: number[] = [];
  cols: number[] = [];
  /** Dark rgb per vertex, filled in only once an item with a dark colour arrives (zeros before it). */
  dark: number[] | null = null;
  idx: number[] = [];
  items: DrawItem[] = [];
  constructor(
    public texture: string | null,
    public blend: BlendMode,
    public clip: ClipRegion | undefined,
    public text?: Batch["text"],
  ) {}
  get nv() {
    return this.verts.length / 2;
  }
  push(it: DrawItem, vertices: Float32Array) {
    const n = vertices.length / 2;
    const base = this.nv;
    const [r, g, b, a] = it.color;
    const cols = it.colors;
    for (let i = 0; i < n; i++) {
      this.verts.push(vertices[i * 2], vertices[i * 2 + 1]);
      this.uvs.push(it.uvs[i * 2] ?? 0, it.uvs[i * 2 + 1] ?? 0);
      if (cols) this.cols.push(cols[i * 4], cols[i * 4 + 1], cols[i * 4 + 2], cols[i * 4 + 3]);
      else this.cols.push(r, g, b, a);
    }
    const d = darkOf(it);
    if (d && !this.dark) this.dark = new Array(base * 3).fill(0);
    if (this.dark) for (let i = 0; i < n; i++) d ? this.dark.push(d[0], d[1], d[2]) : this.dark.push(0, 0, 0);
    for (let i = 0; i < it.indices.length; i++) this.idx.push(base + it.indices[i]);
    this.items.push(it);
  }
  build(): Batch | null {
    if (!this.idx.length) return null;
    return {
      texture: this.texture,
      ...(this.text ? { text: this.text } : {}),
      blend: this.blend,
      clip: this.clip,
      vertices: new Float32Array(this.verts),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.cols),
      ...(this.dark ? { dark: new Float32Array(this.dark) } : {}),
      indices: new Uint16Array(this.idx),
      items: this.items,
    };
  }
}

/**
 * Group a skeleton's draw list into batches, splitting where render-webgl flushes: on a texture or blend change,
 * a clipping mask change, around every text item, and when a batch would exceed the vertex/index limits.
 */
export function buildBatches(items: DrawItem[], opts: BatchOptions = {}): Batch[] {
  const has = opts.hasTexture ?? (() => true);
  const maxV = opts.maxVertices ?? 16384;
  const maxI = opts.maxIndices ?? 6 * 16384;
  const out: Batch[] = [];
  let cur: Builder | null = null;
  let clip: ClipRegion | undefined;
  const close = () => {
    const b = cur?.build();
    if (b) out.push(b);
    cur = null;
  };
  for (const it of items) {
    if (it.clip !== clip) {
      close();
      clip = it.clip;
    }
    if (it.text) {
      close();
      const pad = textPad(it.text);
      cur = new Builder(null, it.blend, clip, { id: textId(it), draw: it.text, item: it });
      cur.push(it, textQuad(it.text, pad));
      close();
      continue;
    }
    const tex = it.texture && has(it.texture.id) ? it.texture.id : null;
    const builder: Builder | null = cur;
    if (!builder || builder.texture !== tex || builder.blend !== it.blend) {
      close();
      cur = new Builder(tex, it.blend, clip);
    } else if (builder.nv + it.vertices.length / 2 > maxV || builder.idx.length + it.indices.length > maxI) {
      close();
      cur = new Builder(tex, it.blend, clip);
    }
    cur!.push(it, it.vertices);
  }
  close();
  return out;
}

/**
 * Expand a batch's indexed triangles into a flat vertex list (for engines that batch unindexed triangles,
 * e.g. Phaser's MultiPipeline). Calls `vert(i)` with each vertex index in triangle order.
 */
export function forEachTriangleVertex(b: Pick<Batch, "indices">, vert: (i: number) => void) {
  for (let k = 0; k < b.indices.length; k++) vert(b.indices[k]);
}

/** Premultiply a straight RGBA colour (what most engines' tint uniforms and vertex colours expect). */
export const premultiply = (r: number, g: number, b: number, a: number): [number, number, number, number] => [r * a, g * a, b * a, a];

/** A run of a batch's items: either plain (no dark colour) or with one flat two-colour tint (see tintRuns). */
export interface TintRun {
  /** Vertex x,y pairs, texture coordinates and indices of the run (indices start at 0). */
  vertices: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  /**
   * Null for a plain run: draw it the usual way with `colors`. Otherwise the run's flat tint: every item has this
   * straight light colour (RGBA) and dark colour (RGB).
   */
  tint: { light: readonly [number, number, number, number]; dark: readonly [number, number, number] } | null;
  /** Straight RGBA per vertex (the batch's colours for these vertices). */
  colors: Float32Array;
  items: DrawItem[];
}

/**
 * Split a batch into runs for engines that cannot pass a second colour per vertex (CanvasKit draws each tinted
 * run with a colour-matrix filter): consecutive items without a dark colour stay together as one plain run, items
 * with one are grouped while their light and dark colours are equal. Draw order is unchanged. Items that colour
 * each vertex themselves (particles, which have no dark colour) are always plain.
 */
export function tintRuns(b: Batch): TintRun[] {
  type Tint = TintRun["tint"];
  const out: TintRun[] = [];
  const same = (x: Tint, y: Tint) =>
    x === y || (!!x && !!y && x.light.every((v, i) => v === y.light[i]) && x.dark.every((v, i) => v === y.dark[i]));
  let open = false;
  let tint: Tint = null;
  let first = 0; // first item, vertex and index of the open run
  let v0 = 0;
  let i0 = 0;
  let v = 0;
  let ix = 0;
  const close = (end: number) => {
    if (!open) return;
    const indices = new Uint16Array(ix - i0);
    for (let k = 0; k < indices.length; k++) indices[k] = b.indices[i0 + k] - v0;
    out.push({
      vertices: b.vertices.slice(v0 * 2, v * 2),
      uvs: b.uvs.slice(v0 * 2, v * 2),
      indices,
      tint,
      colors: b.colors.slice(v0 * 4, v * 4),
      items: b.items.slice(first, end),
    });
  };
  b.items.forEach((it, k) => {
    const d = it.colors ? null : darkOf(it);
    const next: Tint = d ? { light: [it.color[0], it.color[1], it.color[2], it.color[3]], dark: d } : null;
    if (!open || !same(tint, next)) {
      close(k);
      open = true;
      tint = next;
      first = k;
      v0 = v;
      i0 = ix;
    }
    // A text batch holds one item drawn as its quad (not the item's own geometry).
    v += b.text ? b.vertices.length / 2 : it.vertices.length / 2;
    ix += b.text ? b.indices.length : it.indices.length;
  });
  close(b.items.length);
  return out;
}

/**
 * The two-colour tint as a 4×5 colour matrix on straight (unpremultiplied) colours, row-major with the offsets in
 * 0..1 (Skia's ColorFilter.MakeMatrix): rgb = dark + (light - dark) × rgb, alpha = light alpha × alpha.
 */
export function tintMatrix(light: readonly number[], dark: readonly number[]): number[] {
  const [r, g, b, a] = light;
  const [dr, dg, db] = dark;
  // prettier-ignore
  return [
    r - dr, 0, 0, 0, dr,
    0, g - dg, 0, 0, dg,
    0, 0, b - db, 0, db,
    0, 0, 0, a, 0,
  ];
}
