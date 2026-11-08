import { type OpenBoneDocument, apply, buildSpline, splinePolyline } from "@openbone/core";
import type { DrawItem, Skeleton } from "@openbone/runtime";

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
    for (const item of sk.drawList()) this.drawItem(item, opts.wireframe ?? false, view.zoom);
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
    const v = it.vertices;
    const idx = it.indices;
    if (!it.image) {
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
      const img = this.images(it.image.id) as CanvasImageSource | null;
      ctx.globalAlpha = it.color[3];
      const iw = it.image.width;
      const ih = it.image.height;
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
        ctx.drawImage(img, 0, 0);
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

  drawBoundingBoxes(sk: Skeleton, zoom: number) {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255,180,0,0.9)";
    ctx.setLineDash([4 / zoom, 3 / zoom]);
    ctx.lineWidth = 1.5 / zoom;
    for (const slot of sk.slots) {
      const hasBox = Object.values(sk.doc.skeleton.skins[0].attachments[slot.data.id] ?? {}).some((a) => a.type === "boundingBox");
      const poly = hasBox ? sk.hitPolygon(slot) : null;
      if (!poly) continue;
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
