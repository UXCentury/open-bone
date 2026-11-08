import { type AtlasData, type AtlasRegion, type OpenBoneDocument, apply, buildSpline, regionPageRect, splinePolyline } from "@openbone/core";
import { type ClipRegion, type DrawItem, type Skeleton, type TextContext, drawTextBox, particleDotAlpha } from "@openbone/runtime";

/** Minimal 2D context surface (browser CanvasRenderingContext2D or @napi-rs/canvas SKRSContext2D). */
export type Ctx2D = CanvasRenderingContext2D;

export interface ImageSource {
  width: number;
  height: number;
}
export type ImageResolver = (id: string) => CanvasImageSource | ImageSource | null | undefined;

export interface CanvasRenderOptions {
  /** Artboard → canvas transform (pan/zoom). Default: identity in artboard pixels. */
  view?: { x: number; y: number; zoom: number };
  bones?: boolean;
  /** Draw path attachments (curve, anchors and handles). Defaults to `bones`. */
  paths?: boolean;
  boundingBoxes?: boolean;
  wireframe?: boolean;
  selectedBone?: string | null;
  background?: string | null;
  clear?: boolean;
}

const css = (c: number[]) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

/** Gradient stops approximating the WebGL particle sprite falloff. */
const DOT_STOPS = [0, 0.35, 0.5, 0.65, 0.8, 0.9, 1];

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  additive: "lighter",
  multiply: "multiply",
  screen: "screen",
};

/**
 * Canvas2D renderer. Draws textured triangles via per-triangle affine maps, solid shapes as paths.
 * Used by the editor viewport fallback, MCP/CLI headless previews and environments without WebGL.
 */
export class CanvasRenderer {
  constructor(
    public ctx: Ctx2D,
    public images: ImageResolver,
  ) {}

  /** Set ctx transform so skeleton space (y-up, origin at doc origin) maps to canvas pixels. */
  private setView(doc: OpenBoneDocument, view = { x: 0, y: 0, zoom: 1 }) {
    const z = view.zoom;
    this.ctx.setTransform(z, 0, 0, -z, view.x + doc.originX * z, view.y + doc.originY * z);
  }

  render(sk: Skeleton, opts: CanvasRenderOptions = {}) {
    const { ctx } = this;
    const doc = sk.doc;
    const view = opts.view ?? { x: 0, y: 0, zoom: 1 };
    if (opts.clear !== false) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const bg = opts.background === undefined ? doc.background : opts.background;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(view.x, view.y, doc.width * view.zoom, doc.height * view.zoom);
      }
    }
    this.setView(doc, view);
    let clip: ClipRegion | undefined;
    for (const item of sk.drawList()) {
      if (item.clip !== clip) {
        if (clip) ctx.restore();
        clip = item.clip;
        if (clip) {
          // Clip to the mask outline until the next item with a different (or no) mask.
          ctx.save();
          ctx.beginPath();
          const p = clip.polygon;
          for (let i = 0; i < p.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, p[i], p[i + 1]);
          ctx.closePath();
          ctx.clip();
        }
      }
      this.drawItem(item, opts.wireframe ?? false, view.zoom);
    }
    if (clip) ctx.restore();
    if (opts.boundingBoxes) this.drawBoundingBoxes(sk, view.zoom);
    if (opts.paths ?? opts.bones) this.drawPaths(sk, view.zoom);
    if (opts.bones) this.drawBones(sk, view.zoom, opts.selectedBone ?? null);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawItem(it: DrawItem, wireframe: boolean, zoom: number) {
    const { ctx } = this;
    ctx.globalCompositeOperation = BLEND[it.blend] ?? "source-over";
    if (it.particles) return this.drawParticles(it);
    const v = it.vertices;
    const idx = it.indices;
    if (it.text) {
      // Text: draw in the box frame (y down), mapped onto the box by its world matrix.
      const m = it.text.matrix;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.transform(m.a, m.c, m.b, m.d, m.x, m.y);
      ctx.scale(1, -1);
      drawTextBox(ctx as unknown as TextContext, it.text, it.color);
      ctx.restore();
    } else if (!it.image) {
      // Solid shape: fill the outline polygon (indices only needed by GPU renderers).
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i < v.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, v[i], v[i + 1]);
      ctx.closePath();
      ctx.fillStyle = css(it.color);
      ctx.fill();
      if (it.stroke) {
        ctx.strokeStyle = css(it.stroke.color);
        ctx.lineWidth = it.stroke.width;
        ctx.stroke();
      }
    } else {
      // Packed images sample their atlas page; uvs are already in page space.
      const tex = it.texture ?? it.image;
      const img = this.images(tex.id) as CanvasImageSource | null;
      ctx.globalAlpha = it.color[3];
      const iw = tex.width;
      const ih = tex.height;
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 2;
        const i1 = idx[t + 1] * 2;
        const i2 = idx[t + 2] * 2;
        const x0 = v[i0], y0 = v[i0 + 1], x1 = v[i1], y1 = v[i1 + 1], x2 = v[i2], y2 = v[i2 + 1];
        if (!img) {
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.closePath();
          ctx.fillStyle = "rgba(200,120,255,0.35)";
          ctx.fill();
          continue;
        }
        const u0 = it.uvs[i0] * iw, w0 = it.uvs[i0 + 1] * ih;
        const u1 = it.uvs[i1] * iw, w1 = it.uvs[i1 + 1] * ih;
        const u2 = it.uvs[i2] * iw, w2 = it.uvs[i2 + 1] * ih;
        // Affine map from image (u,v) to world (x,y).
        const det = (u1 - u0) * (w2 - w0) - (u2 - u0) * (w1 - w0);
        if (Math.abs(det) < 1e-9) continue;
        const a = ((x1 - x0) * (w2 - w0) - (x2 - x0) * (w1 - w0)) / det;
        const b = ((y1 - y0) * (w2 - w0) - (y2 - y0) * (w1 - w0)) / det;
        const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
        const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
        const e = x0 - a * u0 - c * w0;
        const f = y0 - b * u0 - d * w0;
        ctx.save();
        // Slightly expand the clip triangle around its centroid to hide seams.
        const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
        const grow = 0.6 / zoom;
        const ex = (x: number, y: number): [number, number] => {
          const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
          return [x + (dx / l) * grow, y + (dy / l) * grow];
        };
        ctx.beginPath();
        ctx.moveTo(...ex(x0, y0));
        ctx.lineTo(...ex(x1, y1));
        ctx.lineTo(...ex(x2, y2));
        ctx.closePath();
        ctx.clip();
        ctx.transform(a, b, c, d, e, f);
        // A packed image draws only its own rect of the page (not its neighbours or edge padding).
        const tr = it.textureRect;
        if (tr) ctx.drawImage(img, tr.x, tr.y, tr.width, tr.height, tr.x, tr.y, tr.width, tr.height);
        else ctx.drawImage(img, 0, 0);
        ctx.restore();
      }
      if (it.color[0] < 1 || it.color[1] < 1 || it.color[2] < 1) {
        // Approximate tint by multiplying a colour fill over the geometry.
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = 1;
        ctx.fillStyle = css([it.color[0], it.color[1], it.color[2], 1]);
        ctx.beginPath();
        for (let t = 0; t < idx.length; t += 3)
          for (let k = 0; k < 3; k++) {
            const p = idx[t + k] * 2;
            (k ? ctx.lineTo : ctx.moveTo).call(ctx, v[p], v[p + 1]);
          }
        ctx.fill();
        ctx.restore();
      }
    }
    if (wireframe) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(0,200,255,0.8)";
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      for (let t = 0; t < idx.length; t += 3) {
        const p = [idx[t] * 2, idx[t + 1] * 2, idx[t + 2] * 2];
        ctx.moveTo(v[p[0]], v[p[0] + 1]);
        ctx.lineTo(v[p[1]], v[p[1] + 1]);
        ctx.lineTo(v[p[2]], v[p[2] + 1]);
        ctx.closePath();
      }
      ctx.stroke();
    }
  }

  /**
   * Particle batch: each quad (TL, TR, BR, BL) maps the unit square, so a soft dot, a solid square or the image
   * is drawn into it with the quad's colour. Images are tinted by alpha only.
   */
  private drawParticles(it: DrawItem) {
    const { ctx } = this;
    const v = it.vertices;
    const cols = it.colors;
    const look = it.particles!.look;
    const tex = look === "image" ? (it.texture ?? it.image) : null;
    const img = tex ? (this.images(tex.id) as CanvasImageSource | null) : null;
    if (look === "image" && !img) return;
    const tr = it.textureRect;
    for (let q = 0; q < it.particles!.count; q++) {
      const o = q * 8;
      const c = q * 16;
      const r = cols ? cols[c] : it.color[0];
      const g = cols ? cols[c + 1] : it.color[1];
      const b = cols ? cols[c + 2] : it.color[2];
      const a = cols ? cols[c + 3] : it.color[3];
      if (a <= 0) continue;
      ctx.save();
      // Unit square → quad: origin TL, u axis TL→TR, v axis TL→BL.
      ctx.transform(v[o + 2] - v[o], v[o + 3] - v[o + 1], v[o + 6] - v[o], v[o + 7] - v[o + 1], v[o], v[o + 1]);
      if (look === "image") {
        ctx.globalAlpha = a;
        if (tr) ctx.drawImage(img!, tr.x, tr.y, tr.width, tr.height, 0, 0, 1, 1);
        else ctx.drawImage(img!, 0, 0, 1, 1);
      } else if (look === "square") {
        ctx.globalAlpha = 1;
        ctx.fillStyle = css([r, g, b, a]);
        ctx.fillRect(0, 0, 1, 1);
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = this.dotGradient(r, g, b, a);
        ctx.fillRect(0, 0, 1, 1);
      }
      ctx.restore();
    }
  }

  private dotGradient(r: number, g: number, b: number, a: number): CanvasGradient {
    const grad = this.ctx.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5);
    for (const s of DOT_STOPS) grad.addColorStop(s, css([r, g, b, a * particleDotAlpha(s)]));
    return grad;
  }

  drawBoundingBoxes(sk: Skeleton, zoom: number) {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,180,0,0.9)";
    ctx.setLineDash([4 / zoom, 3 / zoom]);
    ctx.lineWidth = 1.5 / zoom;
    for (const slot of sk.slots) {
      const atts = [sk.doc.skeleton.skins[0], sk.skin].flatMap((k) => Object.values(k?.attachments[slot.data.id] ?? {}));
      const hasBox = atts.some((a) => a.type === "boundingBox");
      const poly = hasBox ? sk.hitPolygon(slot) : null;
      if (!poly) continue;
      ctx.beginPath();
      for (let i = 0; i < poly.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, poly[i], poly[i + 1]);
      ctx.closePath();
      ctx.stroke();
    }
    // Clipping masks: dashed violet outline.
    ctx.strokeStyle = "rgba(190,120,255,0.95)";
    ctx.setLineDash([6 / zoom, 3 / zoom]);
    for (const slot of sk.slots) {
      const att = sk.getAttachment(slot);
      if (att?.type !== "clipping") continue;
      const poly = sk.attachmentWorldVertices(slot, att);
      ctx.beginPath();
      for (let i = 0; i < poly.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, poly[i], poly[i + 1]);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawPaths(sk: Skeleton, zoom: number) {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const slot of sk.drawOrder) {
      const att = sk.getAttachment(slot);
      if (!att || att.type !== "path") continue;
      const v = sk.attachmentWorldVertices(slot, att);
      const line = splinePolyline(buildSpline(v, att.closed));
      ctx.strokeStyle = att.color;
      ctx.lineWidth = 2 / zoom;
      ctx.beginPath();
      for (let i = 0; i < line.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, line[i], line[i + 1]);
      ctx.stroke();
      // Handles and anchors.
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      for (let k = 0; k + 5 < v.length; k += 6) {
        ctx.moveTo(v[k], v[k + 1]);
        ctx.lineTo(v[k + 2], v[k + 3]);
        ctx.lineTo(v[k + 4], v[k + 5]);
      }
      ctx.stroke();
      ctx.fillStyle = att.color;
      const r = 3 / zoom;
      for (let k = 0; k + 5 < v.length; k += 6) {
        ctx.fillRect(v[k + 2] - r, v[k + 3] - r, r * 2, r * 2);
        for (const h of [k, k + 4]) {
          ctx.beginPath();
          ctx.arc(v[h], v[h + 1], r * 0.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  drawBones(sk: Skeleton, zoom: number, selected: string | null) {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const b of sk.bones) {
      const m = b.world;
      const len = b.data.length;
      const sel = b.data.id === selected;
      const color = sel ? "#ffcc00" : (b.data.color ?? "#8ad4ff");
      if (len > 0) {
        const w = Math.min(len * 0.12, 10 / zoom) + 2 / zoom;
        const [ex, ey] = apply(m, len, 0);
        const [ux, uy] = apply(m, len * 0.15, w);
        const [lx, ly] = apply(m, len * 0.15, -w);
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(ux, uy);
        ctx.lineTo(ex, ey);
        ctx.lineTo(lx, ly);
        ctx.closePath();
        ctx.fillStyle = sel ? "rgba(255,204,0,0.55)" : "rgba(138,212,255,0.35)";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 / zoom;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3.5 / zoom, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

/**
 * Compose one atlas page: draws each packed image into its rect (the trimmed part, when trimmed) and fills the
 * white block. `ctx` should be a fresh `page.width x page.height` canvas. Returns the images that were missing.
 */
export function drawAtlasPage(ctx: Ctx2D, atlas: AtlasData, pageId: string, images: ImageResolver): string[] {
  const missing: string[] = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  for (const r of atlas.regions) {
    if (r.page !== pageId) continue;
    const img = images(r.image) as (CanvasImageSource & ImageSource) | null | undefined;
    if (!img) {
      missing.push(r.image);
      continue;
    }
    // Source images may be stored at a different resolution than the asset size; scale the source rect.
    const kx = (img.width || r.originalWidth) / r.originalWidth;
    const ky = (img.height || r.originalHeight) / r.originalHeight;
    if (r.rotated) {
      // Stored turned 90° clockwise: image pixel (ix, iy) lands at page (x + height - iy, y + ix).
      ctx.save();
      ctx.setTransform(0, 1, -1, 0, r.x + r.height, r.y);
      ctx.drawImage(img, r.offsetX * kx, r.offsetY * ky, r.width * kx, r.height * ky, 0, 0, r.width, r.height);
      ctx.restore();
    } else ctx.drawImage(img, r.offsetX * kx, r.offsetY * ky, r.width * kx, r.height * ky, r.x, r.y, r.width, r.height);
    extrude(ctx, regionPageRect(r), Math.min(2, Math.floor(atlas.padding / 2)));
  }
  const w = atlas.white;
  if (w && w.page === pageId) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w.x, w.y, w.width, w.height);
  }
  return missing;
}

/**
 * Copy a packed rect's edge pixels `e` pixels outwards into its padding. Linear filtering at the rect's border
 * then blends with the edge colour instead of transparent padding, matching a loose texture's CLAMP_TO_EDGE.
 */
/**
 * Cut a packed image back out of its atlas page into `ctx` (sized originalWidth × originalHeight), undoing the trim
 * offset and any 90° rotation. Used to re-pack an already packed document.
 */
export function drawRegionFromPage(ctx: Ctx2D, page: CanvasImageSource, r: AtlasRegion) {
  ctx.save();
  if (r.rotated) {
    // Inverse of the packing transform: page (px, py) → image (py - y + offsetX, x + height - px + offsetY).
    ctx.setTransform(0, -1, 1, 0, r.offsetX - r.y, r.x + r.height + r.offsetY);
    ctx.drawImage(page, r.x, r.y, r.height, r.width, r.x, r.y, r.height, r.width);
  } else ctx.drawImage(page, r.x, r.y, r.width, r.height, r.offsetX, r.offsetY, r.width, r.height);
  ctx.restore();
}

function extrude(ctx: Ctx2D, r: { x: number; y: number; width: number; height: number }, e: number) {
  if (e <= 0) return;
  const W = r.width + 2 * e;
  const H = r.height + 2 * e;
  const data = ctx.getImageData(r.x - e, r.y - e, W, H);
  const p = data.data;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(Math.max(y, e), e + r.height - 1);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(Math.max(x, e), e + r.width - 1);
      if (sx === x && sy === y) continue;
      const d = (y * W + x) * 4;
      const s = (sy * W + sx) * 4;
      p[d] = p[s];
      p[d + 1] = p[s + 1];
      p[d + 2] = p[s + 2];
      p[d + 3] = p[s + 3];
    }
  }
  ctx.putImageData(data, r.x - e, r.y - e);
}
